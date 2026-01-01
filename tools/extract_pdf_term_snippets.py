from __future__ import annotations

import argparse
import re
from pathlib import Path

from pypdf import PdfReader


def norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=str)
    ap.add_argument("--term", action="append", dest="terms", default=[])
    ap.add_argument("--max-pages", type=int, default=2000)
    ap.add_argument("--max-hits", type=int, default=60)
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    if not pdf_path.exists():
        raise SystemExit(f"Missing PDF: {pdf_path}")

    terms = [t.lower() for t in args.terms if t.strip()]
    if not terms:
        raise SystemExit("Provide at least one --term")

    reader = PdfReader(str(pdf_path))
    hits = 0

    print(f"PDF: {pdf_path}")
    print(f"Pages: {len(reader.pages)}")
    print(f"Terms: {terms}\n")

    for i, page in enumerate(reader.pages[: min(len(reader.pages), args.max_pages)]):
        try:
            text = page.extract_text() or ""
        except Exception:
            continue

        if not text:
            continue

        compact = norm_ws(text)
        low = compact.lower()

        for term in terms:
            pos = low.find(term)
            if pos == -1:
                continue

            s = max(0, pos - 220)
            e = min(len(compact), pos + len(term) + 320)
            excerpt = compact[s:e].strip()
            print(f"- (p.{i + 1}) **{term}** — {excerpt}")
            hits += 1
            if hits >= args.max_hits:
                return


if __name__ == "__main__":
    main()
