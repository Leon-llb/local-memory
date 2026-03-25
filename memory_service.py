#!/usr/bin/env python3
"""
LocalMemoryService v2 - OpenClaw 本地记忆服务
改进版: 语义切块 + 去重 + TTL过期 + Re-rank

启动: python memory_service.py --port 37888
"""

import argparse
import asyncio
import hashlib
import json
import re
import time
import sys
from datetime import datetime, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from typing import Optional, List, Dict, Any

from crawl4ai import AsyncWebCrawler
from sentence_transformers import SentenceTransformer
import chromadb
import uuid


class Logger:
    """彩色日志输出"""
    COLORS = {
        "info": "\033[94m",
        "success": "\033[92m",
        "warn": "\033[93m",
        "error": "\033[91m",
        "debug": "\033[90m",
        "reset": "\033[0m"
    }
    EMOJIS = {"info": "ℹ️", "success": "✅", "warn": "⚠️", "error": "❌", "debug": "🔍"}

    @staticmethod
    def log(msg: str, level: str = "info"):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        color = Logger.COLORS.get(level, "")
        emoji = Logger.EMOJIS.get(level, "")
        reset = Logger.COLORS["reset"]
        print(f"{color}[{ts}]{reset} {emoji} {msg}", flush=True)


class SemanticChunker:
    """
    语义切块器 - 按段落/句子边界智能分割
    避免：代码被截断、句子被切成两半
    """

    def __init__(self, max_chunk_size: int = 500, overlap: int = 50):
        self.max_chunk_size = max_chunk_size
        self.overlap = overlap

    def chunk(self, text: str) -> List[str]:
        if not text or not text.strip():
            return []

        # 先按段落分割
        paragraphs = self._split_paragraphs(text)

        chunks = []
        current_chunk = ""

        for para in paragraphs:
            # 如果当前块 + 新段落不超过限制，直接合并
            if len(current_chunk) + len(para) + 2 <= self.max_chunk_size:
                current_chunk = (current_chunk + "\n\n" + para).strip()
            else:
                # 当前块满了，保存它
                if current_chunk:
                    chunks.append(current_chunk)

                # 如果新段落本身超过限制，需要进一步切分
                if len(para) > self.max_chunk_size:
                    sub_chunks = self._split_large_paragraph(para)
                    chunks.extend(sub_chunks[:-1])
                    current_chunk = sub_chunks[-1] if sub_chunks else ""
                else:
                    current_chunk = para

        # 保存最后一个块
        if current_chunk:
            chunks.append(current_chunk)

        # 添加重叠（用于检索连续性）
        if self.overlap > 0 and len(chunks) > 1:
            chunks = self._add_overlap(chunks)

        Logger.log(f"语义切块: {len(text)} 字符 → {len(chunks)} 个块", "debug")
        return chunks

    def _split_paragraphs(self, text: str) -> List[str]:
        """按双换行分割段落，保留代码块完整性"""
        # 保护代码块不被拆散
        code_blocks = []
        def save_code(match):
            code_blocks.append(match.group(0))
            return f"__CODE_BLOCK_{len(code_blocks)-1}__"

        text = re.sub(r'```[\s\S]*?```', save_code, text)

        # 按段落分割
        paragraphs = re.split(r'\n\s*\n', text)

        # 恢复代码块
        result = []
        for para in paragraphs:
            for i, block in enumerate(code_blocks):
                para = para.replace(f"__CODE_BLOCK_{i}__", block)
            if para.strip():
                result.append(para.strip())

        return result

    def _split_large_paragraph(self, para: str) -> List[str]:
        """切分过大的段落，优先在句子边界切分"""
        chunks = []
        sentences = re.split(r'([。！？.!?]\s*)', para)

        current = ""
        for i in range(0, len(sentences) - 1, 2):
            sentence = sentences[i] + (sentences[i + 1] if i + 1 < len(sentences) else "")

            if len(current) + len(sentence) <= self.max_chunk_size:
                current += sentence
            else:
                if current:
                    chunks.append(current)
                # 如果单个句子就超长，强制按字符切
                if len(sentence) > self.max_chunk_size:
                    for j in range(0, len(sentence), self.max_chunk_size):
                        chunks.append(sentence[j:j + self.max_chunk_size])
                    current = ""
                else:
                    current = sentence

        if current:
            chunks.append(current)

        return chunks

    def _add_overlap(self, chunks: List[str]) -> List[str]:
        """添加块之间的重叠，提高检索连续性"""
        result = []
        for i, chunk in enumerate(chunks):
            if i > 0:
                # 从前一个块的末尾取 overlap 字符
                prev_tail = chunks[i - 1][-self.overlap:]
                chunk = prev_tail + " " + chunk
            result.append(chunk)
        return result


class DedupManager:
    """
    去重管理器 - 基于 URL/内容 hash 防止重复入库
    """

    @staticmethod
    def compute_url_hash(url: str) -> str:
        return hashlib.md5(url.encode()).hexdigest()[:16]

    @staticmethod
    def compute_content_hash(content: str) -> str:
        # 标准化后再 hash：去除空白、转小写
        normalized = re.sub(r'\s+', '', content.lower())
        return hashlib.sha256(normalized.encode()).hexdigest()[:16]

    @staticmethod
    def check_exists(collection, url_hash: str = None, content_hash: str = None) -> Dict[str, Any]:
        """检查是否已存在"""
        filters = []
        if url_hash:
            filters.append({"url_hash": url_hash})
        if content_hash:
            filters.append({"content_hash": content_hash})

        if not filters:
            return {"exists": False}

        # ChromaDB 的 where 条件
        for f in filters:
            try:
                result = collection.get(where=f, limit=1)
                if result["ids"]:
                    return {
                        "exists": True,
                        "id": result["ids"][0],
                        "metadata": result["metadatas"][0] if result["metadatas"] else {}
                    }
            except:
                pass

        return {"exists": False}


class ReRanker:
    """
    重排序器 - 对检索结果进行二次排序
    策略：向量相似度 + 关键词匹配 + 时效性
    """

    def __init__(self, keyword_weight: float = 0.3, recency_weight: float = 0.1):
        self.keyword_weight = keyword_weight
        self.recency_weight = recency_weight

    def rerank(self, query: str, results: List[Dict], top_k: int = None) -> List[Dict]:
        if not results:
            return results

        query_terms = set(self._tokenize(query))

        for r in results:
            # 1. 基础向量相似度分数 (0-1)
            vector_score = r.get("score", 0.5)

            # 2. 关键词匹配分数
            content = r.get("content", "")
            content_terms = set(self._tokenize(content))
            keyword_score = len(query_terms & content_terms) / max(len(query_terms), 1)

            # 3. 时效性分数 (越新越高)
            recency_score = 0.5
            metadata = r.get("metadata", {})
            if "ingested_at" in metadata:
                try:
                    ingested = datetime.fromisoformat(metadata["ingested_at"])
                    days_old = (datetime.now() - ingested).days
                    recency_score = max(0, 1 - days_old / 365)  # 一年后归零
                except:
                    pass

            # 综合分数
            r["rerank_score"] = (
                vector_score * (1 - self.keyword_weight - self.recency_weight) +
                keyword_score * self.keyword_weight +
                recency_score * self.recency_weight
            )

        # 按综合分数排序
        sorted_results = sorted(results, key=lambda x: x["rerank_score"], reverse=True)

        if top_k:
            sorted_results = sorted_results[:top_k]

        return sorted_results

    def _tokenize(self, text: str) -> List[str]:
        """简单分词：支持中英文"""
        # 英文单词
        tokens = re.findall(r'[a-zA-Z]+', text.lower())
        # 中文字符（按字）
        tokens += re.findall(r'[\u4e00-\u9fff]', text)
        return tokens


class LocalMemoryEngine:
    """核心记忆引擎 v2"""

    def __init__(self, db_path: str = "./agent_memory", ttl_days: int = 90):
        Logger.log("🚀 初始化本地记忆引擎 v2...")

        self.ttl_days = ttl_days
        self.chunker = SemanticChunker(max_chunk_size=500, overlap=50)
        self.dedup = DedupManager()
        self.reranker = ReRanker()

        # 加载模型
        Logger.log("📦 [1/2] 加载 SentenceTransformer 模型 (BAAI/bge-small-zh-v1.5)...")
        try:
            start = time.time()
            self.encoder = SentenceTransformer('BAAI/bge-small-zh-v1.5')
            Logger.log(f"✅ 模型加载成功 ({time.time()-start:.2f}s)", "success")
        except Exception as e:
            Logger.log(f"模型加载失败: {e}", "error")
            raise

        # 连接数据库
        Logger.log(f"🗄️ [2/2] 初始化 ChromaDB ({db_path})...")
        try:
            start = time.time()
            self.db_client = chromadb.PersistentClient(path=db_path)
            self.collection = self.db_client.get_or_create_collection(
                name="agent_core_memory",
                metadata={"hnsw:space": "cosine"}
            )
            count = self.collection.count()
            Logger.log(f"✅ 数据库就绪 (已有 {count} 条记录, {time.time()-start:.2f}s)", "success")
        except Exception as e:
            Logger.log(f"数据库初始化失败: {e}", "error")
            raise

        # 启动时清理过期记忆
        self._cleanup_expired()

        Logger.log("🎉 记忆引擎 v2 初始化完成!", "success")

    async def ingest_url(self, url: str, source_name: str, force: bool = False) -> dict:
        """从 URL 抓取内容并入库（支持去重）"""
        Logger.log(f"🌐 抓取: {url}")

        # 去重检查
        url_hash = self.dedup.compute_url_hash(url)
        if not force:
            existing = self.dedup.check_exists(self.collection, url_hash=url_hash)
            if existing["exists"]:
                Logger.log(f"⏭️ URL 已存在，跳过入库: {url}", "warn")
                return {
                    "success": True,
                    "skipped": True,
                    "reason": "URL已存在",
                    "existing_id": existing["id"]
                }

        try:
            # 抓取网页
            start = time.time()
            async with AsyncWebCrawler() as crawler:
                result = await crawler.arun(url=url)

            if not result.success:
                return {"success": False, "error": result.error_message}

            content = result.markdown or ""
            if not content:
                return {"success": False, "error": "内容为空"}

            Logger.log(f"   抓取成功 ({len(content)} 字符, {time.time()-start:.2f}s)")

            # 入库
            return self._ingest_content(
                content=content,
                source_name=source_name,
                metadata={"url": url, "url_hash": url_hash},
                force=force
            )

        except Exception as e:
            Logger.log(f"入库失败: {e}", "error")
            return {"success": False, "error": str(e)}

    def ingest_text(self, text: str, source_name: str, metadata: dict = None, force: bool = False) -> dict:
        """直接入库文本内容（支持去重）"""
        if not text or not text.strip():
            return {"success": False, "error": "文本为空"}

        content_hash = self.dedup.compute_content_hash(text)
        if not force:
            existing = self.dedup.check_exists(self.collection, content_hash=content_hash)
            if existing["exists"]:
                Logger.log(f"⏭️ 内容已存在，跳过入库", "warn")
                return {
                    "success": True,
                    "skipped": True,
                    "reason": "内容已存在"
                }

        return self._ingest_content(
            content=text,
            source_name=source_name,
            metadata={**(metadata or {}), "content_hash": content_hash},
            force=force
        )

    def _ingest_content(self, content: str, source_name: str, metadata: dict = None, force: bool = False) -> dict:
        """内部入库逻辑"""
        Logger.log(f"📝 入库: {source_name} ({len(content)} 字符)")

        # 语义切块
        chunks = self.chunker.chunk(content)
        if not chunks:
            return {"success": False, "error": "切分失败"}

        # 向量化
        Logger.log(f"🔮 向量化 {len(chunks)} 个块...")
        start = time.time()
        embeddings = self.encoder.encode(chunks, show_progress_bar=False).tolist()

        # 构建元数据
        now = datetime.now().isoformat()
        expire_at = (datetime.now() + timedelta(days=self.ttl_days)).isoformat()

        ids = []
        metadatas = []
        for i, chunk in enumerate(chunks):
            chunk_hash = hashlib.md5(chunk.encode()).hexdigest()[:8]
            ids.append(f"{source_name}-{chunk_hash}-{uuid.uuid4().hex[:8]}")
            metadatas.append({
                "source": source_name,
                "chunk_index": i,
                "total_chunks": len(chunks),
                "ingested_at": now,
                "expire_at": expire_at,
                **(metadata or {})
            })

        # 存储
        Logger.log(f"💾 写入数据库...")
        self.collection.add(
            embeddings=embeddings,
            documents=chunks,
            metadatas=metadatas,
            ids=ids
        )

        Logger.log(f"✅ 入库完成: {len(chunks)} 条 ({time.time()-start:.2f}s)", "success")
        return {
            "success": True,
            "chunks_stored": len(chunks),
            "source": source_name
        }

    def recall(self, query: str, top_k: int = 5, use_rerank: bool = True) -> dict:
        """检索相关记忆（支持重排序）"""
        Logger.log(f"🔍 检索: \"{query}\" (top_k={top_k}, rerank={use_rerank})")

        if not query or not query.strip():
            return {"success": False, "error": "查询为空", "results": []}

        try:
            start = time.time()

            # 向量检索（多取一些，给 rerank 留空间）
            fetch_k = top_k * 3 if use_rerank else top_k
            query_vector = self.encoder.encode([query], show_progress_bar=False).tolist()

            results = self.collection.query(
                query_embeddings=query_vector,
                n_results=fetch_k,
                include=["documents", "metadatas", "distances"]
            )

            docs = results.get('documents', [[]])[0]
            metas = results.get('metadatas', [[]])[0]
            distances = results.get('distances', [[]])[0]

            formatted = []
            for doc, meta, dist in zip(docs, metas, distances):
                formatted.append({
                    "content": doc,
                    "metadata": meta,
                    "score": float(1 - dist)  # 转换为相似度
                })

            # 重排序
            if use_rerank and formatted:
                formatted = self.reranker.rerank(query, formatted, top_k=top_k)
                Logger.log(f"   Re-rank 完成", "debug")

            # 截断到 top_k
            formatted = formatted[:top_k]

            Logger.log(f"✅ 检索完成: {len(formatted)} 条 ({time.time()-start:.2f}s)", "success")
            return {"success": True, "results": formatted, "query": query}

        except Exception as e:
            Logger.log(f"检索失败: {e}", "error")
            return {"success": False, "error": str(e), "results": []}

    def _cleanup_expired(self) -> int:
        """清理过期记忆"""
        if self.ttl_days <= 0:
            return 0

        Logger.log(f"🧹 检查过期记忆 (TTL: {self.ttl_days} 天)...")

        try:
            now = datetime.now().isoformat()
            # 获取所有过期的记录
            expired = self.collection.get(
                where={"expire_at": {"$lt": now}},
                include=["metadatas"]
            )

            if expired["ids"]:
                self.collection.delete(ids=expired["ids"])
                Logger.log(f"   清理了 {len(expired['ids'])} 条过期记忆", "success")
                return len(expired["ids"])

            Logger.log(f"   无过期记忆", "debug")
            return 0

        except Exception as e:
            Logger.log(f"   清理失败: {e}", "warn")
            return 0

    def cleanup(self, source: str = None, before: str = None) -> dict:
        """手动清理记忆"""
        Logger.log(f"🧹 手动清理: source={source}, before={before}")

        try:
            conditions = []
            if source:
                conditions.append({"source": source})
            if before:
                conditions.append({"ingested_at": {"$lt": before}})

            if not conditions:
                return {"success": False, "error": "请指定 source 或 before 参数"}

            # ChromaDB 的 $and 语法
            where_filter = {"$and": conditions} if len(conditions) > 1 else conditions[0]

            to_delete = self.collection.get(where=where_filter, include=[])

            if to_delete["ids"]:
                self.collection.delete(ids=to_delete["ids"])
                Logger.log(f"✅ 清理了 {len(to_delete['ids'])} 条记忆", "success")
                return {"success": True, "deleted_count": len(to_delete["ids"])}
            else:
                return {"success": True, "deleted_count": 0, "message": "没有匹配的记录"}

        except Exception as e:
            Logger.log(f"清理失败: {e}", "error")
            return {"success": False, "error": str(e)}

    def stats(self) -> dict:
        """获取统计信息"""
        try:
            total = self.collection.count()

            # 获取所有来源
            sources = {}
            try:
                all_records = self.collection.get(include=["metadatas"])
                for meta in all_records.get("metadatas", []):
                    src = meta.get("source", "unknown")
                    sources[src] = sources.get(src, 0) + 1
            except:
                pass

            return {
                "success": True,
                "total_chunks": total,
                "unique_sources": len(sources),
                "sources": sources,
                "ttl_days": self.ttl_days
            }
        except Exception as e:
            return {"success": True, "total_chunks": 0, "error": str(e)}


# 全局引擎实例
engine: Optional[LocalMemoryEngine] = None


class RequestHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理器"""

    def log_message(self, format, *args):
        pass

    def _send_json(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length == 0:
                return {}
            body = self.rfile.read(length)
            return json.loads(body.decode("utf-8"))
        except:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/health":
            self._send_json({"status": "ok", "service": "local-memory", "version": "2.0"})

        elif path == "/stats":
            self._send_json(engine.stats())

        elif path == "/recall":
            query = params.get("query", [""])[0]
            top_k = int(params.get("top_k", ["5"])[0])
            use_rerank = params.get("rerank", ["true"])[0].lower() != "false"
            self._send_json(engine.recall(query, top_k, use_rerank))

        elif path == "/cleanup":
            source = params.get("source", [None])[0]
            before = params.get("before", [None])[0]
            self._send_json(engine.cleanup(source, before))

        else:
            self._send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/ingest/url":
            url = body.get("url")
            source = body.get("source_name", url)
            force = body.get("force", False)
            if not url:
                self._send_json({"success": False, "error": "缺少 url 参数"}, 400)
                return
            result = asyncio.run(engine.ingest_url(url, source, force))
            self._send_json(result)

        elif path == "/ingest/text":
            text = body.get("text")
            source = body.get("source_name", "unknown")
            metadata = body.get("metadata", {})
            force = body.get("force", False)
            if not text:
                self._send_json({"success": False, "error": "缺少 text 参数"}, 400)
                return
            result = engine.ingest_text(text, source, metadata, force)
            self._send_json(result)

        elif path == "/recall":
            query = body.get("query", "")
            top_k = body.get("top_k", 5)
            use_rerank = body.get("rerank", True)
            self._send_json(engine.recall(query, top_k, use_rerank))

        elif path == "/cleanup":
            source = body.get("source")
            before = body.get("before")
            self._send_json(engine.cleanup(source, before))

        else:
            self._send_json({"error": "Not found"}, 404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/cleanup":
            source = params.get("source", [None])[0]
            before = params.get("before", [None])[0]
            self._send_json(engine.cleanup(source, before))
        else:
            self._send_json({"error": "Not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


def main():
    parser = argparse.ArgumentParser(description="LocalMemoryService v2")
    parser.add_argument("--port", type=int, default=37888, help="服务端口")
    parser.add_argument("--db-path", type=str, default="./agent_memory", help="数据库路径")
    parser.add_argument("--ttl-days", type=int, default=90, help="记忆过期天数 (0=永不过期)")
    args = parser.parse_args()

    global engine
    engine = LocalMemoryEngine(db_path=args.db_path, ttl_days=args.ttl_days)

    server = HTTPServer(("127.0.0.1", args.port), RequestHandler)

    Logger.log(f"🚀 服务启动: http://127.0.0.1:{args.port}", "success")
    Logger.log(f"   GET  /health           - 健康检查")
    Logger.log(f"   GET  /stats            - 统计信息")
    Logger.log(f"   GET  /recall?query=xx  - 检索记忆")
    Logger.log(f"   GET  /cleanup?source=xx - 清理记忆")
    Logger.log(f"   POST /ingest/url       - 入库网页")
    Logger.log(f"   POST /ingest/text      - 入库文本")
    Logger.log(f"   POST /recall           - 检索记忆 (POST)")
    Logger.log(f"   DELETE /cleanup        - 清理记忆")
    Logger.log(f"")
    Logger.log(f"   TTL: {args.ttl_days} 天")
    Logger.log(f"")
    Logger.log("按 Ctrl+C 停止服务")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        Logger.log("\n👋 服务已停止")
        server.shutdown()


if __name__ == "__main__":
    main()
