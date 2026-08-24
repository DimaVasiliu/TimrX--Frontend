#!/bin/bash
# ---------------------------------------------------------------------------
# TimrX 45s short — local preview launcher (macOS: double-click to run).
#
# Why this exists: the ad pulls your real assets (img/, vid/, fonts/, js/) with
# relative paths, and Chrome blocks ES modules over file:// — which kills the
# 3D viewer. Serving the folder over http:// fixes both.
#
# Keep this file in the SAME folder as timrx-short-45.html
# (…/3_TimrX_Frontend/TimrX--Frontend/). Close the Terminal window to stop.
# ---------------------------------------------------------------------------
cd "$(dirname "$0")" || exit 1
PORT=8123

if [ ! -f timrx-short-45.html ]; then
  echo "timrx-short-45.html is not in $(pwd) — move both files into the TimrX Frontend folder."
  read -r -p "Press return to close."
  exit 1
fi

echo "Serving $(pwd)"
echo "Ad:  http://localhost:$PORT/timrx-short-45.html"
echo "Clean capture (no controls):  http://localhost:$PORT/timrx-short-45.html?ui=0"
echo
echo "Press Ctrl-C to stop."

( sleep 1; open "http://localhost:$PORT/timrx-short-45.html" ) &
python3 -m http.server "$PORT"
