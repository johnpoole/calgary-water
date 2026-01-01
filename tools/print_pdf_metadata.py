from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader


def main() -> None:
    root = Path(__file__).resolve().parents[1] / "docs" / "downloads"
    names = [
        "20331243.pdf",
        "10354626.pdf",
        "1212 tech 1.pdf",
        "study-caen-ipex-water-main-break-rates-in-the-usa-and-canada.pdf",
        "water-main-break-rates-in-the-usa-and-canada-a-comprehensive-study-march-2018.pdf",
        "Water Main Break Rates In the USA and Canada_ A Comprehensive Stu.pdf",
    ]

    for name in names:
        path = root / name
        if not path.exists():
            continue

        reader = PdfReader(str(path))
        md = reader.metadata or {}

        print(f"=== {path.name} ===")
        print(f"pages: {len(reader.pages)}")
        for k in ["/Title", "/Author", "/Subject", "/Creator", "/Producer"]:
            v = md.get(k)
            if not v:
                continue
            s = str(v).replace("\n", " ").strip()
            print(f"{k}: {s[:240]}")
        print("")


if __name__ == "__main__":
    main()
