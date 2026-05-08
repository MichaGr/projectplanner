from __future__ import annotations

import json
import os
from typing import Any

import httpx
from fastapi import FastAPI
from pydantic import BaseModel


SUPERMEMORY_API_URL = os.getenv("SUPERMEMORY_API_URL", "https://api.supermemory.ai")


class JsonRpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] | None = None


TOOLS = [
    {
        "name": "search_memories",
        "title": "Search Memories",
        "description": "Search Supermemory memories with project scoping.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "search_documents",
        "title": "Search Documents",
        "description": "Search Supermemory hybrid memory and document context.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
    {
        "name": "store_memory",
        "title": "Store Memory",
        "description": "Persist a governed memory item in Supermemory.",
        "inputSchema": {"type": "object", "properties": {"content": {"type": "string"}}, "required": ["content"]},
    },
    {
        "name": "consolidate_project_memories",
        "title": "Consolidate Project Memories",
        "description": "Retrieve project memories and produce a duplicate/staleness summary.",
        "inputSchema": {"type": "object", "properties": {"projectId": {"type": "string"}}, "required": ["projectId"]},
    },
]


def jsonrpc_result(request_id: str | int | None, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def jsonrpc_error(request_id: str | int | None, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def auth_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


async def post_json(url: str, payload: dict[str, Any], headers: dict[str, str]) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()
        return response.json()


async def search_memories(arguments: dict[str, Any]) -> Any:
    api_key = arguments.get("apiKey")
    if not api_key:
        return {"results": [], "warning": "Missing Supermemory API key."}
    container_tags = arguments.get("containerTags") or []
    payload = {
        "query": arguments["query"],
        "limit": int(arguments.get("limit", 6)),
        "filters": arguments.get("filters") or {},
    }
    if container_tags:
        payload["containerTags"] = container_tags
    data = await post_json(f"{SUPERMEMORY_API_URL.rstrip('/')}/v1/memories/search", payload, auth_headers(api_key))
    return data


async def search_documents(arguments: dict[str, Any]) -> Any:
    api_key = arguments.get("apiKey")
    if not api_key:
        return {"results": [], "warning": "Missing Supermemory API key."}
    payload = {
        "q": arguments["query"],
        "limit": int(arguments.get("limit", 6)),
        "searchMode": arguments.get("searchMode", "hybrid"),
    }
    if arguments.get("containerTag"):
        payload["containerTag"] = arguments["containerTag"]
    data = await post_json(f"{SUPERMEMORY_API_URL.rstrip('/')}/v1/search", payload, auth_headers(api_key))
    return data


async def store_memory(arguments: dict[str, Any]) -> Any:
    api_key = arguments.get("apiKey")
    if not api_key:
        return {"stored": False, "warning": "Missing Supermemory API key."}
    payload = {
        "content": arguments["content"],
        "containerTags": arguments.get("containerTags") or [],
        "metadata": arguments.get("metadata") or {},
    }
    data = await post_json(f"{SUPERMEMORY_API_URL.rstrip('/')}/v1/memories", payload, auth_headers(api_key))
    return {"stored": True, "response": data}


async def consolidate_project_memories(arguments: dict[str, Any]) -> Any:
    search_result = await search_memories(
        {
            "apiKey": arguments.get("apiKey"),
            "query": arguments.get("query", arguments["projectId"]),
            "containerTags": arguments.get("containerTags") or [],
            "filters": arguments.get("filters") or {},
            "limit": arguments.get("limit", 25),
        }
    )
    items = search_result.get("memories") or search_result.get("results") or []
    seen: set[str] = set()
    duplicates: list[str] = []
    for item in items:
        content = str(item.get("summary") or item.get("content") or "").strip().lower()
        if not content:
            continue
        if content in seen:
            duplicates.append(content)
        seen.add(content)
    return {
        "total": len(items),
        "duplicateCandidates": duplicates,
        "staleCandidates": [],
    }


app = FastAPI(title="Supermemory MCP", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "supermemory-mcp"}


@app.post("/mcp")
async def mcp(request: JsonRpcRequest):
    try:
        if request.method == "initialize":
            return jsonrpc_result(
                request.id,
                {
                    "protocolVersion": "2025-06-18",
                    "serverInfo": {"name": "supermemory-mcp", "version": "0.1.0"},
                    "capabilities": {"tools": {"listChanged": False}, "resources": {"subscribe": False, "listChanged": False}},
                },
            )
        if request.method == "tools/list":
            return jsonrpc_result(request.id, {"tools": TOOLS})
        if request.method == "tools/call":
            params = request.params or {}
            name = params["name"]
            arguments = params.get("arguments", {})
            if name == "search_memories":
                result = await search_memories(arguments)
            elif name == "search_documents":
                result = await search_documents(arguments)
            elif name == "store_memory":
                result = await store_memory(arguments)
            elif name == "consolidate_project_memories":
                result = await consolidate_project_memories(arguments)
            else:
                return jsonrpc_error(request.id, -32601, f"Unknown tool {name}.")
            return jsonrpc_result(request.id, {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result})
        if request.method == "resources/list":
            return jsonrpc_result(request.id, {"resources": []})
        if request.method == "resources/read":
            return jsonrpc_result(request.id, {"contents": []})
        return jsonrpc_error(request.id, -32601, f"Method {request.method} not implemented.")
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else str(error)
        return jsonrpc_error(request.id, -32000, detail)
    except Exception as error:
        return jsonrpc_error(request.id, -32001, str(error))
