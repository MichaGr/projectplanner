from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from ..schemas.settings import StoredSettings

MISSING = object()


class SettingsRepository:
    def __init__(self, path: str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        if not self._path.exists():
            self._write(StoredSettings())

    def _read(self) -> StoredSettings:
        with self._path.open("r", encoding="utf-8") as handle:
            return StoredSettings.model_validate(json.load(handle))

    def _write(self, payload: StoredSettings) -> None:
        with self._path.open("w", encoding="utf-8") as handle:
            json.dump(payload.model_dump(), handle, indent=2)

    def get(self) -> dict[str, Any]:
        with self._lock:
            return self._read().model_dump()

    def load(self) -> StoredSettings:
        with self._lock:
            return self._read()

    def save(self, payload: StoredSettings) -> StoredSettings:
        with self._lock:
            self._write(payload)
            return payload

    def update(
        self,
        *,
        api_key: str | None | object = MISSING,
        selected_model: str | None | object = MISSING,
        notion_token: str | None | object = MISSING,
        notion_notes_database_id: str | None | object = MISSING,
        notion_progress_database_id: str | None | object = MISSING,
        notion_use_notes_for_ai_context: bool | object = MISSING,
        notion_enable_progress_sync: bool | object = MISSING,
        notion_progress_field_map: dict[str, str | None] | object = MISSING,
        notion_notes_field_map: dict[str, str | None] | object = MISSING,
    ) -> dict[str, Any]:
        with self._lock:
            current = self._read()
            updates = {
                "api_key": api_key,
                "selected_model": selected_model,
                "notion_token": notion_token,
                "notion_notes_database_id": notion_notes_database_id,
                "notion_progress_database_id": notion_progress_database_id,
                "notion_use_notes_for_ai_context": notion_use_notes_for_ai_context,
                "notion_enable_progress_sync": notion_enable_progress_sync,
                "notion_progress_field_map": notion_progress_field_map,
                "notion_notes_field_map": notion_notes_field_map,
            }
            next_payload = current.model_copy(
                update={key: value for key, value in updates.items() if value is not MISSING}
            )
            self._write(next_payload)
            return next_payload.model_dump()
