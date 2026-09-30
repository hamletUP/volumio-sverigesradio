#!/bin/sh
# Builds dist/sverigesradio-<version>.zip: the plugin with production dependencies,
# files at the zip root (the layout Volumio's plugin manager expects).
set -e

cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
STAGE=$(mktemp -d)
OUT="dist/sverigesradio-$VERSION.zip"

cp -R index.js lib i18n UIConfig.json config.json package.json package-lock.json \
  install.sh uninstall.sh sr.svg LICENSE README.md "$STAGE"/
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund --silent)

mkdir -p dist
rm -f "$OUT"
(cd "$STAGE" && zip -qr - .) > "$OUT"
rm -rf "$STAGE"

echo "Built $OUT"
