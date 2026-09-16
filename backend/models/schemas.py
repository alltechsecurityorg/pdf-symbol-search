from pydantic import BaseModel, Field
from typing import Optional


class UploadResponse(BaseModel):
    pdf_id: str
    filename: str
    page_count: int
    page_sizes: list[dict]


class CropRequest(BaseModel):
    pdf_id: str
    page: int
    x: float
    y: float
    width: float
    height: float


class CropResponse(BaseModel):
    template_id: str
    thumbnail_base64: str
    pixel_width: int
    pixel_height: int


class SymbolSearchItem(BaseModel):
    template_id: str
    symbol_name: str


class SearchRequest(BaseModel):
    pdf_id: str
    symbols: list[SymbolSearchItem]
    confidence_threshold: float = Field(default=0.60, ge=0.3, le=1.0)
    pages: Optional[list[int]] = None


class SymbolMatch(BaseModel):
    page: int
    x: float
    y: float
    width: float
    height: float
    confidence: float


class SymbolResult(BaseModel):
    template_id: str
    symbol_name: str
    matches: list[SymbolMatch]
    total_count: int


class SearchResponse(BaseModel):
    results: list[SymbolResult]
    total_matches: int
    search_time_seconds: float


class ExportRequest(BaseModel):
    pdf_id: str
    results: list[SymbolResult]
    format: str = "csv"


class AnnotationMatch(BaseModel):
    page: int
    x: float
    y: float
    width: float
    height: float


class AnnotationSymbol(BaseModel):
    name: str
    color: str
    matches: list[AnnotationMatch]


class AnnotateRequest(BaseModel):
    pdf_id: str
    symbols: list[AnnotationSymbol]


class PageInfo(BaseModel):
    page: int
    name: str


class SplitRequest(BaseModel):
    pdf_id: str
    pages: list[int]


class SplitItem(BaseModel):
    page: int
    pdf_id: str
    filename: str
    page_count: int
    page_sizes: list[dict]


class AiTarget(BaseModel):
    name: str
    thumbnail: str  # data URL


class AiCountRequest(BaseModel):
    targets: list[AiTarget] = []
    legend_pdf_id: str | None = None
