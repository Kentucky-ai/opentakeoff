"""Extract the three cited public pages without adding a source PDF to git.

Usage: python extract-landscape.py /path/to/PL-91539-097-101-200.pdf /path/to/output.pdf
Requires pypdf==6.21.4 for byte-identical output.
"""
import hashlib
from pathlib import Path
import sys
from pypdf import PdfReader, PdfWriter

source, output = map(Path, sys.argv[1:3])
assert hashlib.sha256(source.read_bytes()).hexdigest() == "2edd619988876f5927efd187fda2c08c3ede4fa19425783327e8ee13da1171cc", "Unexpected public source bytes"
reader, writer = PdfReader(source), PdfWriter()
for index in (32, 34, 35):
    writer.add_page(reader.pages[index])
writer.write(output)
assert hashlib.sha256(output.read_bytes()).hexdigest() == "482d07a4d86e4e97863b7867021a4b646647f52b14ffa25f97adf6b7524a94c1", "Extraction differs; use the pinned pypdf version"
print("Extracted printed sheets 133, 135 and 136 from PDF pages 33, 35 and 36.")
