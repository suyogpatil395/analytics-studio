"""Inline src/*.js into demo/index.html -> analytics-studio-demo.html (one file, works offline anywhere)."""
import re, pathlib
root = pathlib.Path(__file__).parent
html = (root / "demo/index.html").read_text()
def inline(m):
    return "<script>\n" + (root / m.group(1).replace("../", "")).read_text() + "\n</script>"
out = re.sub(r'<script src="(\.\./src/[^"]+)"></script>', inline, html)
(root / "analytics-studio-demo.html").write_text(out)
print("wrote analytics-studio-demo.html", len(out), "bytes")
