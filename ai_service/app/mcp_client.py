from __future__ import annotations

from typing import Any

import httpx


class McpClient:
    def __init__(self, endpoint: str):
        self.endpoint = endpoint.rstrip("/")

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                self.endpoint,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {"name": name, "arguments": arguments},
                },
            )
            response.raise_for_status()
        payload = response.json()
        if payload.get("error"):
            raise RuntimeError(payload["error"]["message"])
        result = payload.get("result", {})
        return result.get("structuredContent") or {}
