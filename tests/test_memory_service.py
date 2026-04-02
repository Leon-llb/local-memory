import asyncio
import json
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from urllib.request import Request, urlopen

import memory_service as memory_module


class LocalMemoryTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_sentence_transformer = memory_module.SentenceTransformer
        memory_module.SentenceTransformer = None

    def tearDown(self) -> None:
        memory_module.SentenceTransformer = self.original_sentence_transformer
        self.temp_dir.cleanup()


class ArchiveCompactionTests(LocalMemoryTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.engine = memory_module.LocalMemoryEngine(
            db_path=str(Path(self.temp_dir.name) / "memory"),
            ttl_days=30,
        )

    def tearDown(self) -> None:
        self.engine.db.close()
        super().tearDown()

    def _age_project_memories(self, project_id: str) -> None:
        with self.engine.lock:
            self.engine.db.execute(
                """
                UPDATE memories
                SET created_at='2020-01-01T00:00:00',
                    updated_at='2020-01-01T00:00:00'
                WHERE project_id=?
                  AND layer IN ('summary', 'session_episode')
                """,
                (project_id,),
            )
            self.engine.db.commit()

    def test_archive_compact_all_projects_archives_each_project(self) -> None:
        workspaces = ["/tmp/project-alpha", "/tmp/project-beta"]
        for workspace in workspaces:
            project = self.engine.ensure_project(workspace)
            for index in range(3):
                result = self.engine.ingest_text(
                    text=f"summary memory {index} for {workspace}",
                    source_name=f"summary-{index}",
                    workspace_dir=workspace,
                    layer="summary",
                    visibility="project",
                    force=True,
                )
                self.assertTrue(result["success"])
            self._age_project_memories(project["id"])

        result = self.engine.archive_compact(
            workspace_dir=None,
            older_than_days=14,
            all_projects=True,
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["archived_count"], 6)
        self.assertEqual(result["created_archives"], 2)
        self.assertEqual(len(result["projects"]), 2)

        with self.engine.lock:
            archive_count = self.engine.db.execute(
                """
                SELECT COUNT(*) AS count
                FROM memories
                WHERE layer='archive' AND archived_at IS NULL
                """
            ).fetchone()["count"]
        self.assertEqual(archive_count, 2)


class ThreadedServerTests(LocalMemoryTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.original_engine = memory_module.engine
        memory_module.engine = memory_module.LocalMemoryEngine(
            db_path=str(Path(self.temp_dir.name) / "memory"),
            ttl_days=30,
        )
        self.server = memory_module.ReusableThreadingHTTPServer(
            ("127.0.0.1", 0),
            memory_module.RequestHandler,
        )
        self.port = self.server.server_address[1]
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=2)
        assert memory_module.engine is not None
        memory_module.engine.db.close()
        memory_module.engine = self.original_engine
        super().tearDown()

    def _request(self, method: str, path: str, body=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(url, data=data, headers=headers, method=method)
        with urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_health_remains_responsive_during_slow_ingest(self) -> None:
        assert memory_module.engine is not None

        async def slow_fetch(self, url: str) -> str:
            await asyncio.sleep(0.8)
            return f"content from {url}"

        memory_module.engine._fetch_url_text = types.MethodType(slow_fetch, memory_module.engine)
        ingest_result = {}

        def run_ingest() -> None:
            ingest_result["value"] = self._request(
                "POST",
                "/ingest/url",
                {
                    "url": "https://example.com",
                    "source_name": "slow-url",
                    "workspace_dir": "/tmp/project-alpha",
                    "layer": "project_knowledge",
                    "visibility": "project",
                },
            )

        worker = threading.Thread(target=run_ingest)
        worker.start()
        time.sleep(0.1)

        started = time.monotonic()
        health = self._request("GET", "/health")
        elapsed = time.monotonic() - started

        worker.join(timeout=3)
        self.assertEqual(health["status"], "ok")
        self.assertLess(elapsed, 0.5)
        self.assertTrue(ingest_result["value"]["success"])


if __name__ == "__main__":
    unittest.main()
