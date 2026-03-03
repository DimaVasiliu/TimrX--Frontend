#!/usr/bin/env bash
# optimize_images.sh — Recompress hero portrait WebP assets
#
# Requirements: cwebp (brew install webp) and sips (macOS built-in)
#
# Usage:
#   cd TimrX/Frontend
#   bash tools/optimize_images.sh
#
# Input:  img/dima.jpg  (original high-res portrait)
# Output: img/dima-480.webp   (<= 70 KB)
#         img/dima-768.webp   (<= 140 KB)
#         img/dima-1024.webp  (<= 200 KB)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SRC="$ROOT/img/dima.jpg"
TMP_DIR="$(mktemp -d)"
QUALITY=68

if [ ! -f "$SRC" ]; then
  echo "ERROR: Source image not found: $SRC" >&2
  exit 1
fi

if ! command -v cwebp &>/dev/null; then
  echo "ERROR: cwebp not found. Install with: brew install webp" >&2
  exit 1
fi

# Target widths and max file sizes (KB)
declare -a WIDTHS=(480 768 1024)
declare -a MAX_KB=(70 140 200)

for i in "${!WIDTHS[@]}"; do
  W="${WIDTHS[$i]}"
  MAX="${MAX_KB[$i]}"
  RESIZED="$TMP_DIR/dima-${W}.jpg"
  OUT="$ROOT/img/dima-${W}.webp"

  echo "--- Generating dima-${W}.webp (target <= ${MAX} KB, quality ${QUALITY}) ---"

  # Resize with sips (macOS) — preserves aspect ratio by constraining width
  sips --resampleWidth "$W" "$SRC" --out "$RESIZED" >/dev/null 2>&1

  # Convert to WebP with cwebp — strip metadata, set quality
  cwebp -q "$QUALITY" -metadata none -sharp_yuv "$RESIZED" -o "$OUT" 2>/dev/null

  SIZE_KB=$(( $(stat -f%z "$OUT") / 1024 ))
  echo "    Output: ${SIZE_KB} KB"

  # If still over budget, reduce quality further
  if [ "$SIZE_KB" -gt "$MAX" ]; then
    Q=$((QUALITY - 5))
    while [ "$SIZE_KB" -gt "$MAX" ] && [ "$Q" -ge 40 ]; do
      echo "    ${SIZE_KB} KB > ${MAX} KB — retrying at quality ${Q}..."
      cwebp -q "$Q" -metadata none -sharp_yuv "$RESIZED" -o "$OUT" 2>/dev/null
      SIZE_KB=$(( $(stat -f%z "$OUT") / 1024 ))
      echo "    Output: ${SIZE_KB} KB"
      Q=$((Q - 5))
    done
  fi

  if [ "$SIZE_KB" -le "$MAX" ]; then
    echo "    OK"
  else
    echo "    WARNING: Could not reach target (${SIZE_KB} KB > ${MAX} KB)"
  fi
done

rm -rf "$TMP_DIR"
echo ""
echo "Done. Verify with: ls -lh $ROOT/img/dima-*.webp"
