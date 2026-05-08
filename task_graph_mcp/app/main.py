from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


WORKFLOW_SERVICE_URL = os.getenv("WORKFLOW_SERVICE_URL", "http://workflow-service:8000")


class JsonRpcRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: str | int | None = None
    method: str
    params: dict[str, Any] | None = None


TOOLS = [
    {
        "name": "list_projects",
        "title": "List Projects",
        "description": "List stored workflow projects.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_project_graph",
        "title": "Get Project Graph",
        "description": "Fetch the canonical graph for a project.",
        "inputSchema": {"type": "object", "properties": {"projectId": {"type": "string"}}, "required": ["projectId"]},
    },
    {
        "name": "get_project_context",
        "title": "Get Project Context",
        "description": "Fetch computed graph context for a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "projectId": {"type": "string"},
                "activeTabId": {"type": "string"},
                "selectedNodeIds": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["projectId"],
        },
    },
    {
        "name": "apply_project_operations",
        "title": "Apply Project Operations",
        "description": "Apply validated graph operations to a project.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "projectId": {"type": "string"},
                "operations": {"type": "array", "items": {"type": "object"}},
            },
            "required": ["projectId", "operations"],
        },
    },
    {
        "name": "create_proposal",
        "title": "Create Proposal",
        "description": "Persist a proposal draft against a project.",
        "inputSchema": {"type": "object", "properties": {"payload": {"type": "object"}}, "required": ["payload"]},
    },
    {
        "name": "list_proposals",
        "title": "List Proposals",
        "description": "List proposal history for a project.",
        "inputSchema": {"type": "object", "properties": {"projectId": {"type": "string"}}, "required": ["projectId"]},
    },
    {
        "name": "get_proposal",
        "title": "Get Proposal",
        "description": "Fetch one proposal by id.",
        "inputSchema": {"type": "object", "properties": {"proposalId": {"type": "string"}}, "required": ["proposalId"]},
    },
    {
        "name": "update_proposal_status",
        "title": "Update Proposal Status",
        "description": "Update proposal lifecycle status.",
        "inputSchema": {
            "type": "object",
            "properties": {"proposalId": {"type": "string"}, "status": {"type": "string"}, "actor": {"type": "string"}},
            "required": ["proposalId", "status"],
        },
    },
    {
        "name": "apply_proposal",
        "title": "Apply Proposal",
        "description": "Apply a stored proposal to the project graph.",
        "inputSchema": {
            "type": "object",
            "properties": {"proposalId": {"type": "string"}, "actor": {"type": "string"}},
            "required": ["proposalId"],
        },
    },
]


async def workflow_get(path: str, params: Any = None) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{WORKFLOW_SERVICE_URL}{path}", params=params)
        response.raise_for_status()
        return response.json()


async def workflow_post(path: str, payload: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(f"{WORKFLOW_SERVICE_URL}{path}", json=payload)
        response.raise_for_status()
        return response.json()


async def workflow_patch(path: str, payload: dict[str, Any]) -> Any:
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.patch(f"{WORKFLOW_SERVICE_URL}{path}", json=payload)
        response.raise_for_status()
        return response.json()


def jsonrpc_result(request_id: str | int | None, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def jsonrpc_error(request_id: str | int | None, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


async def call_tool(name: str, arguments: dict[str, Any]) -> Any:
    if name == "list_projects":
        return await workflow_get("/api/projects")
    if name == "get_project_graph":
        return await workflow_get(f"/api/projects/{arguments['projectId']}/graph")
    if name == "get_project_context":
        params: list[tuple[str, str]] = []
        if arguments.get("activeTabId"):
            params.append(("activeTabId", arguments["activeTabId"]))
        for node_id in arguments.get("selectedNodeIds", []):
            params.append(("selectedNodeIds", node_id))
        return await workflow_get(f"/api/projects/{arguments['projectId']}/context", params)
    if name == "apply_project_operations":
        return await workflow_post(
            f"/api/projects/{arguments['projectId']}/operations",
            {"operations": arguments.get("operations", [])},
        )
    if name == "create_proposal":
        return await workflow_post("/api/proposals", arguments["payload"])
    if name == "list_proposals":
        return await workflow_get(f"/api/projects/{arguments['projectId']}/proposals")
    if name == "get_proposal":
        return await workflow_get(f"/api/proposals/{arguments['proposalId']}")
    if name == "update_proposal_status":
        return await workflow_patch(
            f"/api/proposals/{arguments['proposalId']}",
            {"status": arguments["status"], "actor": arguments.get("actor")},
        )
    if name == "apply_proposal":
        return await workflow_post(
            f"/api/proposals/{arguments['proposalId']}/apply",
            {"actor": arguments.get("actor")},
        )
    raise HTTPException(status_code=404, detail=f"Unknown tool {name}.")


async def list_resources() -> list[dict[str, Any]]:
    projects = await workflow_get("/api/projects")
    resources = [
        {
            "uri": "taskgraph://projects",
            "name": "Projects",
            "title": "Stored Projects",
            "description": "All workflow projects.",
            "mimeType": "application/json",
        }
    ]
    for project in projects:
        project_id = project["projectId"]
        resources.extend(
            [
                {
                    "uri": f"taskgraph://projects/{project_id}/graph",
                    "name": f"{project_id} graph",
                    "title": project.get("title") or project_id,
                    "description": "Project graph snapshot.",
                    "mimeType": "application/json",
                },
                {
                    "uri": f"taskgraph://projects/{project_id}/proposals",
                    "name": f"{project_id} proposals",
                    "title": f"{project.get('title') or project_id} proposals",
                    "description": "Proposal history.",
                    "mimeType": "application/json",
                },
            ]
        )
    return resources


async def read_resource(uri: str) -> Any:
    parsed = urlparse(uri)
    path = parsed.path.strip("/")
    if parsed.netloc == "projects" and not path:
        return await workflow_get("/api/projects")
    if parsed.netloc == "projects" and path.endswith("/graph"):
        project_id = path.removesuffix("/graph")
        return await workflow_get(f"/api/projects/{project_id}/graph")
    if parsed.netloc == "projects" and path.endswith("/proposals"):
        project_id = path.removesuffix("/proposals")
        return await workflow_get(f"/api/projects/{project_id}/proposals")
    if parsed.netloc == "projects" and path.endswith("/context"):
        project_id = path.removesuffix("/context")
        query = parse_qs(parsed.query)
        params = {"activeTabId": query.get("activeTabId", [None])[0], "selectedNodeIds": query.get("selectedNodeIds", [])}
        return await workflow_get(f"/api/projects/{project_id}/context", params)
    raise HTTPException(status_code=404, detail=f"Unknown resource URI {uri}.")


app = FastAPI(title="Task Graph MCP", version="0.1.0")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "task-graph-mcp"}


@app.post("/mcp")
async def mcp(request: JsonRpcRequest):
    try:
        if request.method == "initialize":
            return jsonrpc_result(
                request.id,
                {
                    "protocolVersion": "2025-06-18",
                    "serverInfo": {"name": "task-graph-mcp", "version": "0.1.0"},
                    "capabilities": {
                        "tools": {"listChanged": False},
                        "resources": {"subscribe": False, "listChanged": False},
                    },
                },
            )
        if request.method == "tools/list":
            return jsonrpc_result(request.id, {"tools": TOOLS})
        if request.method == "tools/call":
            params = request.params or {}
            result = await call_tool(params["name"], params.get("arguments", {}))
            return jsonrpc_result(request.id, {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result})
        if request.method == "resources/list":
            return jsonrpc_result(request.id, {"resources": await list_resources()})
        if request.method == "resources/read":
            params = request.params or {}
            result = await read_resource(params["uri"])
            return jsonrpc_result(
                request.id,
                {"contents": [{"uri": params["uri"], "mimeType": "application/json", "text": json.dumps(result)}]},
            )
        return jsonrpc_error(request.id, -32601, f"Method {request.method} not implemented.")
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else str(error)
        return jsonrpc_error(request.id, -32000, detail)
    except Exception as error:
        return jsonrpc_error(request.id, -32001, str(error))
