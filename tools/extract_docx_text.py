from __future__ import annotations

import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path


def extract_docx_text(docx_path: Path) -> str:
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

    with zipfile.ZipFile(docx_path) as z:
        xml_bytes = z.read("word/document.xml")

    root = ET.fromstring(xml_bytes)
    paras: list[str] = []
    for p in root.findall(".//w:p", ns):
        texts = [t.text for t in p.findall(".//w:t", ns) if t.text]
        if not texts:
            continue
        line = "".join(texts).strip()
        if line:
            paras.append(line)

    return "\n".join(paras)


def main() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    docx_path = repo_root / "docs" / "Pipe_Risk_Assessment_Water_Mains_North_America.docx"
    out_path = repo_root / "docs" / "Pipe_Risk_Assessment_Water_Mains_North_America.txt"

    text = extract_docx_text(docx_path)
    out_path.write_text(text, encoding="utf-8")
    print(f"Wrote {out_path} ({len(text)} chars)")


if __name__ == "__main__":
    main()
