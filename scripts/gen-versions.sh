#!/usr/bin/env bash
# Regenerate versions.html from the v<NN>/ archive folders present in the repo
# root. Used both when seeding the archive by hand and by the archive-version
# GitHub Action. Newest version first; the highest number is marked LATEST and
# the root (./) always serves it.
set -euo pipefail
cd "$(dirname "$0")/.."

latest=$(ls -d v[0-9]* 2>/dev/null | sed 's#v##' | sort -rn | head -1)

{
cat <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Sacrament Time Tracker — Versions</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:#efe7db; color:#2b333d; min-height:100vh; padding:40px 18px; }
  @media (prefers-color-scheme: dark){ body{ background:#1c2027; color:#e7e2d8; } a.v{ background:#252a33; color:#e7e2d8; border-color:rgba(255,255,255,.08); } }
  .wrap { max-width:560px; margin:0 auto; }
  h1 { font-size:1.7rem; font-weight:900; letter-spacing:-.02em; margin:0 0 4px; }
  p.sub { color:#7a828c; margin:0 0 26px; font-weight:600; }
  a.latest { display:inline-block; margin-bottom:22px; font-weight:800; color:#fff;
    background:linear-gradient(180deg,#2f8f6d,#267a5c); padding:12px 20px; border-radius:12px; text-decoration:none; box-shadow:0 4px 12px rgba(47,143,109,.3); }
  ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
  a.v { display:flex; align-items:center; justify-content:space-between; text-decoration:none; color:#2b333d;
    background:#fff; border:1px solid rgba(43,51,61,.1); border-radius:12px; padding:15px 18px; font-weight:800;
    box-shadow:0 2px 8px rgba(43,51,61,.08); transition:transform .12s, box-shadow .15s; }
  a.v:hover { transform:translateY(-1px); box-shadow:0 6px 16px rgba(43,51,61,.14); }
  .tag { font-variant-numeric:tabular-nums; }
  .badge { font-size:.72rem; font-weight:800; letter-spacing:.05em; color:#2f8f6d; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>⏱️ Version history</h1>
    <p class="sub">Every released version of the Sacrament Time Tracker, kept live.</p>
    <a class="latest" href="./">Open the latest (v${latest}) →</a>
    <ul>
HTML
for v in $(ls -d v[0-9]* 2>/dev/null | sed 's#v##' | sort -rn); do
  badge=""
  [ "$v" = "$latest" ] && badge='<span class="badge">LATEST</span>'
  echo "      <li><a class=\"v\" href=\"v${v}/\"><span class=\"tag\">v${v}</span>${badge}</a></li>"
done
cat <<'HTML'
    </ul>
  </div>
</body>
</html>
HTML
} > versions.html

echo "versions.html regenerated (latest v${latest})"
