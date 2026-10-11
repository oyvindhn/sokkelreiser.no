#!/usr/bin/env python3
"""Bygger Offshorekart til én selvstendig index.html i public/.

    python3 build.py              -> public/ (klar for opplasting til ProISP)
    python3 build.py --artifact   -> build/artifact.html (forhåndsvisning uten <html>-skjelett)
"""
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
OUT = ROOT / "public"


def read(name):
    return (SRC / name).read_text(encoding="utf-8")


def parts(favicon=True):
    base = json.loads((ROOT / "data" / "basemap.json").read_text(encoding="utf-8"))
    basemap = "window.BASEMAP=" + json.dumps(base, separators=(",", ":")) + ";"
    icon = '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n' if favicon else ""
    head = f"""<title>Offshorekart</title>
<meta name="description" content="Finn tilbake til hvor du har vært offshore. Reiselogg fra MinDaVinci, posisjoner fra Sodir. Alt skjer i nettleseren.">
<meta name="theme-color" content="#0e1c26">
{icon}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
{read("style.css")}
</style>"""
    scripts = f"""<script>/* Kystlinjer: Natural Earth (public domain) */{basemap}</script>
<script>
{read("core.js")}
</script>
<script>
{read("ui.js")}
</script>"""
    return head, read("body.html"), scripts


def build_site():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    head, body, scripts = parts()
    html = f"""<!doctype html>
<html lang="no">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
{head}
</head>
<body>
{body}
{scripts}
</body>
</html>
"""
    (OUT / "index.html").write_text(html, encoding="utf-8")
    for f in (ROOT / "static").iterdir():
        if f.is_file():
            shutil.copy2(f, OUT / f.name)
    print(f"public/index.html  {len(html.encode()) / 1024:.0f} kB")


def build_artifact():
    head, body, scripts = parts(favicon=False)
    out = ROOT / "build"
    out.mkdir(exist_ok=True)
    (out / "artifact.html").write_text(head + "\n" + body + "\n" + scripts + "\n", encoding="utf-8")
    print("build/artifact.html")


if __name__ == "__main__":
    build_artifact() if "--artifact" in sys.argv else build_site()
