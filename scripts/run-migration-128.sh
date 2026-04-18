#!/bin/bash
# #128 マイグレーション実行スクリプト
# .env.local の SUPABASE_SERVICE_ROLE_KEY を使って Supabase に SQL を適用する

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SQL_FILE="$REPO_ROOT/supabase/migrations/20260404000001_partner_rules_souls_columns.sql"

# .env.local 読み込み
ENV_FILE="$REPO_ROOT/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env.local not found at $ENV_FILE"
  exit 1
fi

# 環境変数を読み込む
set -a
source "$ENV_FILE"
set +a

SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
  echo "ERROR: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set in .env.local"
  exit 1
fi

echo "Running migration: $SQL_FILE"
echo "Target: $SUPABASE_URL"

SQL_CONTENT=$(cat "$SQL_FILE")

# Supabase REST API 経由で SQL 実行
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  "${SUPABASE_URL}/rest/v1/rpc/exec_sql" \
  -H "apikey: ${SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"sql\": $(echo "$SQL_CONTENT" | jq -Rs .)}")

# Supabase pg_dump 経由も試みる (exec_sql がない場合)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "exec_sql failed (HTTP $HTTP_CODE). Trying pg endpoint..."
  
  # Supabase Management API / SQL endpoint を試みる
  RESPONSE2=$(curl -s -w "\n%{http_code}" \
    -X POST \
    "${SUPABASE_URL}/pg/query" \
    -H "apikey: ${SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"query\": $(echo "$SQL_CONTENT" | jq -Rs .)}")
  
  HTTP_CODE2=$(echo "$RESPONSE2" | tail -1)
  BODY2=$(echo "$RESPONSE2" | head -n -1)
  
  if [ "$HTTP_CODE2" != "200" ]; then
    echo "Both endpoints failed."
    echo "HTTP $HTTP_CODE: $BODY"
    echo "HTTP $HTTP_CODE2: $BODY2"
    echo ""
    echo "Please run the SQL manually in Supabase Dashboard > SQL Editor:"
    echo "$SQL_FILE"
    exit 1
  fi
  
  echo "Success via pg endpoint:"
  echo "$BODY2"
else
  echo "Success:"
  echo "$BODY"
fi

echo ""
echo "Migration complete."
