from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from bs4 import BeautifulSoup
from pypdf import PdfReader


DOWNLOADS_DIR = Path(__file__).resolve().parents[1] / "docs" / "downloads"
OUT_MD = Path(__file__).resolve().parents[1] / "docs" / "downloads_extracted.md"


KEYWORDS = [
    # Traffic loading / burial
    "traffic",
    "truck",
    "wheel",
    "load",
    "external",
    "buried",
    "cover",
    "depth",
    "surface",
    "pavement",
    "road",
    # Break-rate studies / materials
    "break rate",
    "failure rate",
    "breaks",
    "diameter",
    "pipe size",
    "size range",
    "12 inches",
    "12 inch",
    "16 inches",
    "16 inch",
    "50 years",
    "over 50",
    "cohort",
    "cast iron",
    "c.i.",
    "asbestos",
    "ac pipe",
    "ductile",
    "steel",
    "pvc",
    "polyethylene",
    # PCCP vintage
    "pccp",
    "prestressed",
    "cylinder pipe",
    "class iv",
    "interpace",
    "1972",
    "1978",
    "1970",
    "1980",
]


def _norm_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _iter_keywords() -> Iterable[str]:
    # longest first helps avoid tiny matches dominating
    return sorted({k.lower() for k in KEYWORDS}, key=len, reverse=True)


@dataclass
class Snippet:
    keyword: str
    text: str


def extract_pdf_snippets(path: Path, max_pages_scan: int | None = None, max_snippets: int = 18) -> list[Snippet]:
    reader = PdfReader(str(path))
    snippets: list[Snippet] = []

    keywords = list(_iter_keywords())
    page_count = len(reader.pages)
    pages_to_scan = page_count if max_pages_scan is None else min(page_count, max_pages_scan)

    for page_index in range(pages_to_scan):
        page = reader.pages[page_index]
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""

        if not text:
            continue

        compact = _norm_ws(text)
        lower = compact.lower()

        for kw in keywords:
            hit = lower.find(kw)
            if hit == -1:
                continue

            start = max(0, hit - 180)
            end = min(len(compact), hit + len(kw) + 240)
            excerpt = compact[start:end].strip()

            # add page marker so we can follow up
            excerpt = f"(p.{page_index + 1}) {excerpt}"
            snippets.append(Snippet(keyword=kw, text=excerpt))

            if len(snippets) >= max_snippets:
                return snippets

    return snippets


def extract_html_snippets(path: Path, max_snippets: int = 18) -> list[Snippet]:
    raw = path.read_text(encoding="utf-8", errors="ignore")
    soup = BeautifulSoup(raw, "lxml")

    # remove common noise
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    text = _norm_ws(soup.get_text(" "))
    lower = text.lower()

    snippets: list[Snippet] = []
    for kw in _iter_keywords():
        start = 0
        while True:
            hit = lower.find(kw, start)
            if hit == -1:
                break
            s = max(0, hit - 180)
            e = min(len(text), hit + len(kw) + 240)
            excerpt = text[s:e].strip()
            snippets.append(Snippet(keyword=kw, text=excerpt))
            if len(snippets) >= max_snippets:
                return snippets
            start = hit + len(kw)

    return snippets


def main() -> None:
    if not DOWNLOADS_DIR.exists():
        raise SystemExit(f"Missing downloads dir: {DOWNLOADS_DIR}")

    files = sorted([p for p in DOWNLOADS_DIR.iterdir() if p.is_file()], key=lambda p: p.name.lower())

    lines: list[str] = []
    lines.append("# Extracted snippets from docs/downloads")
    lines.append("")
    lines.append("Generated: 2026-01-01")
    lines.append("")
    lines.append("Notes:")
    lines.append("- This file is produced automatically to speed up source review.")
    lines.append("- Snippets are keyword-based and may miss table-only evidence in PDFs.")
    lines.append("")

    for path in files:
        suffix = path.suffix.lower()
        lines.append(f"## {path.name}")
        lines.append("")

        try:
            if suffix == ".pdf":
                # scan all pages, but only collect limited snippets
                snippets = extract_pdf_snippets(path, max_pages_scan=None, max_snippets=20)
            elif suffix in (".html", ".htm"):
                snippets = extract_html_snippets(path, max_snippets=20)
            else:
                snippets = []

            if not snippets:
                lines.append("No keyword snippets found (or extraction failed).")
                lines.append("")
                continue

            # de-dupe near-identical excerpts
            seen: set[str] = set()
            for snip in snippets:
                key = (snip.keyword + "|" + snip.text).lower()
                if key in seen:
                    continue
                seen.add(key)
                lines.append(f"- **{snip.keyword}** — {snip.text}")

            lines.append("")

        except Exception as exc:
            lines.append(f"Extraction error: {exc}")
            lines.append("")

    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
