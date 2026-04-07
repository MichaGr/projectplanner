from __future__ import annotations

import json
import threading
from pathlib import Path


DEFAULT_SETTINGS = {
    "api_key": None,
    "selected_model": None,
    "notion_token": None,
    "notion_notes_database_id": None,
    "notion_progress_database_id": None,
    "notion_use_notes_for_ai_context": False,
    "notion_enable_progress_sync": False,
    "notion_progress_field_map": {},
    "notion_notes_field_map": {},
}


class SettingsStore:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self._path.exists():
            self._write(DEFAULT_SETTINGS)

    def _read(self) -> dict[str, str | bool | None]:
        with self._path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return {
            "api_key": data.get("api_key"),
            "selected_model": data.get("selected_model"),
            "notion_token": data.get("notion_token"),
            "notion_notes_database_id": data.get("notion_notes_database_id"),
            "notion_progress_database_id": data.get("notion_progress_database_id"),
            "notion_use_notes_for_ai_context": bool(data.get("notion_use_notes_for_ai_context", False)),
            "notion_enable_progress_sync": bool(data.get("notion_enable_progress_sync", False)),
            "notion_progress_field_map": data.get("notion_progress_field_map", {}) or {},
            "notion_notes_field_map": data.get("notion_notes_field_map", {}) or {},
        }

    def _write(self, payload: dict[str, str | bool | None]) -> None:
        with self._path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

    def get(self) -> dict[str, str | bool | None]:
        with self._lock:
            return self._read()

    def update(
        self,
        *,
        api_key: str | None = None,
        selected_model: str | None = None,
        notion_token: str | None = None,
        notion_notes_database_id: str | None = None,
        notion_progress_database_id: str | None = None,
        notion_use_notes_for_ai_context: bool | None = None,
        notion_enable_progress_sync: bool | None = None,
        notion_progress_field_map: dict[str, str | None] | None = None,
        notion_notes_field_map: dict[str, str | None] | None = None,
    ) -> dict[str, str | bool | None]:
        with self._lock:
            current = self._read()
            if api_key is not None:
                current["api_key"] = api_key
            if selected_model is not None:
                current["selected_model"] = selected_model
            if notion_token is not None:
                current["notion_token"] = notion_token
            if notion_notes_database_id is not None:
                current["notion_notes_database_id"] = notion_notes_database_id
            if notion_progress_database_id is not None:
                current["notion_progress_database_id"] = notion_progress_database_id
            if notion_use_notes_for_ai_context is not None:
                current["notion_use_notes_for_ai_context"] = notion_use_notes_for_ai_context
            if notion_enable_progress_sync is not None:
                current["notion_enable_progress_sync"] = notion_enable_progress_sync
            if notion_progress_field_map is not None:
                current["notion_progress_field_map"] = notion_progress_field_map
            if notion_notes_field_map is not None:
                current["notion_notes_field_map"] = notion_notes_field_map
            self._write(current)
            return current
