#!/bin/bash
# OpenClaw Local Memory 启动脚本

set -euo pipefail

cd "$(dirname "$0")"

PORT=${1:-37888}
TTL_DAYS=${2:-180}
DB_PATH=${3:-./agent_memory}

echo "================================================"
echo "  OpenClaw Local Memory Service"
echo "================================================"
echo ""
echo "端口: $PORT"
echo "TTL: $TTL_DAYS"
echo "数据库: $DB_PATH"
echo ""

# 依赖检查：向量与抓取是可选增强，不强制阻塞启动
python3 - <<'PY' >/dev/null 2>&1 || true
import importlib
mods = ["chromadb", "sentence_transformers", "crawl4ai"]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print(",".join(missing))
PY

python3 memory_service.py --port "$PORT" --ttl-days "$TTL_DAYS" --db-path "$DB_PATH"
