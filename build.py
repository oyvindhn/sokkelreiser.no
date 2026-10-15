#!/usr/bin/env python3
"""Bygger Sokkelreiser til én selvstendig index.html i public/.

    python3 build.py              -> public/ (klar for opplasting til ProISP)
    python3 build.py --artifact   -> build/artifact.html (forhåndsvisning uten <html>-skjelett)
"""
import json
import os
import subprocess
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
    flot = json.loads((ROOT / "data" / "floteller.json").read_text(encoding="utf-8"))
    rn = json.loads((ROOT / "data" / "riggnavn.json").read_text(encoding="utf-8"))
    basemap += "window.RIGGNAVN=" + json.dumps(rn, ensure_ascii=False, separators=(",", ":")) + ";"
    basemap += "window.FLOTELLER=" + json.dumps(flot, ensure_ascii=False, separators=(",", ":")) + ";"
    icon = '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n' if favicon else ""
    head = f"""<title>Sokkelreiser – kart og reiselogg for offshorereiser på norsk sokkel</title>
<meta name="description" content="Gratis verktøy for å se tilbake på egne reiser til installasjoner på norsk sokkel. Last inn din egen reiselogg, så vises stedene på et kart. Alt skjer i nettleseren, uten pålogging og uten opplasting.">
<meta name="application-name" content="Sokkelreiser">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://sokkelreiser.no/">
<meta property="og:site_name" content="Sokkelreiser">
<meta property="og:title" content="Sokkelreiser – kart og reiselogg for offshorereiser">
<meta property="og:description" content="Se tilbake på egne reiser til installasjoner på norsk sokkel. Alt skjer i nettleseren, uten pålogging og uten opplasting.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://sokkelreiser.no/">
<meta property="og:locale" content="nb_NO">
<script type="application/ld+json">{{"@context":"https://schema.org","@type":"WebApplication","name":"Sokkelreiser","url":"https://sokkelreiser.no/","description":"Gratis personlig verktøy som viser egne reiser til installasjoner på norsk sokkel på et kart. Data behandles lokalt i nettleseren.","applicationCategory":"TravelApplication","operatingSystem":"Any","inLanguage":"nb","isAccessibleForFree":true,"offers":{{"@type":"Offer","price":"0","priceCurrency":"NOK"}}}}</script>
<meta name="theme-color" content="#0e1c26">
<script>/* valgt tema før første tegning, så siden ikke blinker */try{{var t=JSON.parse(localStorage.getItem("sokkelreise:theme"));if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}}catch(e){{}}</script>
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
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
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
        elif f.is_dir():
            shutil.copytree(f, OUT / f.name, ignore=shutil.ignore_patterns("config.php"))
    shutil.copy2(ROOT / "data" / "koder.json", OUT / "koder.json")
    shutil.copy2(ROOT / "data" / "floteller.json", OUT / "floteller.json")
    # versjon.txt: brukes til å kontrollere at publiseringen faktisk havnet der domenet peker
    sha = os.environ.get("GITHUB_SHA") or subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    (OUT / "versjon.txt").write_text((sha or "lokal") + "\n", encoding="utf-8")
    print(f"public/index.html  {len(html.encode()) / 1024:.0f} kB")


def build_artifact():
    head, body, scripts = parts(favicon=False)
    out = ROOT / "build"
    out.mkdir(exist_ok=True)
    (out / "artifact.html").write_text(head + "\n" + body + "\n" + scripts + "\n", encoding="utf-8")
    print("build/artifact.html")


if __name__ == "__main__":
    build_artifact() if "--artifact" in sys.argv else build_site()
