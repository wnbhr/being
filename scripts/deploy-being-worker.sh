#!/usr/bin/env bash
# deploy-being-worker.sh — being-worker を Being Worker VPS にデプロイ
#
# フロー:
#   1. sync-lib.sh で lib/ を最新化
#   2. tsc でローカルビルド（dist/ 生成）
#   3. rsync で Being Worker VPS に転送（dist/ 含む）
#   4. リモートで npm install + restart
#
# 使い方:
#   bash scripts/deploy-being-worker.sh
#   bash scripts/deploy-being-worker.sh --host 192.168.1.100 --key ~/.ssh/mykey
#
# オプション:
#   --host HOST   SSH接続先ホスト（デフォルト: 133.88.116.107 (Being Worker VPS)）
#   --key  PATH   SSH秘密鍵のパス（デフォルト: ~/.ssh/being-worker）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

SSH_HOST="${SSH_HOST:-133.88.116.107}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/being-worker}"
SSH_USER="ubuntu"
REMOTE_DIR="/home/ubuntu/being-worker"

# 引数パース
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) SSH_HOST="$2"; shift 2 ;;
    --key)  SSH_KEY="$2";  shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "🚀 deploy-being-worker.sh: $SSH_USER@$SSH_HOST"
echo ""

# 1. sync-lib.sh
echo "📦 Step 1: sync-lib.sh"
bash "$SCRIPT_DIR/sync-lib.sh"
echo ""

# 2. tsc ビルド（being-worker）— dist/ を生成してrsyncで送る
echo "🔨 Step 2: tsc ビルド"
cd "$ROOT/being-worker"
npx tsc
echo "  ✓ ビルド完了"
cd "$ROOT"
echo ""

# 3. rsync（dist/ 含む）
echo "📤 Step 3: rsync → $SSH_HOST"
rsync -az --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '*.log' \
  -e "ssh -i $SSH_KEY" \
  "$ROOT/being-worker/" \
  "$SSH_USER@$SSH_HOST:$REMOTE_DIR/"
echo "  ✓ rsync 完了"
echo ""

# 4. リモートで npm install + systemd restart
echo "🔄 Step 4: リモート npm install + systemd restart"
ssh -i "$SSH_KEY" "$SSH_USER@$SSH_HOST" "
  cd $REMOTE_DIR &&
  npm install --production --ignore-scripts 2>&1 | tail -5 &&
  systemctl --user restart being-worker &&
  sleep 2 &&
  curl -sf http://localhost:3100/health | head -c 200 &&
  echo '' &&
  echo 'restart完了'
"
echo ""

echo "✅ デプロイ完了 → $SSH_USER@$SSH_HOST:$REMOTE_DIR"
