from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import httpx

NOTION_VERSION = "2026-03-11"


def normalize_database_id(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Database ID cannot be empty.")
    if cleaned.startswith("https://"):
        match = re.search(r"([a-f0-9]{32})", cleaned.replace("-", "").lower())
        if match:
            cleaned = match.group(1)
        else:
            cleaned = cleaned.rstrip("/").split("/")[-1].split("?")[0]
    return cleaned.replace("-", "")


@dataclass
class NotionClient:
    token: str

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, *, json: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"https://api.notion.com/v1{path}"
        try:
            response = httpx.request(method, url, headers=self._headers(), json=json, timeout=15.0)
        except httpx.HTTPError as error:
            raise RuntimeError(f"Could not reach Notion: {error}") from error

        if response.status_code >= 400:
            try:
                payload = response.json()
                message = payload.get("message") or payload.get("code") or response.text
            except Exception:
                message = response.text
            raise RuntimeError(f"Notion request failed: {message}")

        return response.json()

    def retrieve_database(self, database_id: str) -> dict[str, Any]:
        return self._request("GET", f"/databases/{normalize_database_id(database_id)}")

    def retrieve_data_source(self, data_source_id: str) -> dict[str, Any]:
        return self._request("GET", f"/data_sources/{normalize_database_id(data_source_id)}")

    def query_data_source(
        self,
        data_source_id: str,
        *,
        filter_payload: dict[str, Any] | None = None,
        page_size: int = 10,
        start_cursor: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"page_size": page_size}
        if filter_payload:
            payload["filter"] = filter_payload
        if start_cursor:
            payload["start_cursor"] = start_cursor
        return self._request("POST", f"/data_sources/{normalize_database_id(data_source_id)}/query", json=payload)

    def retrieve_block_children(self, block_id: str, *, page_size: int = 50) -> dict[str, Any]:
        return self._request("GET", f"/blocks/{block_id}/children?page_size={page_size}")

    def create_page(self, *, parent_database_id: str, properties: dict[str, Any], children: list[dict[str, Any]]) -> dict[str, Any]:
        payload = {
            "parent": {"data_source_id": normalize_database_id(parent_database_id)},
            "properties": properties,
            "children": children,
        }
        return self._request("POST", "/pages", json=payload)
