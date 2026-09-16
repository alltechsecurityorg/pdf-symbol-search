import { useCallback, useEffect, useRef, useState } from 'react';
import OpenSeadragon from 'openseadragon';
import { useAppStore } from '../store/appStore';
import { cropSymbol, prepareTiles, getTilesStatus, tileSourceUrl, type TilesStatus } from '../api/client';
import { PRESET_COLORS } from './SymbolCard';

// Tiles are rendered at meta.scale x 72 DPI, so image px = PDF pt * scale.
interface Meta { width_pt: number; height_pt: number; scale: number; width_px: number; height_px: number }
interface Drag { x0: number; y0: number; x1: number; y1: number }

export function SheetViewer() {
  const sitePdf = useAppStore((s) => s.sitePdf);
  const symbols = useAppStore((s) => s.symbols);
  const isCropMode = useAppStore((s) => s.isCropMode);
  const setIsCropMode = useAppStore((s) => s.setIsCropMode);
  const manualModeSymbolId = useAppStore((s) => s.manualModeSymbolId);
  const setManualModeSymbolId = useAppStore((s) => s.setManualModeSymbolId);
  const addSymbol = useAppStore((s) => s.addSymbol);
  const addManualMatch = useAppStore((s) => s.addManualMatch);
  const removeMatch = useAppStore((s) => s.removeMatch);
  const undo = useAppStore((s) => s.undo);
  const undoStack = useAppStore((s) => s.undoStack);
  const focusMatch = useAppStore((s) => s.focusMatch);
  const hideBackground = useAppStore((s) => s.hideBackground);
  const setHideBackground = useAppStore((s) => s.setHideBackground);
  const drawingScale = useAppStore((s) => s.drawingScale);
  const setDrawingScale = useAppStore((s) => s.setDrawingScale);
  const setPdfLoading = useAppStore((s) => s.setPdfLoading);
  const setPdfLoadingMessage = useAppStore((s) => s.setPdfLoadingMessage);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);

  const hostRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const metaRef = useRef<Meta | null>(null);
  const [ready, setReady] = useState(false);
  const [nobgAvailable, setNobgAvailable] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const pdfId = sitePdf?.pdfId ?? null;
  const modeActive = isCropMode || !!manualModeSymbolId;

  // Hold Space to pan temporarily; releasing returns to whatever tool was active (smart select by default).
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const typing = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e.target)) { e.preventDefault(); setSpaceHeld(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') setSpaceHeld(false); };
    const blur = () => setSpaceHeld(false);
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);
  useEffect(() => { if (spaceHeld) setDrag(null); }, [spaceHeld]);
  const panning = spaceHeld || !modeActive;

  // Wheel zoom must work in every tool: while the capture layer owns the mouse (smart select /
  // manual mark) forward the wheel to the viewer as a zoom about the cursor.
  useEffect(() => {
    const el = captureRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const v = viewerRef.current;
      if (!v) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const at = v.viewport.pointFromPixel(new OpenSeadragon.Point(e.clientX - r.left, e.clientY - r.top));
      const factor = Math.min(1.5, Math.max(1 / 1.5, Math.pow(1.25, -e.deltaY / 100)));
      v.viewport.zoomBy(factor, at);
      v.viewport.applyConstraints();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready]);

  // ---- coordinate helpers (viewer element px <-> PDF pt) ----
  const elToPt = useCallback((ex: number, ey: number) => {
    const v = viewerRef.current, m = metaRef.current;
    if (!v || !m) return { x: 0, y: 0 };
    const ip = v.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(ex, ey));
    return { x: ip.x / m.scale, y: ip.y / m.scale };
  }, []);
  const ptToEl = useCallback((x: number, y: number) => {
    const v = viewerRef.current, m = metaRef.current;
    if (!v || !m) return { x: 0, y: 0 };
    const p = v.viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(x * m.scale, y * m.scale));
    return { x: p.x, y: p.y };
  }, []);

  // ---- overlay drawing ----
  // Matches are shown by recolouring the drawing's own linework. For each match we build a tint
  // mask (solid item colour with a thin dark edge, anti-aliased) at a resolution bucket chosen from
  // the current zoom: 6 px/pt comes straight from the native tiles; 12/24/48 px/pt are re-rasterised
  // by the server for that small region, so edges stay smooth however far you zoom in.
  const BUCKETS = [6, 12, 24, 48];
  const PAD_PT = 0.6;
  type MaskEntry = { canvas: HTMLCanvasElement; pad: number; z: number };
  const tileCache = useRef(new Map<string, HTMLImageElement | 'loading'>());
  const maskCache = useRef(new Map<string, Map<number, MaskEntry | 'pending'>>());
  const rafRef = useRef<number | null>(null);

  const tileUrl = useCallback((level: number, col: number, row: number) =>
    `/api/tilefiles/${pdfId}/base/image_files/${level}/${col}_${row}.png`, [pdfId]);

  // grayscale (max) dilation, separable
  const dilate = (src: Float32Array, w: number, h: number, r: number) => {
    if (r <= 0) return src;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { const v = src[y * w + k]; if (v > m) m = v; } tmp[y * w + x] = m; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { const v = tmp[k * w + x]; if (v > m) m = v; } out[y * w + x] = m; }
    return out;
  };
  // turn rendered linework into: item-colour fill (slightly thickened) + thin dark edge, both soft
  const tint = (g: CanvasRenderingContext2D, w: number, h: number, color: string, z: number) => {
    const img = g.getImageData(0, 0, w, h), d = img.data;
    const ink = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) { const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; ink[p] = Math.min(1, Math.max(0, (190 - lum) / 100)); }
    const rFill = Math.round(z / 6), rRing = rFill + Math.max(1, Math.round(z / 10));
    const fill = dilate(ink, w, h, rFill), ring = dilate(ink, w, h, rRing);
    const n = parseInt(color.slice(1), 16), cr = (n >> 16) & 255, cg = (n >> 8) & 255, cb = n & 255;
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const f = fill[p], rg = ring[p];
      if (rg < 0.02) { d[i + 3] = 0; continue; }
      d[i] = Math.round(30 + (cr - 30) * f); d[i + 1] = Math.round(30 + (cg - 30) * f); d[i + 2] = Math.round(30 + (cb - 30) * f); d[i + 3] = Math.round(255 * rg);
    }
    g.putImageData(img, 0, 0);
  };

  const buildMask = useCallback(async (key: string, m: { x: number; y: number; width: number; height: number }, color: string, z: number) => {
    const meta = metaRef.current; if (!meta || !pdfId) return;
    const sc = document.createElement('canvas');
    if (z <= 6) {
      // from native tiles (no extra requests)
      const S = meta.scale, PADPX = Math.round(PAD_PT * S);
      const maxLevel = Math.ceil(Math.log2(Math.max(meta.width_px, meta.height_px)));
      const x0 = Math.max(0, Math.floor(m.x * S) - PADPX), y0 = Math.max(0, Math.floor(m.y * S) - PADPX);
      const x1 = Math.min(meta.width_px, Math.ceil((m.x + m.width) * S) + PADPX), y1 = Math.min(meta.height_px, Math.ceil((m.y + m.height) * S) + PADPX);
      const w = x1 - x0, h = y1 - y0; if (w <= 0 || h <= 0 || w * h > 1024 * 1024) return;
      const T = 256, imgs: { img: HTMLImageElement; dx: number; dy: number }[] = []; const loads: Promise<void>[] = [];
      for (let c = Math.floor(x0 / T); c <= Math.floor((x1 - 1) / T); c++) for (let r = Math.floor(y0 / T); r <= Math.floor((y1 - 1) / T); r++) {
        const url = tileUrl(maxLevel, c, r); const t = tileCache.current.get(url);
        if (!t || t === 'loading') { loads.push(new Promise<void>((res) => { const im = new Image(); im.onload = () => { tileCache.current.set(url, im); res(); }; im.onerror = () => res(); im.src = url; tileCache.current.set(url, 'loading'); imgs.push({ img: im, dx: c * T - x0, dy: r * T - y0 }); })); }
        else imgs.push({ img: t, dx: c * T - x0, dy: r * T - y0 });
      }
      await Promise.all(loads);
      sc.width = w; sc.height = h; const g = sc.getContext('2d', { willReadFrequently: true }); if (!g) return;
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
      for (const t of imgs) if (t.img.complete && t.img.naturalWidth) g.drawImage(t.img, t.dx, t.dy);
      tint(g, w, h, color, S);
      maskCache.current.get(key)?.set(z, { canvas: sc, pad: PADPX / S, z });
    } else {
      // re-rasterised by the server at z px/pt for this region
      const url = `/api/pdf/${pdfId}/clip?x=${m.x}&y=${m.y}&w=${m.width}&h=${m.height}&z=${z}&pad=${PAD_PT}`;
      const im = await new Promise<HTMLImageElement | null>((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = url; });
      if (!im) { maskCache.current.get(key)?.delete(z); return; }
      sc.width = im.naturalWidth; sc.height = im.naturalHeight; const g = sc.getContext('2d', { willReadFrequently: true }); if (!g) return;
      g.drawImage(im, 0, 0);
      tint(g, sc.width, sc.height, color, z);
      maskCache.current.get(key)?.set(z, { canvas: sc, pad: PAD_PT, z });
    }
  }, [tileUrl, pdfId]);

  const draw = useCallback(() => {
    const canvas = overlayRef.current, host = hostRef.current, v = viewerRef.current, meta = metaRef.current;
    if (!canvas || !host || !v || !meta) return;
    const pdr = window.devicePixelRatio || 1;
    const w = host.clientWidth, h = host.clientHeight;
    const W = Math.round(w * pdr), H = Math.round(h * pdr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(pdr, 0, 0, pdr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

    // device pixels per PDF point -> which mask resolution we need
    const pxPerPt = (ptToEl(1, 0).x - ptToEl(0, 0).x) * pdr;
    const bucket = BUCKETS.find((b) => b >= pxPerPt) ?? 48;

    for (const s of useAppStore.getState().symbols) {
      if (!s.visible) continue;
      for (const m of s.matches) {
        if (m.page !== 1) continue;
        const a = ptToEl(m.x, m.y), b = ptToEl(m.x + m.width, m.y + m.height);
        if (b.x < -50 || b.y < -50 || a.x > w + 50 || a.y > h + 50) continue;
        const key = `${m.x.toFixed(2)},${m.y.toFixed(2)},${m.width.toFixed(2)},${m.height.toFixed(2)}:${s.color}`;
        let entries = maskCache.current.get(key);
        if (!entries) { entries = new Map(); maskCache.current.set(key, entries); }
        const e = entries.get(bucket);
        if (!e) { entries.set(bucket, 'pending'); buildMask(key, m, s.color, bucket).then(() => drawSoon()); }
        let use: MaskEntry | null = e && e !== 'pending' ? e : null;
        if (!use) {
          // use the best mask we already have while the right one is being built
          for (const cand of entries.values()) if (cand !== 'pending' && (!use || cand.z > use.z)) use = cand;
        }
        if (use) {
          const p0 = ptToEl(m.x - use.pad, m.y - use.pad), p1 = ptToEl(m.x + m.width + use.pad, m.y + m.height + use.pad);
          ctx.drawImage(use.canvas, p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
        } else {
          ctx.strokeStyle = s.color; ctx.lineWidth = 1; ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x - 1, b.y - a.y - 1);
        }
      }
    }

    const dg = dragRef.current;
    if (dg) {
      ctx.fillStyle = 'rgba(249,115,22,0.12)'; ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
      ctx.fillRect(Math.min(dg.x0, dg.x1), Math.min(dg.y0, dg.y1), Math.abs(dg.x1 - dg.x0), Math.abs(dg.y1 - dg.y0));
      ctx.strokeRect(Math.min(dg.x0, dg.x1), Math.min(dg.y0, dg.y1), Math.abs(dg.x1 - dg.x0), Math.abs(dg.y1 - dg.y0));
      ctx.setLineDash([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptToEl, buildMask]);

  const drawSoon = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => { rafRef.current = null; draw(); });
  }, [draw]);

  useEffect(() => { maskCache.current.clear(); tileCache.current.clear(); }, [pdfId]);

  useEffect(() => { dragRef.current = drag; draw(); }, [drag, draw]);
  useEffect(() => { draw(); }, [symbols, draw]);

  const updateZoomPct = useCallback(() => {
    const v = viewerRef.current, m = metaRef.current, host = hostRef.current;
    if (!v || !m || !host) return;
    // OSD zoom 1 = image width fills the viewer; screen px per pt = zoom * hostW / widthPt
    setZoomPct(Math.round(100 * v.viewport.getZoom(true) * host.clientWidth / m.width_pt));
  }, []);

  // ---- create the viewer once tiles are ready ----
  useEffect(() => {
    if (!pdfId || !hostRef.current) return;
    let cancelled = false;
    setReady(false); setNobgAvailable(false); metaRef.current = null;
    setPdfLoading(true); setPdfLoadingMessage('Preparing drawing…');
    setCurrentPage(1);

    const waitForTiles = async () => {
      let st = await prepareTiles(pdfId).catch(() => null);
      while (!cancelled && st && !st.ready) {
        setPdfLoadingMessage(st.error ? `Preparing failed: ${st.error}` : `Preparing drawing… ${st.progress}%`);
        if (st.error) return null;
        await new Promise((r) => setTimeout(r, 1200));
        st = await getTilesStatus(pdfId).catch(() => null);
      }
      return st;
    };

    let viewer: OpenSeadragon.Viewer | null = null;
    (async () => {
      const st = await waitForTiles();
      if (cancelled || !st || !st.ready || !st.meta) return;
      metaRef.current = st.meta;
      setPdfLoadingMessage('Opening drawing…');
      viewer = OpenSeadragon({
        element: hostRef.current!,
        prefixUrl: '',
        showNavigationControl: false,
        animationTime: 0.25,
        springStiffness: 9,
        zoomPerScroll: 1.25,
        zoomPerClick: 1,
        minZoomImageRatio: 0.5,
        maxZoomPixelRatio: 4,
        visibilityRatio: 0.3,
        constrainDuringPan: false,
        gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: false, flickEnabled: false },
        imageSmoothingEnabled: true,
        drawer: 'canvas',
        tileSources: tileSourceUrl(pdfId, 'base'),
      });
      viewerRef.current = viewer;
      viewer.addHandler('open', () => {
        if (cancelled) return;
        setReady(true); setPdfLoading(false); setPdfLoadingMessage('');
        setManualModeSymbolId(null); setIsCropMode(true); // smart select is the default tool
        updateZoomPct(); drawSoon();
        // the no-background variant may still be tiling; poll until it is (or isn't) available
        const pollNobg = async () => {
          let s: TilesStatus | null = st;
          while (!cancelled && s && s.nobg === null) { await new Promise((r) => setTimeout(r, 2000)); s = await getTilesStatus(pdfId).catch(() => null); }
          if (cancelled || !s || !s.nobg || !viewerRef.current) return;
          viewerRef.current.addTiledImage({ tileSource: tileSourceUrl(pdfId, 'nobg'), opacity: useAppStore.getState().hideBackground ? 1 : 0,
            success: () => { setNobgAvailable(true); applyBackground(); } });
        };
        pollNobg();
      });
      // Direct 1:1 panning: apply the drag immediately instead of OSD's eased spring, so the
      // page stays glued to the cursor with no settle/snap after release.
      viewer.addHandler('canvas-drag', (e) => {
        e.preventDefaultAction = true;
        const v = viewerRef.current; if (!v) return;
        v.viewport.panBy(v.viewport.deltaPointsFromPixels(e.delta.negate()), true);
      });
      viewer.addHandler('canvas-drag-end', () => { viewerRef.current?.viewport.applyConstraints(); });
      viewer.addHandler('update-viewport', () => { drawSoon(); updateZoomPct(); });
      viewer.addHandler('resize', () => { drawSoon(); });
      viewer.addHandler('canvas-double-click', (e) => {
        const p = elToPt(e.position.x, e.position.y);
        const syms = useAppStore.getState().symbols;
        for (const s of syms) {
          if (!s.visible) continue;
          const i = s.matches.findIndex((m) => m.page === 1 && p.x >= m.x && p.x <= m.x + m.width && p.y >= m.y && p.y <= m.y + m.height);
          if (i >= 0) { removeMatch(s.id, i); return; }
        }
      });
    })();

    return () => {
      cancelled = true;
      viewerRef.current = null;
      viewer?.destroy();
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfId]);

  // ---- Hide Background = opacity switch between the two tiled images ----
  const applyBackground = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    const hide = useAppStore.getState().hideBackground;
    const base = v.world.getItemAt(0), nobg = v.world.getItemAt(1);
    if (base && nobg) { base.setOpacity(hide ? 0 : 1); nobg.setOpacity(hide ? 1 : 0); }
  }, []);
  useEffect(() => { applyBackground(); drawSoon(); }, [hideBackground, nobgAvailable, applyBackground, drawSoon]);

  // ---- modes: pan vs box/manual ----
  useEffect(() => { viewerRef.current?.setMouseNavEnabled(panning); }, [panning, ready]);

  // ---- focus a match from the side panel ----
  useEffect(() => {
    const v = viewerRef.current, m = metaRef.current;
    if (!focusMatch || !v || !m) return;
    const pad = Math.max(focusMatch.width, focusMatch.height) * 2.5;
    const r = new OpenSeadragon.Rect((focusMatch.x - pad) * m.scale, (focusMatch.y - pad) * m.scale, (focusMatch.width + 2 * pad) * m.scale, (focusMatch.height + 2 * pad) * m.scale);
    v.viewport.fitBounds(v.viewport.imageToViewportRectangle(r));
  }, [focusMatch]);

  // ---- Ctrl+Z ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ---- box drawing / manual marking on the capture layer ----
  const elPos = (e: React.MouseEvent) => { const r = hostRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onDown = (e: React.MouseEvent) => { if (!isCropMode) return; const p = elPos(e); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); };
  const onMove = (e: React.MouseEvent) => { if (!isCropMode || !dragRef.current) return; const p = elPos(e); setDrag({ ...dragRef.current, x1: p.x, y1: p.y }); };
  const onUp = async (e: React.MouseEvent) => {
    if (isCropMode && dragRef.current && pdfId) {
      const d = dragRef.current; setDrag(null);
      const a = elToPt(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1)), b = elToPt(Math.max(d.x0, d.x1), Math.max(d.y0, d.y1));
      const x = a.x, y = a.y, width = b.x - a.x, height = b.y - a.y;
      if (width < 3 || height < 3) return;
      try {
        const r = await cropSymbol({ pdf_id: pdfId, page: 1, x, y, width, height });
        // Straight into the panel: next unused colour, placeholder name (rename inline on the card).
        const existing = useAppStore.getState().symbols;
        const used = existing.map((s) => s.color);
        const color = PRESET_COLORS.find((c) => !used.includes(c)) || PRESET_COLORS[existing.length % PRESET_COLORS.length];
        const unnamed = existing.filter((s) => /^Unnamed item( \d+)?$/.test(s.name)).length;
        addSymbol({ name: unnamed === 0 ? 'Unnamed item' : `Unnamed item ${unnamed + 1}`, color, thumbnail: r.thumbnail_base64, templateId: r.template_id, cropRegion: { page: 1, x, y, width, height } });
      } catch (err) { alert(err instanceof Error ? err.message : 'Failed to crop item'); }
    } else if (manualModeSymbolId) {
      const p = elPos(e); const pt = elToPt(p.x, p.y);
      const s = symbols.find((x) => x.id === manualModeSymbolId);
      if (s) addManualMatch(s.id, { page: 1, x: pt.x - s.cropRegion.width / 2, y: pt.y - s.cropRegion.height / 2, width: s.cropRegion.width, height: s.cropRegion.height, confidence: 1, manual: true });
    }
  };

  const zoomBy = (f: number) => viewerRef.current?.viewport.zoomBy(f);
  const fit = () => viewerRef.current?.viewport.goHome();

  return (
    <div className="flex-1 min-w-0 relative bg-[#e9eaee] select-none">
      <div ref={hostRef} className="absolute inset-0" style={{ cursor: spaceHeld ? 'grab' : 'default' }} />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {/* capture layer: only intercepts the mouse while drawing a box or marking manually */}
      <div
        ref={captureRef}
        className="absolute inset-0"
        style={{ pointerEvents: modeActive && !spaceHeld && ready ? 'auto' : 'none', cursor: isCropMode ? 'crosshair' : manualModeSymbolId ? 'cell' : 'default' }}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={() => setDrag(null)}
      />

      {/* Floating canvas tools */}
      <div className="absolute top-3 left-3 z-20 flex items-start gap-3">
        <div className="bg-[#1f2433] rounded-lg shadow-lg px-3 py-2 text-white">
          <div className="text-[13px] font-semibold mb-1.5">Hide Background</div>
          <div className="flex items-center gap-3">
            <button onClick={() => setHideBackground(!hideBackground)} disabled={ready && !nobgAvailable}
              className={`w-10 h-5 rounded-full relative transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${hideBackground ? 'bg-orange-500' : 'bg-[#3a4156]'}`}
              title={ready && !nobgAvailable ? 'This drawing has no separate background layers' : 'Hide the architectural background'}>
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${hideBackground ? 'left-5' : 'left-0.5'}`} />
            </button>
            <svg className="w-3.5 h-3.5 text-[#aab2c4]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </div>
        <div className="bg-[#1f2433] rounded-lg shadow-lg px-3 py-2 text-white">
          <div className="text-[13px] font-semibold mb-1.5">Scale</div>
          <div className="flex items-center gap-1.5 text-[14px] font-semibold">1 :
            <input type="number" min={0} value={drawingScale} onChange={(e) => setDrawingScale(Math.max(0, Number(e.target.value) || 0))}
              className="w-14 h-6 bg-[#181c28] border border-[#353b4d] rounded px-1.5 text-right text-white text-[13px] focus:outline-none focus:border-orange-500" />
          </div>
        </div>
      </div>

      <div className="absolute top-3 right-3 z-20 flex items-center gap-1 bg-[#1f2433] rounded-lg shadow-lg px-2 py-1.5 text-white text-[13px]">
        <button onClick={() => zoomBy(0.8)} className="w-7 h-7 rounded hover:bg-[#323950] cursor-pointer" title="Zoom out">−</button>
        <span className="w-12 text-center tabular-nums">{zoomPct}%</span>
        <button onClick={() => zoomBy(1.25)} className="w-7 h-7 rounded hover:bg-[#323950] cursor-pointer" title="Zoom in">+</button>
        <button onClick={fit} className="px-2 h-7 rounded hover:bg-[#323950] cursor-pointer" title="Fit">Fit</button>
        <span className="w-px h-5 bg-[#3a4156] mx-1" />
        <button onClick={undo} disabled={undoStack.length === 0} className="px-2 h-7 rounded hover:bg-[#323950] disabled:opacity-30 disabled:cursor-default cursor-pointer" title="Undo (Ctrl+Z)">Undo</button>
      </div>

      <div className="absolute left-3 top-[290px] z-20 bg-[#1f2433] rounded-lg shadow-lg p-1.5 flex flex-col gap-1.5">
        <button onClick={() => { setIsCropMode(false); setManualModeSymbolId(null); }}
          className={`w-9 h-9 rounded-md flex items-center justify-center cursor-pointer ${!modeActive ? 'bg-[#323950] text-white' : 'text-[#d5dbe6] hover:bg-[#2c3245]'}`} title="Pan">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 13v-2a1.5 1.5 0 0 1 3 0v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-5.2-3L4 13.5a1.5 1.5 0 0 1 2.4-1.8L8 13"/></svg>
        </button>
        <button onClick={() => { setManualModeSymbolId(null); setIsCropMode(!isCropMode); }} disabled={!ready}
          className={`w-9 h-9 rounded-md flex items-center justify-center cursor-pointer disabled:opacity-30 ${isCropMode ? 'bg-orange-500 text-white' : 'text-[#d5dbe6] hover:bg-[#2c3245]'}`} title="Auto-count: drag a box over an item">
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><circle cx="12" cy="12" r="3.5"/><path d="M12 7v1.5M12 15.5V17M7 12h1.5M15.5 12H17"/></svg>
        </button>
        <button onClick={() => { setIsCropMode(false); if (manualModeSymbolId) setManualModeSymbolId(null); else if (symbols.length) setManualModeSymbolId(symbols[symbols.length - 1].id); }} disabled={symbols.length === 0 || !ready}
          className={`w-9 h-9 rounded-md flex items-center justify-center cursor-pointer disabled:opacity-30 ${manualModeSymbolId ? 'bg-yellow-500 text-black' : 'text-[#d5dbe6] hover:bg-[#2c3245]'}`}
          title={symbols.length === 0 ? 'Count an item first' : manualModeSymbolId ? 'Exit manual marking' : 'Manually mark items (click on the drawing)'}>
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M12 8v8M8 12h8"/></svg>
        </button>
      </div>

    </div>
  );
}
