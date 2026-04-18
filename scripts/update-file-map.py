#!/usr/bin/env python3
"""
update-file-map.py — file-map.md にアラートを追加するスクリプト

git pull 後に実行する。file-map.md 本体の既存エントリは上書きしない。
- 未登録ファイル → 仮エントリ + ⚠️ Added アラート
- 既登録で変更あり → ⚠️ Modified アラート行を追加

Usage:
    python3 scripts/update-file-map.py [--since YYYY-MM-DD] [--dry-run]

--since を省略すると、file-map.md 内の最新 updated 日付以降の変更を検出する。
"""

import argparse
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FILE_MAP = REPO_ROOT / "docs" / "file-map.md"

# file-map.md で追跡対象とするディレクトリ
TRACKED_DIRS = [
    "docs/specs/",
    "docs/design/",
    "docs/knowledge/",
    "experiments/",
    "app/",
    "lib/",
]

# file-map.md 自身やスクリプト等は除外
EXCLUDE_PATTERNS = [
    "docs/file-map.md",
    "scripts/",
    ".github/",
    "node_modules/",
    "package",
    ".env",
    ".gitignore",
    "README",
    "tsconfig",
    "next.config",
    "tailwind",
    "postcss",
    "components.json",
]

# 拡張子による除外（データファイル等）
EXCLUDE_EXTENSIONS = [
    ".json",
    ".jsonl",
    ".csv",
    ".png",
    ".jpg",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".lock",
]

# ディレクトリ単位で除外（実験出力・スナップショット等）
EXCLUDE_DIRS = [
    "experiments/spec-29/output/",
    "experiments/spec-29/snapshots/",
    "experiments/spec-29/state/",
    "experiments/spec-29/questions/",
]


def get_tracked_paths() -> dict[str, int]:
    """file-map.md から既存の → パス を抽出し、行番号を返す"""
    if not FILE_MAP.exists():
        return {}
    
    paths = {}
    lines = FILE_MAP.read_text().splitlines()
    for i, line in enumerate(lines):
        m = re.match(r'^→ `(.+?)`', line)
        if m:
            paths[m.group(1)] = i
    return paths


def get_latest_updated() -> str:
    """file-map.md 内の最新 updated 日付を取得"""
    if not FILE_MAP.exists():
        return "2026-01-01"
    
    dates = []
    for line in FILE_MAP.read_text().splitlines():
        m = re.match(r'^updated:\s*(\d{4}-\d{2}-\d{2})', line)
        if m:
            dates.append(m.group(1))
    
    return max(dates) if dates else "2026-01-01"


def get_git_changes(since: str) -> dict[str, str]:
    """git log から変更ファイルと種別(A/M)を取得"""
    result = subprocess.run(
        ["git", "log", f"--since={since}", "--name-status", "--pretty=format:", "--diff-filter=AM"],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    
    changes = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split('\t', 1)
        if len(parts) == 2:
            status, path = parts
            # 最新のステータスを保持（A > M）
            if path not in changes or status == 'A':
                changes[path] = status
    
    return changes


def is_tracked(path: str) -> bool:
    """追跡対象ディレクトリのファイルか判定"""
    for d in TRACKED_DIRS:
        if path.startswith(d):
            return True
    return False


def is_excluded(path: str) -> bool:
    """除外パターンに該当するか判定"""
    for p in EXCLUDE_PATTERNS:
        if p in path:
            return True
    for ext in EXCLUDE_EXTENSIONS:
        if path.endswith(ext):
            return True
    for d in EXCLUDE_DIRS:
        if path.startswith(d):
            return True
    return False


def get_commit_date(path: str) -> str:
    """ファイルの最新コミット日付を取得"""
    result = subprocess.run(
        ["git", "log", "-1", "--format=%cs", "--", path],
        capture_output=True, text=True, cwd=REPO_ROOT
    )
    return result.stdout.strip() or datetime.now().strftime("%Y-%m-%d")


def apply_alerts(changes: dict[str, str], tracked_paths: dict[str, int], dry_run: bool = False):
    """file-map.md にアラートを追加"""
    lines = FILE_MAP.read_text().splitlines()
    
    modified_alerts = []  # (line_index, alert_text)
    new_entries = []  # 新規エントリテキスト
    
    for path, status in sorted(changes.items()):
        if not is_tracked(path) or is_excluded(path):
            continue
        
        commit_date = get_commit_date(path)
        
        if path in tracked_paths:
            # 既登録 → Modified アラート
            entry_line_idx = tracked_paths[path]
            
            # 既にアラートがあるか確認（→行の後ろを探索）
            alert_exists = False
            for j in range(entry_line_idx + 1, min(entry_line_idx + 5, len(lines))):
                if lines[j].startswith('⚠️'):
                    alert_exists = True
                    break
                if lines[j].startswith('##') or lines[j].startswith('→'):
                    break
            
            if not alert_exists:
                # updated行の後にアラートを挿入
                insert_idx = entry_line_idx + 1
                for j in range(entry_line_idx + 1, min(entry_line_idx + 4, len(lines))):
                    if lines[j].startswith('概要:'):
                        insert_idx = j + 1
                        break
                    insert_idx = j + 1
                
                modified_alerts.append((insert_idx, f"⚠️ Modified: {commit_date} — updated日付・概要の確認が必要"))
        else:
            # 未登録 → 新規エントリ
            new_entries.append(
                f"\n## （新規検出）\n"
                f"→ `{path}`\n"
                f"⚠️ Added: {commit_date} — 見出し・タグ・概要を追加してください"
            )
    
    if not modified_alerts and not new_entries:
        print("✅ アラートなし。file-map.md は最新です。")
        return
    
    # Modified アラートを挿入（後ろから挿入して行番号がズレないようにする）
    for idx, alert in sorted(modified_alerts, reverse=True):
        lines.insert(idx, alert)
    
    # 新規エントリを末尾（最後の --- の前、またはファイル末尾）に追加
    # "## 主要ルート" セクションの前に挿入
    insert_pos = len(lines)
    for i, line in enumerate(lines):
        if line.startswith('## 主要ルート') or line.startswith('## 主要ライブラリ'):
            insert_pos = i
            break
    
    for entry in new_entries:
        for j, eline in enumerate(entry.split('\n')):
            lines.insert(insert_pos + j, eline)
        insert_pos += len(entry.split('\n'))
    
    result = '\n'.join(lines) + '\n'
    
    if dry_run:
        print("=== DRY RUN ===")
        print(f"Modified alerts: {len(modified_alerts)}")
        print(f"New entries: {len(new_entries)}")
        for idx, alert in sorted(modified_alerts):
            print(f"  L{idx}: {alert}")
        for entry in new_entries:
            print(entry)
    else:
        FILE_MAP.write_text(result)
        print(f"✅ file-map.md 更新: {len(modified_alerts)} modified alerts, {len(new_entries)} new entries")


def main():
    parser = argparse.ArgumentParser(description="file-map.md アラート更新")
    parser.add_argument("--since", help="検出開始日 (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true", help="変更せずに結果を表示")
    args = parser.parse_args()
    
    since = args.since or get_latest_updated()
    print(f"📋 Checking changes since {since}...")
    
    tracked_paths = get_tracked_paths()
    print(f"📁 Tracked paths in file-map.md: {len(tracked_paths)}")
    
    changes = get_git_changes(since)
    print(f"📝 Git changes found: {len(changes)}")
    
    apply_alerts(changes, tracked_paths, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
