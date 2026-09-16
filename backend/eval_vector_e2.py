"""Measure geometry matching against Chris's hand takeoff on the E2 sheet."""
import json, sys, time, collections
from services.vector_match import template_geometry, find_instances, load_index, _hypotheses, _dedupe, LAST_DEBUG
import numpy as np

pdf_id, labels_path = sys.argv[1], sys.argv[2]
gt = json.load(open(labels_path))["labels"]
by_cls = collections.defaultdict(list)
for g in gt: by_cls[g["cls"]].append(g["box"])
t0 = time.time(); load_index(pdf_id); print(f"index loaded in {time.time()-t0:.1f}s")

def inside(m, box):
    cx, cy = m["x"] + m["width"]/2, m["y"] + m["height"]/2
    return box[0]-1 <= cx <= box[2]+1 and box[1]-1 <= cy <= box[3]+1

tot_gt = tot_tp = tot_fp = 0
for cls, boxes in sorted(by_cls.items(), key=lambda kv: -len(kv[1])):
    x0, y0, x1, y1 = boxes[0]
    geom = template_geometry(pdf_id, x0-0.5, y0-0.5, (x1-x0)+1, (y1-y0)+1)
    t = time.time(); m = find_instances(pdf_id, geom); dt = time.time()-t
    tp = sum(1 for b in boxes if any(inside(mm, b) for mm in m))
    fp = sum(1 for mm in m if not any(inside(mm, b) for b in boxes))
    tot_gt += len(boxes); tot_tp += tp; tot_fp += fp
    print(f"{cls:16s} segs={len(geom['seg']):3d}  GT={len(boxes):2d}  found={len(m):3d}  TP={tp:2d}  FP={fp:2d}  {dt:.1f}s")
    d = LAST_DEBUG; print(f"{'':16s} tpl={d['n_tpl']} block={d['n_core']} attr={d['n_attr']}")
    if cls in ("smoke_detector","keypad","data_double","data_single","card_reader","reed_switch"):
        for b in boxes:
            c = [cc for cc in d["cands"] if b[0]-1 <= (cc["x0"]+cc["x1"])/2 <= b[2]+1 and b[1]-1 <= (cc["y0"]+cc["y1"])/2 <= b[3]+1]
            print(f"{'':16s} GT {b[0]:7.1f},{b[1]:7.1f}: " + (f"core={c[0]['core']} attr={c[0]['attr']} extra={c[0]['extra']} imiss={c[0].get('imiss')} -> {c[0]['gate']}" if c else "no core hit"))
        fps = [cc for cc in d["cands"] if cc["gate"]=="ok" and not any(b[0]-1 <= (cc["x0"]+cc["x1"])/2 <= b[2]+1 and b[1]-1 <= (cc["y0"]+cc["y1"])/2 <= b[3]+1 for b in boxes)]
        for cc in fps[:6]: print(f"{'':16s} FP {cc['x0']:7.1f},{cc['y0']:7.1f}: core={cc['core']} attr={cc['attr']} extra={cc['extra']} imiss={cc.get('imiss')}")
    missed = [b for b in boxes if not any(inside(mm, b) for mm in m)]
    if missed and False:
        idx = load_index(pdf_id); T = np.asarray(geom["seg"], dtype=np.float64).reshape(-1, 4)
        h, _, _w = _hypotheses(idx, T, 0.3); h, _, _w = _dedupe(h)
        best = []
        for b in missed:
            sc = max([hh[0] for hh in h if b[0]-1 <= (hh[1]+hh[3])/2 <= b[2]+1 and b[1]-1 <= (hh[2]+hh[4])/2 <= b[3]+1], default=0.0)
            best.append(f"{sc:.2f}")
        print(f"{'':16s} missed best-scores: {' '.join(best)}")
print(f"\nTOTAL recall {tot_tp}/{tot_gt} = {100*tot_tp/tot_gt:.0f}%   false positives {tot_fp}")
