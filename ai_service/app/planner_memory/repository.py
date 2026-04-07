from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


class MemoryRepository:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self._path.exists():
            self._write({"projects": {}})

    def _read(self) -> dict[str, Any]:
        with self._path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def _write(self, payload: dict[str, Any]) -> None:
        with self._path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

    @staticmethod
    def _empty_project() -> dict[str, Any]:
        return {
            "context_items": [],
            "preferences": {"user": [], "project": []},
            "review_issues": [],
            "session_summaries": [],
        }

    def get_project(self, project_id: str) -> dict[str, Any]:
        with self._lock:
            payload = self._read()
            projects = payload.setdefault("projects", {})
            project = projects.setdefault(project_id, self._empty_project())
            self._write(payload)
            return json.loads(json.dumps(project))

    def update_project(self, project_id: str, project_payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            payload = self._read()
            payload.setdefault("projects", {})[project_id] = project_payload
            self._write(payload)
            return json.loads(json.dumps(project_payload))
