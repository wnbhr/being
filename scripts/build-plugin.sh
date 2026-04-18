#!/usr/bin/env bash
# build-plugin.sh — ruddia-being-plugin のビルドスクリプト
# being-mcp-server/ をビルドして ruddia-being-plugin/servers/being-mcp/ に配置する
#
# 使い方:
#   bash scripts/build-plugin.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/being-mcp-server"
OUT_DIR="$REPO_ROOT/ruddia-being-plugin/servers/being-mcp"

echo "=== Build: being-mcp-server ==="

# 1. being-mcp-server のビルド
cd "$SRC_DIR"
npm install --silent
if npm run build; then
  echo "Build succeeded."
else
  if [ -d "$SRC_DIR/dist" ]; then
    echo "Build failed but dist/ exists — using existing dist."
  else
    echo "Build failed and no dist/ found. Aborting." >&2
    exit 1
  fi
fi

echo "=== Copy: dist/ -> ruddia-being-plugin/servers/being-mcp/ ==="

# 2. 出力先を初期化
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# 3. ビルド済み JS をコピー
cp -r "$SRC_DIR/dist/." "$OUT_DIR/"

# 4. package.json（dependencies のみ）をコピー
node -e "
const pkg = require('$SRC_DIR/package.json');
const slim = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: pkg.type,
  main: 'index.js',
  dependencies: pkg.dependencies || {}
};
require('fs').writeFileSync('$OUT_DIR/package.json', JSON.stringify(slim, null, 2) + '\n');
"

echo "=== Done ==="
echo "Output: $OUT_DIR"
echo ""
echo "Next: cd ruddia-being-plugin/servers/being-mcp && npm install"
