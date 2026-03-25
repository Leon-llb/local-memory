#!/bin/bash
# LocalMemory 启动脚本

cd "$(dirname "$0")"

PORT=${1:-37888}

echo "================================================"
echo "  LocalMemory Service for OpenClaw"
echo "================================================"
echo ""
echo "端口: $PORT"
echo "数据库: ./agent_memory"
echo ""

# 检查依赖
if ! python3 -c "import crawl4ai" 2>/dev/null; then
    echo "⚠️  缺少依赖，正在安装..."
    pip install crawl4ai sentence-transformers chromadb
fi

# 启动服务
python3 memory_service.py --port $PORT --db-path ./agent_memory
