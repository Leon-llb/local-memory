#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import sqlite3
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from html import escape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

try:
    from sentence_transformers import SentenceTransformer
except Exception:
    SentenceTransformer = None

try:
    from crawl4ai import AsyncWebCrawler
except Exception:
    AsyncWebCrawler = None


VERSION = "3.0"
DEFAULT_ROUTE = "auto"
LAYER_ORDER = [
    "user_preference",
    "project_knowledge",
    "summary",
    "session_episode",
    "archive",
]
VISIBLE_SCOPES = {"private", "project", "global"}
DEFAULT_LAYER_VISIBILITY = {
    "user_preference": "global",
    "project_knowledge": "project",
    "summary": "project",
    "session_episode": "private",
    "archive": "project",
}
ROUTE_CONFIG = {
    "lean": {
        "char_budget": 1200,
        "min_score": 0.24,
        "layer_limits": {
            "user_preference": 260,
            "project_knowledge": 420,
            "summary": 240,
            "session_episode": 150,
            "archive": 130,
        },
    },
    "balanced": {
        "char_budget": 2400,
        "min_score": 0.18,
        "layer_limits": {
            "user_preference": 380,
            "project_knowledge": 780,
            "summary": 460,
            "session_episode": 420,
            "archive": 260,
        },
    },
    "deep": {
        "char_budget": 4200,
        "min_score": 0.12,
        "layer_limits": {
            "user_preference": 520,
            "project_knowledge": 1500,
            "summary": 820,
            "session_episode": 820,
            "archive": 520,
        },
    },
}


class Logger:
    @staticmethod
    def log(message: str, level: str = "info") -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        prefix = {
            "info": "INFO",
            "warn": "WARN",
            "error": "ERR ",
            "debug": "DBG ",
            "success": "OK  ",
        }.get(level, "INFO")
        print(f"[{stamp}] [{prefix}] {message}", flush=True)


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text) / 4))


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def hash_text(*parts: str) -> str:
    digest = hashlib.sha256("||".join(parts).encode("utf-8")).hexdigest()
    return digest[:24]


def chunk_text(text: str, max_chunk_size: int = 900, overlap: int = 80) -> List[str]:
    stripped = text.strip()
    if not stripped:
        return []
    if len(stripped) <= max_chunk_size:
        return [stripped]

    paragraphs = re.split(r"\n\s*\n", stripped)
    chunks: List[str] = []
    current = ""
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) > max_chunk_size:
            sentences = re.split(r"(?<=[。！？!?\.])\s+|(?<=\n)", paragraph)
        else:
            sentences = [paragraph]
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            if not current:
                current = sentence
                continue
            if len(current) + len(sentence) + 1 <= max_chunk_size:
                current += "\n" + sentence
            else:
                chunks.append(current)
                if overlap > 0:
                    tail = current[-overlap:]
                    current = f"{tail}\n{sentence}"
                else:
                    current = sentence
    if current:
        chunks.append(current)
    return chunks


def tokenize(text: str) -> List[str]:
    tokens = re.findall(r"[a-zA-Z0-9_./-]+", text.lower())
    tokens.extend(re.findall(r"[\u4e00-\u9fff]", text))
    return tokens


def overlap_score(query: str, content: str) -> float:
    q_terms = set(tokenize(query))
    if not q_terms:
        return 0.0
    c_terms = set(tokenize(content))
    if not c_terms:
        return 0.0
    return len(q_terms & c_terms) / max(len(q_terms), 1)


def cosine_similarity(vec_a: Optional[List[float]], vec_b: Optional[List[float]]) -> float:
    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return clamp(dot / (norm_a * norm_b), 0.0, 1.0)


def extract_text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if text:
                    parts.append(str(text))
        return "\n".join(parts)
    return ""


def compact_text(text: str, max_chars: int = 280) -> str:
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 1].rstrip() + "…"


class HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        value = data.strip()
        if value:
            self.parts.append(value)

    def get_text(self) -> str:
        return "\n".join(self.parts)


class EmbeddingProvider:
    def __init__(self) -> None:
        self.enabled = False
        self.model = None
        self.model_name = os.getenv("LOCAL_MEMORY_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
        if SentenceTransformer is None:
            Logger.log("SentenceTransformer 未安装，回退为词法检索", "warn")
            return
        try:
            start = time.time()
            self.model = SentenceTransformer(self.model_name)
            self.enabled = True
            Logger.log(
                f"向量模型已加载: {self.model_name} ({time.time() - start:.2f}s)",
                "success",
            )
        except Exception as exc:
            Logger.log(f"向量模型加载失败，回退为词法检索: {exc}", "warn")
            self.model = None
            self.enabled = False

    def encode_many(self, texts: List[str]) -> List[Optional[List[float]]]:
        if not texts:
            return []
        if not self.enabled or self.model is None:
            return [None for _ in texts]
        try:
            vectors = self.model.encode(texts, show_progress_bar=False).tolist()
            return [list(map(float, vector)) for vector in vectors]
        except Exception as exc:
            Logger.log(f"向量编码失败: {exc}", "warn")
            return [None for _ in texts]

    def encode_one(self, text: str) -> Optional[List[float]]:
        items = self.encode_many([text])
        return items[0] if items else None


class LocalMemoryEngine:
    def __init__(self, db_path: str = "./agent_memory", ttl_days: int = 180) -> None:
        root = Path(db_path).expanduser()
        if root.suffix:
            self.storage_dir = root.parent
            self.db_file = root
        else:
            self.storage_dir = root
            self.db_file = root / "memory.db"
        self.storage_dir.mkdir(parents=True, exist_ok=True)

        Logger.log(f"初始化本地记忆引擎 v{VERSION}...")
        Logger.log(f"数据库路径: {self.db_file}")

        self.ttl_days = ttl_days
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(self.db_file), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init_schema()

        Logger.log("加载检索后端...")
        self.embeddings = EmbeddingProvider()
        self._cleanup_expired()
        Logger.log("记忆引擎初始化完成", "success")

    def _init_schema(self) -> None:
        with self.lock:
            cursor = self.db.cursor()
            cursor.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;

                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    workspace_path TEXT UNIQUE,
                    project_name TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS memories (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    session_key TEXT,
                    layer TEXT NOT NULL,
                    visibility TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    source TEXT,
                    title TEXT,
                    content TEXT NOT NULL,
                    summary TEXT,
                    metadata_json TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    importance REAL NOT NULL,
                    confidence REAL NOT NULL,
                    access_count INTEGER NOT NULL DEFAULT 0,
                    last_accessed_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    archived_at TEXT,
                    expires_at TEXT,
                    token_estimate INTEGER NOT NULL DEFAULT 0,
                    embedding_json TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_memories_scope
                ON memories(project_id, visibility, layer, archived_at, updated_at);

                CREATE INDEX IF NOT EXISTS idx_memories_fingerprint
                ON memories(fingerprint, project_id, layer, visibility);

                CREATE TABLE IF NOT EXISTS context_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT,
                    session_key TEXT,
                    route TEXT NOT NULL,
                    query_chars INTEGER NOT NULL,
                    budget_chars INTEGER NOT NULL,
                    selected_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            self.db.commit()

    def _normalize_workspace(self, workspace_dir: Optional[str]) -> str:
        if not workspace_dir:
            return "__global__"
        try:
            return str(Path(workspace_dir).expanduser().resolve())
        except Exception:
            return os.path.abspath(os.path.expanduser(workspace_dir))

    def ensure_project(self, workspace_dir: Optional[str]) -> Dict[str, str]:
        workspace_path = self._normalize_workspace(workspace_dir)
        if workspace_path == "__global__":
            return {"id": "__global__", "workspace_path": workspace_path, "project_name": "global"}

        project_id = hash_text(workspace_path)
        project_name = Path(workspace_path).name or "workspace"
        now = now_iso()
        with self.lock:
            self.db.execute(
                """
                INSERT INTO projects(id, workspace_path, project_name, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(workspace_path) DO UPDATE SET
                    project_name=excluded.project_name,
                    updated_at=excluded.updated_at
                """,
                (project_id, workspace_path, project_name, now, now),
            )
            self.db.commit()
        return {
            "id": project_id,
            "workspace_path": workspace_path,
            "project_name": project_name,
        }

    def _default_expire_at(self, layer: str, explicit_days: Optional[int]) -> Optional[str]:
        if explicit_days is not None:
            if explicit_days <= 0:
                return None
            return (datetime.now() + timedelta(days=explicit_days)).isoformat(timespec="seconds")

        if layer == "session_episode":
            return (datetime.now() + timedelta(days=max(self.ttl_days, 30))).isoformat(
                timespec="seconds"
            )
        if layer == "summary":
            return (datetime.now() + timedelta(days=max(self.ttl_days * 2, 90))).isoformat(
                timespec="seconds"
            )
        return None

    def _upsert_memory(
        self,
        *,
        project_id: Optional[str],
        session_key: Optional[str],
        layer: str,
        visibility: str,
        kind: str,
        source: str,
        title: str,
        content: str,
        summary: Optional[str],
        metadata: Optional[Dict[str, Any]],
        importance: float,
        confidence: float,
        expires_days: Optional[int],
        force: bool = False,
    ) -> Dict[str, Any]:
        layer = layer if layer in DEFAULT_LAYER_VISIBILITY else "project_knowledge"
        visibility = visibility if visibility in VISIBLE_SCOPES else DEFAULT_LAYER_VISIBILITY[layer]
        title = compact_text(title or content.splitlines()[0], 90)
        content = content.strip()
        if not content:
            return {"stored": False, "reason": "内容为空"}

        fingerprint = hash_text(
            project_id or "__global__",
            layer,
            visibility,
            normalize_text(title),
            normalize_text(content),
        )
        embedding = self.embeddings.encode_one(content)
        embedding_json = json.dumps(embedding, ensure_ascii=False) if embedding is not None else None
        now = now_iso()
        expires_at = self._default_expire_at(layer, expires_days)
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)

        with self.lock:
            existing = self.db.execute(
                """
                SELECT id, importance, confidence FROM memories
                WHERE fingerprint=? AND COALESCE(project_id, '')=COALESCE(?, '')
                  AND layer=? AND visibility=? AND archived_at IS NULL
                LIMIT 1
                """,
                (fingerprint, project_id, layer, visibility),
            ).fetchone()

            if existing and not force:
                self.db.execute(
                    """
                    UPDATE memories
                    SET title=?, content=?, summary=?, source=?, metadata_json=?,
                        importance=?, confidence=?, updated_at=?, expires_at=?,
                        session_key=?, embedding_json=?
                    WHERE id=?
                    """,
                    (
                        title,
                        content,
                        summary,
                        source,
                        metadata_json,
                        max(float(existing["importance"]), importance),
                        max(float(existing["confidence"]), confidence),
                        now,
                        expires_at,
                        session_key,
                        embedding_json,
                        existing["id"],
                    ),
                )
                self.db.commit()
                return {"stored": True, "updated": True, "id": existing["id"], "fingerprint": fingerprint}

            memory_id = str(uuid.uuid4())
            self.db.execute(
                """
                INSERT INTO memories(
                    id, project_id, session_key, layer, visibility, kind, source, title,
                    content, summary, metadata_json, fingerprint, importance, confidence,
                    access_count, last_accessed_at, created_at, updated_at, archived_at,
                    expires_at, token_estimate, embedding_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, ?, ?, ?)
                """,
                (
                    memory_id,
                    project_id,
                    session_key,
                    layer,
                    visibility,
                    kind,
                    source,
                    title,
                    content,
                    summary,
                    metadata_json,
                    fingerprint,
                    importance,
                    confidence,
                    now,
                    now,
                    expires_at,
                    estimate_tokens(content),
                    embedding_json,
                ),
            )
            self.db.commit()
            return {"stored": True, "updated": False, "id": memory_id, "fingerprint": fingerprint}

    def ingest_text(
        self,
        *,
        text: str,
        source_name: str,
        workspace_dir: Optional[str],
        session_key: Optional[str] = None,
        layer: str = "project_knowledge",
        visibility: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        importance: float = 0.72,
        confidence: float = 0.74,
        force: bool = False,
        expires_days: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not text or not text.strip():
            return {"success": False, "error": "文本为空"}

        project = self.ensure_project(workspace_dir)
        resolved_visibility = visibility or DEFAULT_LAYER_VISIBILITY.get(layer, "project")
        chunks = chunk_text(text)
        stored = 0
        updated = 0
        ids: List[str] = []

        for index, chunk in enumerate(chunks):
            title = source_name if len(chunks) == 1 else f"{source_name} #{index + 1}"
            result = self._upsert_memory(
                project_id=None if resolved_visibility == "global" else project["id"],
                session_key=session_key if resolved_visibility == "private" else None,
                layer=layer,
                visibility=resolved_visibility,
                kind="manual_text",
                source=source_name,
                title=title,
                content=chunk,
                summary=compact_text(chunk, 180),
                metadata={"source_name": source_name, **(metadata or {})},
                importance=importance,
                confidence=confidence,
                expires_days=expires_days,
                force=force,
            )
            if result.get("stored"):
                stored += 1
                if result.get("updated"):
                    updated += 1
                ids.append(str(result["id"]))

        return {
            "success": True,
            "chunks_stored": stored,
            "chunks_updated": updated,
            "source": source_name,
            "layer": layer,
            "visibility": resolved_visibility,
            "project_id": project["id"],
            "memory_ids": ids,
        }

    async def ingest_url(
        self,
        *,
        url: str,
        source_name: str,
        workspace_dir: Optional[str],
        session_key: Optional[str] = None,
        layer: str = "project_knowledge",
        visibility: Optional[str] = None,
        force: bool = False,
    ) -> Dict[str, Any]:
        try:
            content = await self._fetch_url_text(url)
        except Exception as exc:
            return {"success": False, "error": str(exc)}

        return self.ingest_text(
            text=content,
            source_name=source_name or url,
            workspace_dir=workspace_dir,
            session_key=session_key,
            layer=layer,
            visibility=visibility,
            metadata={"url": url},
            importance=0.7,
            confidence=0.7,
            force=force,
        )

    async def _fetch_url_text(self, url: str) -> str:
        if AsyncWebCrawler is not None:
            try:
                async with AsyncWebCrawler() as crawler:
                    result = await crawler.arun(url=url)
                if result.success and (result.markdown or "").strip():
                    return result.markdown
            except Exception as exc:
                Logger.log(f"crawl4ai 抓取失败，回退到 urllib: {exc}", "warn")

        req = Request(url, headers={"User-Agent": "OpenClaw-Local-Memory/3.0"})
        with urlopen(req, timeout=20) as response:
            raw = response.read().decode("utf-8", "ignore")
        extractor = HTMLTextExtractor()
        extractor.feed(raw)
        text = extractor.get_text().strip()
        if not text:
            raise RuntimeError("抓取结果为空")
        return text

    def _query_candidates(
        self,
        project_id: Optional[str],
        session_key: Optional[str],
        include_archived: bool = False,
    ) -> List[sqlite3.Row]:
        now = now_iso()
        archive_filter = "" if include_archived else "AND archived_at IS NULL"
        with self.lock:
            rows = self.db.execute(
                f"""
                SELECT * FROM memories
                WHERE (expires_at IS NULL OR expires_at > ?)
                  {archive_filter}
                  AND (
                    visibility='global'
                    OR (visibility='project' AND project_id=?)
                    OR (visibility='private' AND session_key=?)
                  )
                ORDER BY updated_at DESC
                LIMIT 1200
                """,
                (now, project_id, session_key),
            ).fetchall()
        return rows

    def _memory_payload(self, row: sqlite3.Row, include_embedding: bool = False) -> Dict[str, Any]:
        metadata = {}
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except Exception:
            metadata = {}
        embedding = None
        if include_embedding and row["embedding_json"]:
            try:
                embedding = json.loads(row["embedding_json"])
            except Exception:
                embedding = None
        return {
            "id": row["id"],
            "project_id": row["project_id"],
            "session_key": row["session_key"],
            "layer": row["layer"],
            "visibility": row["visibility"],
            "kind": row["kind"],
            "source": row["source"],
            "title": row["title"],
            "content": row["content"],
            "summary": row["summary"],
            "metadata": metadata,
            "importance": float(row["importance"]),
            "confidence": float(row["confidence"]),
            "access_count": int(row["access_count"]),
            "last_accessed_at": row["last_accessed_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "expires_at": row["expires_at"],
            "token_estimate": int(row["token_estimate"]),
            **({"embedding": embedding} if include_embedding else {}),
        }

    def _layer_bias(self, layer: str) -> float:
        return {
            "user_preference": 0.18,
            "project_knowledge": 0.16,
            "summary": 0.12,
            "session_episode": 0.09,
            "archive": 0.06,
        }.get(layer, 0.05)

    def _recency_score(self, item: Dict[str, Any]) -> float:
        created = parse_iso(item.get("updated_at")) or parse_iso(item.get("created_at"))
        if not created:
            return 0.4
        age_days = max((datetime.now() - created).days, 0)
        if item["layer"] in {"user_preference", "project_knowledge", "archive"}:
            return 1.0
        return clamp(1.0 - (age_days / 180), 0.15, 1.0)

    def _score_memory(
        self,
        query: str,
        query_embedding: Optional[List[float]],
        item: Dict[str, Any],
    ) -> float:
        lexical = overlap_score(query, item["content"] + "\n" + (item.get("summary") or ""))
        vector = cosine_similarity(query_embedding, item.get("embedding"))
        recency = self._recency_score(item)
        importance = clamp(float(item["importance"]), 0.0, 1.0)
        confidence = clamp(float(item["confidence"]), 0.0, 1.0)
        layer_bias = self._layer_bias(item["layer"])
        source_bias = 0.03 if item["kind"] in {"manual_text", "manual_preference"} else 0.0

        if vector == 0.0:
            vector = lexical * 0.85

        score = (
            vector * 0.42
            + lexical * 0.22
            + importance * 0.14
            + confidence * 0.08
            + recency * 0.08
            + layer_bias
            + source_bias
        )
        return clamp(score, 0.0, 1.0)

    def recall(
        self,
        *,
        query: str,
        workspace_dir: Optional[str],
        session_key: Optional[str],
        top_k: int = 8,
        include_archived: bool = False,
    ) -> Dict[str, Any]:
        if not query or not query.strip():
            return {"success": False, "error": "查询为空", "results": []}

        project = self.ensure_project(workspace_dir)
        query_embedding = self.embeddings.encode_one(query)
        candidates = self._query_candidates(project["id"], session_key, include_archived)

        scored: List[Dict[str, Any]] = []
        for row in candidates:
            item = self._memory_payload(row, include_embedding=True)
            score = self._score_memory(query, query_embedding, item)
            if score <= 0.08:
                continue
            item.pop("embedding", None)
            item["score"] = round(score, 4)
            scored.append(item)

        scored.sort(key=lambda item: item["score"], reverse=True)
        results = scored[:top_k]
        self._mark_accessed([item["id"] for item in results])

        return {
            "success": True,
            "query": query,
            "project": project,
            "results": results,
        }

    def _mark_accessed(self, memory_ids: Iterable[str]) -> None:
        ids = [memory_id for memory_id in memory_ids if memory_id]
        if not ids:
            return
        now = now_iso()
        placeholders = ",".join("?" for _ in ids)
        with self.lock:
            self.db.execute(
                f"""
                UPDATE memories
                SET access_count = access_count + 1,
                    last_accessed_at = ?
                WHERE id IN ({placeholders})
                """,
                [now, *ids],
            )
            self.db.commit()

    def _auto_route(self, query: str) -> str:
        tokens = estimate_tokens(query)
        if tokens >= 320:
            return "lean"
        if tokens >= 120:
            return "balanced"
        return "deep"

    def _record_context_request(
        self,
        *,
        project_id: Optional[str],
        session_key: Optional[str],
        route: str,
        query_chars: int,
        budget_chars: int,
        selected_count: int,
    ) -> None:
        with self.lock:
            self.db.execute(
                """
                INSERT INTO context_requests(project_id, session_key, route, query_chars, budget_chars, selected_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (project_id, session_key, route, query_chars, budget_chars, selected_count, now_iso()),
            )
            self.db.commit()

    def build_context(
        self,
        *,
        query: str,
        workspace_dir: Optional[str],
        session_key: Optional[str],
        route: str = DEFAULT_ROUTE,
        top_k: int = 12,
    ) -> Dict[str, Any]:
        project = self.ensure_project(workspace_dir)
        resolved_route = self._auto_route(query) if route == "auto" else route
        if resolved_route not in ROUTE_CONFIG:
            resolved_route = "balanced"
        route_config = ROUTE_CONFIG[resolved_route]

        recalled = self.recall(
            query=query,
            workspace_dir=workspace_dir,
            session_key=session_key,
            top_k=max(top_k, 18),
        )
        if not recalled.get("success"):
            return {"success": False, "error": recalled.get("error", "context build failed")}

        bucket_usage = defaultdict(int)
        selected: List[Dict[str, Any]] = []
        total_chars = 0
        seen_payloads = set()
        for item in recalled["results"]:
            layer = item["layer"]
            score = float(item["score"])
            if score < route_config["min_score"] and layer != "user_preference":
                continue
            limit_for_layer = route_config["layer_limits"].get(layer, 220)
            payload = item.get("summary") or item["content"]
            payload = compact_text(payload, 420 if resolved_route != "lean" else 260)
            dedupe_key = normalize_text(payload)
            if dedupe_key in seen_payloads:
                continue
            section_text = f"- {item['title']}: {payload}"
            if bucket_usage[layer] + len(section_text) > limit_for_layer:
                continue
            if total_chars + len(section_text) > route_config["char_budget"]:
                continue
            bucket_usage[layer] += len(section_text)
            total_chars += len(section_text)
            seen_payloads.add(dedupe_key)
            item["context_text"] = section_text
            selected.append(item)

        grouped: Dict[str, List[str]] = defaultdict(list)
        for item in selected:
            grouped[item["layer"]].append(item["context_text"])

        section_titles = {
            "user_preference": "用户偏好",
            "project_knowledge": "项目长期知识",
            "summary": "沉淀摘要",
            "session_episode": "近期会话片段",
            "archive": "归档洞察",
        }
        blocks: List[str] = [
            f'<local-memory route="{resolved_route}" project="{escape(project["project_name"])}">'
        ]
        for layer in LAYER_ORDER:
            entries = grouped.get(layer)
            if not entries:
                continue
            blocks.append(f"### {section_titles[layer]}")
            blocks.extend(entries)
            blocks.append("")
        if len(blocks) == 1:
            blocks.append("没有找到足够相关的历史记忆。")
        blocks.append("</local-memory>")
        context = "\n".join(blocks).strip()

        self._record_context_request(
            project_id=project["id"],
            session_key=session_key,
            route=resolved_route,
            query_chars=len(query),
            budget_chars=int(route_config["char_budget"]),
            selected_count=len(selected),
        )

        return {
            "success": True,
            "project": project,
            "route": resolved_route,
            "char_budget": route_config["char_budget"],
            "selected_count": len(selected),
            "results": selected,
            "context": context,
        }

    def reflect(
        self,
        *,
        messages: List[Dict[str, Any]],
        tool_events: Optional[List[str]],
        workspace_dir: Optional[str],
        session_key: Optional[str],
    ) -> Dict[str, Any]:
        project = self.ensure_project(workspace_dir)
        user_texts: List[str] = []
        assistant_texts: List[str] = []
        for message in messages:
            role = str(message.get("role", ""))
            text = extract_text_from_content(message.get("content"))
            text = compact_text(text, 1800)
            if not text:
                continue
            if role == "user":
                user_texts.append(text)
            elif role == "assistant":
                assistant_texts.append(text)

        stored = {
            "user_preference": 0,
            "project_knowledge": 0,
            "summary": 0,
            "session_episode": 0,
        }

        for pref in self._extract_preferences(user_texts):
            visibility = "project" if pref["project_scoped"] else "global"
            result = self._upsert_memory(
                project_id=None if visibility == "global" else project["id"],
                session_key=None,
                layer="user_preference",
                visibility=visibility,
                kind="auto_reflection",
                source="agent_end",
                title=pref["title"],
                content=pref["content"],
                summary=pref["content"],
                metadata={"origin": "reflect", "project_scoped": pref["project_scoped"]},
                importance=0.88,
                confidence=0.78,
                expires_days=None,
            )
            if result.get("stored"):
                stored["user_preference"] += 1

        for fact in self._extract_project_knowledge(user_texts + assistant_texts):
            result = self._upsert_memory(
                project_id=project["id"],
                session_key=None,
                layer="project_knowledge",
                visibility="project",
                kind="auto_reflection",
                source="agent_end",
                title=fact["title"],
                content=fact["content"],
                summary=fact["content"],
                metadata={"origin": "reflect"},
                importance=0.8,
                confidence=0.72,
                expires_days=None,
            )
            if result.get("stored"):
                stored["project_knowledge"] += 1

        summary_text = self._build_session_summary(user_texts, assistant_texts, tool_events or [])
        if summary_text:
            result = self._upsert_memory(
                project_id=project["id"],
                session_key=None,
                layer="summary",
                visibility="project",
                kind="session_summary",
                source="agent_end",
                title=f"Session summary {session_key or now_iso()}",
                content=summary_text,
                summary=compact_text(summary_text, 220),
                metadata={"origin": "reflect", "session_key": session_key},
                importance=0.74,
                confidence=0.7,
                expires_days=max(self.ttl_days, 120),
            )
            if result.get("stored"):
                stored["summary"] += 1

        session_note = self._build_session_episode(user_texts, tool_events or [])
        if session_note:
            result = self._upsert_memory(
                project_id=project["id"],
                session_key=session_key,
                layer="session_episode",
                visibility="private",
                kind="session_episode",
                source="agent_end",
                title=f"Session episode {session_key or now_iso()}",
                content=session_note,
                summary=compact_text(session_note, 180),
                metadata={"origin": "reflect", "session_key": session_key},
                importance=0.66,
                confidence=0.64,
                expires_days=self.ttl_days,
            )
            if result.get("stored"):
                stored["session_episode"] += 1

        return {
            "success": True,
            "project": project,
            "stored": stored,
        }

    def _extract_preferences(self, texts: List[str]) -> List[Dict[str, Any]]:
        patterns = (
            "请用",
            "不要",
            "别",
            "优先",
            "尽量",
            "我喜欢",
            "我更喜欢",
            "我偏好",
            "我希望",
            "always ",
            "prefer ",
            "please ",
            "avoid ",
            "don't ",
        )
        seen = set()
        extracted: List[Dict[str, Any]] = []
        for text in texts:
            for line in re.split(r"[\n。！？!?]", text):
                line = re.sub(r"\s+", " ", line).strip(" -•\t")
                if len(line) < 6 or len(line) > 160:
                    continue
                lowered = line.lower()
                if not any(token in lowered for token in patterns):
                    continue
                key = normalize_text(line)
                if key in seen:
                    continue
                seen.add(key)
                project_scoped = bool(
                    re.search(r"(这个项目|当前项目|仓库|repo|代码库|workspace|project)", line, re.I)
                )
                extracted.append(
                    {
                        "title": compact_text(line, 72),
                        "content": line,
                        "project_scoped": project_scoped,
                    }
                )
        return extracted[:10]

    def _extract_project_knowledge(self, texts: List[str]) -> List[Dict[str, Any]]:
        keywords = (
            "项目",
            "仓库",
            "代码库",
            "技术栈",
            "规范",
            "约定",
            "命名",
            "使用",
            "禁止",
            "架构",
            "数据库",
            "测试",
            "部署",
            "目录",
            "风格",
            "project",
            "repo",
            "convention",
            "naming",
            "stack",
            "test",
            "deploy",
            "architecture",
        )
        seen = set()
        extracted: List[Dict[str, Any]] = []
        for text in texts:
            for line in re.split(r"[\n。！？!?]", text):
                line = re.sub(r"\s+", " ", line).strip(" -•\t")
                if len(line) < 8 or len(line) > 180:
                    continue
                lowered = line.lower()
                if not any(token in lowered for token in keywords):
                    continue
                if re.search(r"(我喜欢|我偏好|我更喜欢|我希望|prefer|avoid|don't)", line, re.I):
                    continue
                if not re.search(r"(使用|采用|禁止|必须|应该|约定|规范|prefer|must|should|use )", line, re.I):
                    continue
                key = normalize_text(line)
                if key in seen:
                    continue
                seen.add(key)
                extracted.append({"title": compact_text(line, 72), "content": line})
        return extracted[:12]

    def _build_session_summary(
        self, user_texts: List[str], assistant_texts: List[str], tool_events: List[str]
    ) -> str:
        bullets: List[str] = []
        if user_texts:
            bullets.append("用户本轮主要目标: " + compact_text(user_texts[-1], 220))
        if len(user_texts) > 1:
            bullets.append("补充上下文: " + compact_text(user_texts[-2], 180))
        if assistant_texts:
            bullets.append("助手输出摘要: " + compact_text(assistant_texts[-1], 220))
        if tool_events:
            bullets.append("工具轨迹: " + compact_text(" | ".join(tool_events[-6:]), 260))
        return "\n".join(f"- {bullet}" for bullet in bullets if bullet)

    def _build_session_episode(self, user_texts: List[str], tool_events: List[str]) -> str:
        parts: List[str] = []
        if user_texts:
            parts.append("用户请求: " + compact_text(user_texts[-1], 220))
        if tool_events:
            parts.append("使用工具: " + compact_text(" | ".join(tool_events[-8:]), 260))
        return "\n".join(f"- {item}" for item in parts if item)

    def _archive_compact_for_project(
        self,
        *,
        project: Dict[str, str],
        older_than_days: int = 14,
    ) -> Dict[str, Any]:
        cutoff = (datetime.now() - timedelta(days=older_than_days)).isoformat(timespec="seconds")
        with self.lock:
            rows = self.db.execute(
                """
                SELECT * FROM memories
                WHERE project_id=?
                  AND archived_at IS NULL
                  AND layer IN ('summary', 'session_episode')
                  AND updated_at < ?
                ORDER BY updated_at ASC
                LIMIT 60
                """,
                (project["id"], cutoff),
            ).fetchall()

        if len(rows) < 3:
            return {
                "success": True,
                "project": project,
                "archived_count": 0,
                "created_archive": False,
                "message": "可归档的沉淀不足，已跳过",
            }

        lines = []
        ids = []
        for row in rows:
            item = self._memory_payload(row)
            ids.append(item["id"])
            lines.append(f"- [{item['layer']}] {compact_text(item['title'] or item['content'], 80)}")
            lines.append(f"  {compact_text(item['summary'] or item['content'], 220)}")

        archive_text = "\n".join(lines)
        archive_result = self._upsert_memory(
            project_id=project["id"],
            session_key=None,
            layer="archive",
            visibility="project",
            kind="archive_compaction",
            source="archive_compact",
            title=f"Archive digest {datetime.now().strftime('%Y-%m-%d')}",
            content=archive_text,
            summary=compact_text(archive_text, 260),
            metadata={"older_than_days": older_than_days, "source_count": len(ids)},
            importance=0.7,
            confidence=0.8,
            expires_days=None,
            force=True,
        )

        archived_at = now_iso()
        placeholders = ",".join("?" for _ in ids)
        with self.lock:
            self.db.execute(
                f"UPDATE memories SET archived_at=? WHERE id IN ({placeholders})",
                [archived_at, *ids],
            )
            self.db.commit()

        return {
            "success": True,
            "project": project,
            "archived_count": len(ids),
            "created_archive": bool(archive_result.get("stored")),
            "archive_id": archive_result.get("id"),
        }

    def archive_compact(
        self,
        *,
        workspace_dir: Optional[str],
        older_than_days: int = 14,
        all_projects: bool = False,
    ) -> Dict[str, Any]:
        if not all_projects:
            project = self.ensure_project(workspace_dir)
            return self._archive_compact_for_project(
                project=project,
                older_than_days=older_than_days,
            )

        with self.lock:
            project_rows = self.db.execute(
                """
                SELECT id, workspace_path, project_name
                FROM projects
                ORDER BY updated_at DESC
                """
            ).fetchall()

        project_payloads = [
            {
                "id": row["id"],
                "workspace_path": row["workspace_path"],
                "project_name": row["project_name"],
            }
            for row in project_rows
        ]

        results = []
        total_archived = 0
        total_created = 0
        for project in project_payloads:
            result = self._archive_compact_for_project(
                project=project,
                older_than_days=older_than_days,
            )
            archived_count = int(result.get("archived_count", 0))
            total_archived += archived_count
            total_created += int(bool(result.get("created_archive")))
            if archived_count > 0 or result.get("created_archive"):
                results.append(result)

        return {
            "success": True,
            "scope": "all_projects",
            "project_count": len(project_payloads),
            "archived_count": total_archived,
            "created_archives": total_created,
            "projects": results,
        }

    def cleanup(
        self,
        *,
        source: Optional[str] = None,
        before: Optional[str] = None,
        workspace_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        conditions = []
        params: List[Any] = []
        if source:
            conditions.append("source = ?")
            params.append(source)
        if before:
            conditions.append("updated_at < ?")
            params.append(before)
        if workspace_dir:
            project = self.ensure_project(workspace_dir)
            conditions.append("project_id = ?")
            params.append(project["id"])
        if not conditions:
            return {"success": False, "error": "请指定 source / before / workspace_dir 之一"}

        where_sql = " AND ".join(conditions)
        with self.lock:
            rows = self.db.execute(
                f"SELECT id FROM memories WHERE {where_sql}",
                params,
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                self.db.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", ids)
                self.db.commit()
        return {"success": True, "deleted_count": len(ids)}

    def _cleanup_expired(self) -> int:
        now = now_iso()
        with self.lock:
            rows = self.db.execute(
                "SELECT id FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?",
                (now,),
            ).fetchall()
            ids = [row["id"] for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                self.db.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", ids)
                self.db.commit()
        if ids:
            Logger.log(f"已清理 {len(ids)} 条过期记忆", "success")
        return len(ids)

    def stats(self, *, workspace_dir: Optional[str] = None) -> Dict[str, Any]:
        project = self.ensure_project(workspace_dir) if workspace_dir else None
        params: List[Any] = []
        project_clause = ""
        if project and project["id"] != "__global__":
            project_clause = "AND (project_id = ? OR visibility = 'global')"
            params.append(project["id"])

        with self.lock:
            total_active = self.db.execute(
                f"""
                SELECT COUNT(*) AS count FROM memories
                WHERE archived_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  {project_clause}
                """,
                [now_iso(), *params],
            ).fetchone()["count"]

            layer_rows = self.db.execute(
                f"""
                SELECT layer, COUNT(*) AS count
                FROM memories
                WHERE archived_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  {project_clause}
                GROUP BY layer
                ORDER BY count DESC
                """,
                [now_iso(), *params],
            ).fetchall()

            visibility_rows = self.db.execute(
                f"""
                SELECT visibility, COUNT(*) AS count
                FROM memories
                WHERE archived_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  {project_clause}
                GROUP BY visibility
                ORDER BY count DESC
                """,
                [now_iso(), *params],
            ).fetchall()

            source_rows = self.db.execute(
                f"""
                SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
                FROM memories
                WHERE archived_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  {project_clause}
                GROUP BY source
                ORDER BY count DESC
                LIMIT 8
                """,
                [now_iso(), *params],
            ).fetchall()

            recent_routes = self.db.execute(
                """
                SELECT route, COUNT(*) AS count
                FROM context_requests
                WHERE created_at > ?
                GROUP BY route
                ORDER BY count DESC
                """,
                ((datetime.now() - timedelta(days=14)).isoformat(timespec="seconds"),),
            ).fetchall()

            project_rows = self.db.execute(
                """
                SELECT p.project_name, p.workspace_path, COUNT(m.id) AS count
                FROM projects p
                LEFT JOIN memories m ON m.project_id = p.id AND m.archived_at IS NULL
                GROUP BY p.id, p.project_name, p.workspace_path
                ORDER BY count DESC, p.updated_at DESC
                LIMIT 12
                """
            ).fetchall()

            recent_memories = self.db.execute(
                f"""
                SELECT id, title, layer, visibility, source, updated_at, importance
                FROM memories
                WHERE archived_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)
                  {project_clause}
                ORDER BY updated_at DESC
                LIMIT 20
                """,
                [now_iso(), *params],
            ).fetchall()

        return {
            "success": True,
            "version": VERSION,
            "ttl_days": self.ttl_days,
            "vector_enabled": self.embeddings.enabled,
            "total_chunks": int(total_active),
            "unique_sources": len(source_rows),
            "layers": {row["layer"]: int(row["count"]) for row in layer_rows},
            "visibilities": {row["visibility"]: int(row["count"]) for row in visibility_rows},
            "sources": {row["source"]: int(row["count"]) for row in source_rows},
            "route_usage": {row["route"]: int(row["count"]) for row in recent_routes},
            "projects": [
                {
                    "project_name": row["project_name"],
                    "workspace_path": row["workspace_path"],
                    "count": int(row["count"]),
                }
                for row in project_rows
            ],
            "recent_memories": [
                {
                    "id": row["id"],
                    "title": row["title"],
                    "layer": row["layer"],
                    "visibility": row["visibility"],
                    "source": row["source"],
                    "updated_at": row["updated_at"],
                    "importance": float(row["importance"]),
                }
                for row in recent_memories
            ],
            "project": project,
        }

    def dashboard_html(self, *, workspace_dir: Optional[str] = None) -> str:
        stats = self.stats(workspace_dir=workspace_dir)
        project_name = (
            stats.get("project", {}).get("project_name")
            if isinstance(stats.get("project"), dict)
            else "all"
        )
        layers = stats["layers"]
        visibilities = stats["visibilities"]
        route_usage = stats["route_usage"]
        recent_memories = stats["recent_memories"]
        projects = stats["projects"]

        def bar_rows(data: Dict[str, int], label: str) -> str:
            total = max(sum(data.values()), 1)
            rows = []
            for key, value in data.items():
                width = max(6, int((value / total) * 100))
                rows.append(
                    f"""
                    <div class="metric-row">
                      <div class="metric-key">{escape(key)}</div>
                      <div class="metric-bar-wrap">
                        <div class="metric-bar" style="width:{width}%"></div>
                      </div>
                      <div class="metric-value">{value}</div>
                    </div>
                    """
                )
            return f"<section><h2>{escape(label)}</h2>{''.join(rows) or '<p>暂无数据</p>'}</section>"

        recent_rows = "".join(
            f"""
            <tr>
              <td>{escape(item['title'] or '')}</td>
              <td>{escape(item['layer'])}</td>
              <td>{escape(item['visibility'])}</td>
              <td>{escape(item['source'] or '')}</td>
              <td>{escape(item['updated_at'] or '')}</td>
            </tr>
            """
            for item in recent_memories
        )
        project_rows = "".join(
            f"""
            <tr>
              <td>{escape(project['project_name'] or '')}</td>
              <td>{project['count']}</td>
              <td>{escape(project['workspace_path'] or '')}</td>
            </tr>
            """
            for project in projects
        )

        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenClaw Local Memory Dashboard</title>
  <style>
    :root {{
      --bg: #0d1b18;
      --panel: #122923;
      --panel-soft: #18362f;
      --text: #f1f7f5;
      --muted: #9ab8af;
      --accent: #70c58d;
      --accent-soft: #355e49;
      --border: rgba(255,255,255,0.08);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: "SF Mono", "JetBrains Mono", monospace;
      background:
        radial-gradient(circle at top left, rgba(112,197,141,0.14), transparent 30%),
        linear-gradient(135deg, #0b1815, var(--bg));
      color: var(--text);
    }}
    .wrap {{
      max-width: 1200px;
      margin: 0 auto;
      padding: 28px;
    }}
    .hero {{
      display: grid;
      grid-template-columns: 1.5fr 1fr;
      gap: 20px;
      margin-bottom: 22px;
    }}
    .card {{
      background: rgba(18,41,35,0.92);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.18);
    }}
    h1, h2, h3 {{
      margin: 0 0 12px;
      font-weight: 700;
    }}
    h1 {{ font-size: 26px; }}
    h2 {{ font-size: 16px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }}
    .hero-grid {{
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-top: 16px;
    }}
    .hero-stat {{
      padding: 14px;
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(112,197,141,0.12), rgba(0,0,0,0.12));
      border: 1px solid rgba(255,255,255,0.05);
    }}
    .hero-stat .k {{
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }}
    .hero-stat .v {{
      font-size: 24px;
    }}
    .grid {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
      margin-bottom: 20px;
    }}
    .metric-row {{
      display: grid;
      grid-template-columns: 160px 1fr 40px;
      gap: 10px;
      align-items: center;
      margin-bottom: 10px;
    }}
    .metric-key {{
      color: var(--text);
      word-break: break-word;
    }}
    .metric-value {{
      color: var(--muted);
      text-align: right;
    }}
    .metric-bar-wrap {{
      height: 10px;
      background: rgba(255,255,255,0.05);
      border-radius: 999px;
      overflow: hidden;
    }}
    .metric-bar {{
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent), #b8f0c3);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }}
    th, td {{
      text-align: left;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      padding: 10px 8px;
      vertical-align: top;
    }}
    th {{ color: var(--muted); font-weight: 600; }}
    .foot {{
      color: var(--muted);
      font-size: 12px;
      margin-top: 12px;
    }}
    @media (max-width: 860px) {{
      .hero, .grid {{
        grid-template-columns: 1fr;
      }}
      .hero-grid {{
        grid-template-columns: 1fr;
      }}
      .metric-row {{
        grid-template-columns: 1fr;
      }}
    }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <section class="card">
        <h1>OpenClaw Memory Dashboard</h1>
        <div>当前视图: {escape(project_name or 'all')}</div>
        <div class="hero-grid">
          <div class="hero-stat">
            <div class="k">Active Memories</div>
            <div class="v">{stats['total_chunks']}</div>
          </div>
          <div class="hero-stat">
            <div class="k">Vector Search</div>
            <div class="v">{'ON' if stats['vector_enabled'] else 'OFF'}</div>
          </div>
          <div class="hero-stat">
            <div class="k">TTL Days</div>
            <div class="v">{stats['ttl_days']}</div>
          </div>
        </div>
        <div class="foot">分层记忆 + 自动沉淀 + 成本路由 + 三级隐私</div>
      </section>
      <section class="card">
        <h2>Route Usage</h2>
        {bar_rows(route_usage, '注入路由分布')}
      </section>
    </div>

    <div class="grid">
      <section class="card">{bar_rows(layers, '记忆层分布')}</section>
      <section class="card">{bar_rows(visibilities, '隐私层级分布')}</section>
    </div>

    <div class="grid">
      <section class="card">
        <h2>Recent Memories</h2>
        <table>
          <thead>
            <tr><th>标题</th><th>层级</th><th>隐私</th><th>来源</th><th>更新时间</th></tr>
          </thead>
          <tbody>{recent_rows or '<tr><td colspan="5">暂无数据</td></tr>'}</tbody>
        </table>
      </section>
      <section class="card">
        <h2>Projects</h2>
        <table>
          <thead>
            <tr><th>项目</th><th>记忆数</th><th>路径</th></tr>
          </thead>
          <tbody>{project_rows or '<tr><td colspan="3">暂无数据</td></tr>'}</tbody>
        </table>
      </section>
    </div>
  </div>
</body>
</html>"""


engine: Optional[LocalMemoryEngine] = None


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, data: Dict[str, Any], status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        try:
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            Logger.log("响应写入时连接已断开", "debug")

    def _send_html(self, html: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(html.encode("utf-8"))
        except (BrokenPipeError, ConnectionResetError):
            Logger.log("响应写入时连接已断开", "debug")

    def _read_body(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length <= 0:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        assert engine is not None
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        path = parsed.path

        if path == "/health":
            self._send_json(
                {
                    "status": "ok",
                    "service": "local-memory",
                    "version": VERSION,
                    "vector_enabled": engine.embeddings.enabled,
                }
            )
            return

        if path == "/stats":
            workspace_dir = params.get("workspace_dir", [None])[0]
            self._send_json(engine.stats(workspace_dir=workspace_dir))
            return

        if path == "/recall":
            query = params.get("query", [""])[0]
            top_k = int(params.get("top_k", ["8"])[0])
            workspace_dir = params.get("workspace_dir", [None])[0]
            session_key = params.get("session_key", [None])[0]
            self._send_json(
                engine.recall(
                    query=query,
                    workspace_dir=workspace_dir,
                    session_key=session_key,
                    top_k=top_k,
                )
            )
            return

        if path == "/dashboard":
            workspace_dir = params.get("workspace_dir", [None])[0]
            self._send_html(engine.dashboard_html(workspace_dir=workspace_dir))
            return

        if path == "/cleanup":
            self._send_json(
                engine.cleanup(
                    source=params.get("source", [None])[0],
                    before=params.get("before", [None])[0],
                    workspace_dir=params.get("workspace_dir", [None])[0],
                )
            )
            return

        self._send_json({"success": False, "error": "Not found"}, 404)

    def do_POST(self) -> None:
        assert engine is not None
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_body()

        if path == "/ingest/text":
            result = engine.ingest_text(
                text=body.get("text", ""),
                source_name=body.get("source_name", "manual"),
                workspace_dir=body.get("workspace_dir"),
                session_key=body.get("session_key"),
                layer=body.get("layer", "project_knowledge"),
                visibility=body.get("visibility"),
                metadata=body.get("metadata") or {},
                importance=float(body.get("importance", 0.72)),
                confidence=float(body.get("confidence", 0.74)),
                force=bool(body.get("force", False)),
                expires_days=body.get("expires_days"),
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        if path == "/ingest/url":
            result = asyncio.run(
                engine.ingest_url(
                    url=body.get("url", ""),
                    source_name=body.get("source_name", body.get("url", "url")),
                    workspace_dir=body.get("workspace_dir"),
                    session_key=body.get("session_key"),
                    layer=body.get("layer", "project_knowledge"),
                    visibility=body.get("visibility"),
                    force=bool(body.get("force", False)),
                )
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        if path == "/recall":
            result = engine.recall(
                query=body.get("query", ""),
                workspace_dir=body.get("workspace_dir"),
                session_key=body.get("session_key"),
                top_k=int(body.get("top_k", 8)),
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        if path == "/context":
            result = engine.build_context(
                query=body.get("query", ""),
                workspace_dir=body.get("workspace_dir"),
                session_key=body.get("session_key"),
                route=body.get("route", DEFAULT_ROUTE),
                top_k=int(body.get("top_k", 12)),
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        if path == "/reflect":
            result = engine.reflect(
                messages=body.get("messages") or [],
                tool_events=body.get("tool_events") or [],
                workspace_dir=body.get("workspace_dir"),
                session_key=body.get("session_key"),
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        if path == "/archive/compact":
            result = engine.archive_compact(
                workspace_dir=body.get("workspace_dir"),
                older_than_days=int(body.get("days", 14)),
                all_projects=bool(body.get("all_projects", False)),
            )
            self._send_json(result)
            return

        if path == "/cleanup":
            result = engine.cleanup(
                source=body.get("source"),
                before=body.get("before"),
                workspace_dir=body.get("workspace_dir"),
            )
            self._send_json(result, 200 if result.get("success") else 400)
            return

        self._send_json({"success": False, "error": "Not found"}, 404)

    def do_DELETE(self) -> None:
        assert engine is not None
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        if parsed.path == "/cleanup":
            self._send_json(
                engine.cleanup(
                    source=params.get("source", [None])[0],
                    before=params.get("before", [None])[0],
                    workspace_dir=params.get("workspace_dir", [None])[0],
                )
            )
            return
        self._send_json({"success": False, "error": "Not found"}, 404)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description=f"OpenClaw Local Memory Service v{VERSION}")
    parser.add_argument("--port", type=int, default=37888, help="服务端口")
    parser.add_argument("--db-path", type=str, default="./agent_memory", help="数据库目录或文件")
    parser.add_argument("--ttl-days", type=int, default=180, help="默认过期天数")
    args = parser.parse_args()

    global engine
    engine = LocalMemoryEngine(db_path=args.db_path, ttl_days=args.ttl_days)

    server = ReusableThreadingHTTPServer(("127.0.0.1", args.port), RequestHandler)
    Logger.log(f"服务启动: http://127.0.0.1:{args.port}", "success")
    Logger.log(f"GET  /health")
    Logger.log(f"GET  /stats")
    Logger.log(f"GET  /recall?query=...")
    Logger.log(f"GET  /dashboard")
    Logger.log(f"POST /ingest/text")
    Logger.log(f"POST /ingest/url")
    Logger.log(f"POST /context")
    Logger.log(f"POST /reflect")
    Logger.log(f"POST /archive/compact")
    Logger.log(f"TTL 默认值: {args.ttl_days} 天")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        Logger.log("服务已停止")
        server.server_close()


if __name__ == "__main__":
    main()
