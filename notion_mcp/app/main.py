from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI
from pydantic import BaseModel


NOTION_API_URL = os.getenv("NOTION_API_URL", "https://api.notion.com/v1")
NOTION_VERSION = os.getenv("NOTION_VERSION", "2025-09-03")


class JsonRpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] | None = None


TOOLS = [
    {
        "name": "search_pages",
        "title": "Search Pages",
        "description": "Search Notion pages and data sources.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "retrieve_page",
        "title": "Retrieve Page",
        "description": "Fetch a Notion page by id.",
        "inputSchema": {"type": "object", "properties": {"pageId": {"type": "string"}}, "required": ["pageId"]},
    },
    {
        "name": "query_data_source",
        "title": "Query Data Source",
        "description": "Query a Notion data source.",
        "inputSchema": {"type": "object", "properties": {"dataSourceId": {"type": "string"}}, "required": ["dataSourceId"]},
    },
    {
        "name": "create_page",
        "title": "Create Page",
        "description": "Create a Notion page for approved output.",
        "inputSchema": {"type": "object", "properties": {"payload": {"type": "object"}}, "required": ["payload"]},
    },
    {
        "name": "append_block_children",
        "title": "Append Block Children",
        "description": "Append blocks to an existing Notion page or block.",
        "inputSchema": {
            "type": "object",
            "properties": {"blockId": {"type": "string"}, "payload": {"type": "object"}},
            "required": ["blockId", "payload"],
        },
    },
]


def jsonrpc_result(request_id: str | int | None, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def jsonrpc_error(request_id: str | int | None, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def notion_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


async def notion_post(path: str, payload: dict[str, Any], api_key: str) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{NOTION_API_URL.rstrip('/')}{path}", json=payload, headers=notion_headers(api_key))
        response.raise_for_status()
        return response.json()


async def notion_get(path: str, api_key: str) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{NOTION_API_URL.rstrip('/')}{path}", headers=notion_headers(api_key))
        response.raise_for_status()
        return response.json()


app = FastAPI(title="Notion MCP", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "notion-mcp"}


@app.post("/mcp")
async def mcp(request: JsonRpcRequest):
    try:
        if request.method == "initialize":
            return jsonrpc_result(
                request.id,
                {
                    "protocolVersion": "2025-06-18",
                    "serverInfo": {"name": "notion-mcp", "version": "0.1.0"},
                    "capabilities": {"tools": {"listChanged": False}, "resources": {"subscribe": False, "listChanged": False}},
                },
            )
        if request.method == "tools/list":
            return jsonrpc_result(request.id, {"tools": TOOLS})
        if request.method != "tools/call":
            if request.method == "resources/list":
                return jsonrpc_result(request.id, {"resources": []})
            if request.method == "resources/read":
                return jsonrpc_result(request.id, {"contents": []})
            return jsonrpc_error(request.id, -32601, f"Method {request.method} not implemented.")

        params = request.params or {}
        name = params["name"]
        arguments = params.get("arguments", {})
        api_key = arguments.get("apiKey")
        if not api_key:
            result = {"warning": "Missing Notion API key."}
        elif name == "search_pages":
            result = await notion_post("/search", {"query": arguments["query"]}, api_key)
        elif name == "retrieve_page":
            result = await notion_get(f"/pages/{arguments['pageId']}", api_key)
        elif name == "query_data_source":
            result = await notion_post(f"/data_sources/{arguments['dataSourceId']}/query", arguments.get("payload") or {}, api_key)
        elif name == "create_page":
            result = await notion_post("/pages", arguments["payload"], api_key)
        elif name == "append_block_children":
            result = await notion_post(f"/blocks/{arguments['blockId']}/children", arguments["payload"], api_key)
        else:
            return jsonrpc_error(request.id, -32601, f"Unknown tool {name}.")
        return jsonrpc_result(request.id, {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result})
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else str(error)
        return jsonrpc_error(request.id, -32000, detail)
    except Exception as error:
        return jsonrpc_error(request.id, -32001, str(error))
