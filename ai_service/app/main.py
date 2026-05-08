from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from openai import OpenAI
from pydantic import BaseModel, Field

from .context_assembly import assemble_context_bundle, score_context_bundle
from .mcp_client import McpClient
from .memory_policy import classify_memory


OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4")
TASK_GRAPH_MCP_URL = os.getenv("TASK_GRAPH_MCP_URL", "http://task-graph-mcp:8010/mcp")
SUPERMEMORY_MCP_URL = os.getenv("SUPERMEMORY_MCP_URL", "http://supermemory-mcp:8011/mcp")
NOTION_MCP_URL = os.getenv("NOTION_MCP_URL", "http://notion-mcp:8012/mcp")

MAX_PROPOSAL_TASKS = 5
MAX_PROPOSAL_EDGES = 8
MIN_PLANNING_SCORE = 0.5


class UiContextPayload(BaseModel):
    activeTabId: str = "main"
    selectedNodeIds: list[str] = Field(default_factory=list)
    visibleNodeIds: list[str] = Field(default_factory=list)


class AiRequestSettings(BaseModel):
    openaiApiKey: str | None = None
    supermemoryApiKey: str | None = None
    notionApiKey: str | None = None
    taskGraphMcpUrl: str | None = None
    supermemoryMcpUrl: str | None = None
    notionMcpUrl: str | None = None


class ChatRequest(BaseModel):
    projectId: str
    message: str
    uiContext: UiContextPayload
    settings: AiRequestSettings | None = None


class ApplyProposalRequest(BaseModel):
    settings: AiRequestSettings | None = None
    actor: str | None = None


class ConsolidateMemoryRequest(BaseModel):
    projectId: str
    settings: AiRequestSettings | None = None


class NotionWritebackRequest(BaseModel):
    action: Literal["create_page", "append_block_children"]
    payload: dict[str, Any]
    blockId: str | None = None
    settings: AiRequestSettings | None = None


class GraphOperationEnvelope(BaseModel):
    type: str
    project: dict[str, Any] | None = None
    targetType: str | None = None
    targetId: str | None = None
    fields: dict[str, Any] | None = None
    group: dict[str, Any] | None = None
    tasks: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None


class ProposalPayload(BaseModel):
    proposalId: str
    intent: str
    mode: str
    workflow: str
    summary: str
    rationale: str
    graphOperations: list[GraphOperationEnvelope]
    touchedNodeIds: list[str] = Field(default_factory=list)
    memoryInsight: str | None = None
    diff: dict[str, Any] = Field(default_factory=dict)
    status: str = "draft"


class ChatResponse(BaseModel):
    projectId: str
    intent: str
    mode: str
    workflow: str
    contextScore: float
    contextBundle: list[dict[str, Any]]
    needsClarification: bool
    clarificationQuestion: str | None = None
    response: str
    graphContext: dict[str, Any]
    memoryContext: list[dict[str, Any]]
    notionContext: list[dict[str, Any]]
    proposal: ProposalPayload | None = None


class ApplyProposalResponse(BaseModel):
    proposalId: str
    projectId: str
    project: dict[str, Any]
    appliedAt: str
    proposal: ProposalPayload
    memoryPolicy: dict[str, Any]


class ConsolidateMemoryResponse(BaseModel):
    projectId: str
    summary: dict[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def uid(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:8]}"


def infer_intent_mode_workflow(message: str) -> tuple[str, str, str]:
    normalized = message.strip().lower()
    if any(keyword in normalized for keyword in ["reflect", "reflection", "architecture", "bottleneck"]):
        return "reflect", "analyze", "reflection"
    if any(keyword in normalized for keyword in ["knowledge", "docs", "document", "notion", "notes"]):
        return "knowledge_lookup", "knowledge", "knowledge"
    if any(keyword in normalized for keyword in ["memory", "remember", "consolidate"]):
        return "memory_action", "memory", "memory"
    if any(keyword in normalized for keyword in ["plan", "break down", "create", "add", "tasks", "subtasks", "decompose"]):
        return "create_tasks", "plan", "planning"
    if any(keyword in normalized for keyword in ["rename", "change", "update", "edit", "revise"]):
        return "update_task", "update", "planning"
    if any(keyword in normalized for keyword in ["what", "show", "status", "blocked", "available", "next"]):
        return "query_state", "query", "planning"
    return "discuss", "chat", "planning"


def llm_client(api_key_override: str | None = None) -> OpenAI | None:
    api_key = api_key_override or OPENAI_API_KEY
    if not api_key:
        return None
    return OpenAI(api_key=api_key)


def maybe_polish_response(
    workflow: str,
    message: str,
    graph_context: dict[str, Any],
    context_bundle: list[dict[str, Any]],
    draft_response: str,
    openai_api_key: str | None = None,
) -> str:
    client = llm_client(openai_api_key)
    if client is None:
        return draft_response

    system_prompt = (
        "You are a concise project planning assistant inside a graph workflow tool. "
        "Respond clearly, stay grounded in the provided context, and mention when a proposal is waiting for approval."
    )
    user_prompt = json.dumps(
        {
            "workflow": workflow,
            "message": message,
            "graph_summary": graph_context.get("summaries", {}),
            "context_bundle": context_bundle[:5],
            "draft_response": draft_response,
        }
    )
    try:
        completion = client.responses.create(
            model=OPENAI_MODEL,
            input=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        return completion.output_text.strip() or draft_response
    except Exception:
        return draft_response


def next_position(nodes: list[dict[str, Any]], parent_id: str | None) -> dict[str, float]:
    siblings = [node for node in nodes if node.get("parentId") == parent_id]
    return {"x": 90 + (len(siblings) % 4) * 120, "y": 110 + (len(siblings) // 4) * 120}


def build_task(title: str, parent_id: str | None, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": uid("task"),
        "kind": "task",
        "title": title,
        "status": "todo",
        "position": next_position(nodes, parent_id),
        "description": "",
        "completionCriteria": "",
        "tags": [],
        "conceptId": None,
        "externalRefs": [],
        "sourceKind": "ai-generated",
        "parentId": parent_id,
    }


def create_plan_titles(message: str, anchor_title: str | None) -> list[str]:
    stem = anchor_title or re.sub(r"\s+", " ", message.strip())[:48] or "workstream"
    return [f"Research {stem}", f"Define {stem} approach", f"Implement {stem}"]


def build_query_response(graph_context: dict[str, Any], ui_context: dict[str, Any]) -> str:
    available = graph_context.get("availableTasksGlobal", [])
    summaries = graph_context.get("summaries", {})
    selected_nodes = ui_context.get("selectedNodes", [])
    lines: list[str] = []
    if selected_nodes:
        selected = ", ".join(node["title"] for node in selected_nodes)
        lines.append(f"You’re currently focused on {selected}.")
    if available:
        preview = ", ".join(task["title"] for task in available[:3])
        lines.append(f"Available now: {preview}.")
    critical = summaries.get("criticalPathCandidates", [])
    if critical:
        lines.append(f"Deepest unfinished dependency chain currently runs through {critical[0]['title']}.")
    missing = summaries.get("itemsMissingDetails", [])
    if missing:
        lines.append(f"{len(missing)} items are missing description or completion criteria, which could limit planning quality.")
    return " ".join(lines) or "The workflow is loaded and ready, but I need a bit more direction on what you want to inspect."


def use_client(default_url: str, override: str | None) -> McpClient:
    return McpClient(override or default_url)


async def fetch_graph_context(project_id: str, ui_context: dict[str, Any], settings: AiRequestSettings) -> dict[str, Any]:
    client = use_client(TASK_GRAPH_MCP_URL, settings.taskGraphMcpUrl)
    return await client.call_tool(
        "get_project_context",
        {
            "projectId": project_id,
            "activeTabId": ui_context.get("activeTabId", "main"),
            "selectedNodeIds": ui_context.get("selectedNodeIds", []),
        },
    )


async def fetch_memory_context(project_id: str, message: str, graph_context: dict[str, Any], settings: AiRequestSettings) -> list[dict[str, Any]]:
    client = use_client(SUPERMEMORY_MCP_URL, settings.supermemoryMcpUrl)
    memory_scope = graph_context.get("graphContext", {}).get("root", {}).get("memoryScope", {})
    result = await client.call_tool(
        "search_memories",
        {
            "apiKey": settings.supermemoryApiKey,
            "query": message,
            "containerTags": memory_scope.get("containerTags", []),
            "filters": memory_scope.get("metadataDefaults", {}),
            "limit": memory_scope.get("retrievalDefaults", {}).get("limit", 6),
        },
    )
    items = result.get("memories") or result.get("results") or []
    return [item for item in items if isinstance(item, dict)]


async def fetch_notion_context(message: str, settings: AiRequestSettings) -> list[dict[str, Any]]:
    if not settings.notionApiKey:
        return []
    client = use_client(NOTION_MCP_URL, settings.notionMcpUrl)
    result = await client.call_tool("search_pages", {"apiKey": settings.notionApiKey, "query": message})
    items = result.get("results") or []
    return [item for item in items if isinstance(item, dict)]


async def persist_proposal(project_id: str, proposal: dict[str, Any], settings: AiRequestSettings) -> dict[str, Any]:
    client = use_client(TASK_GRAPH_MCP_URL, settings.taskGraphMcpUrl)
    return await client.call_tool("create_proposal", {"payload": {"projectId": project_id, **proposal}})


async def apply_stored_proposal(proposal_id: str, actor: str | None, settings: AiRequestSettings) -> dict[str, Any]:
    client = use_client(TASK_GRAPH_MCP_URL, settings.taskGraphMcpUrl)
    return await client.call_tool("apply_proposal", {"proposalId": proposal_id, "actor": actor})


def build_planning_proposal(
    intent: str,
    workflow_context: dict[str, Any],
    ui_context: dict[str, Any],
    message: str,
    context_score: float,
) -> tuple[dict[str, Any] | None, str, bool, str | None]:
    graph_context = workflow_context["graphContext"]
    snapshot = workflow_context["project"]
    selected_nodes = {node["id"]: node for node in graph_context.get("nodeInventory", []) if node["id"] in ui_context.get("selectedNodeIds", [])}
    selected_group = next((node for node in selected_nodes.values() if node["kind"] == "group"), None)
    selected_task = next((node for node in selected_nodes.values() if node["kind"] == "task"), None)

    needs_clarification = False
    clarification: str | None = None
    if intent in {"create_tasks", "update_task"} and context_score < MIN_PLANNING_SCORE:
        needs_clarification = True
        clarification = "What is the one concrete outcome or deliverable you want this part of the graph to achieve?"
    elif intent == "update_task" and not selected_nodes:
        needs_clarification = True
        clarification = "Which node should I update? Select a node or mention its title."

    if intent == "query_state":
        return None, build_query_response(graph_context, workflow_context["uiContext"]), needs_clarification, clarification

    if intent == "create_tasks":
        parent_id = selected_group["id"] if selected_group else selected_task.get("parentId") if selected_task else None
        anchor_title = selected_group["title"] if selected_group else selected_task["title"] if selected_task else None
        titles = create_plan_titles(message, anchor_title)[:MAX_PROPOSAL_TASKS]
        created_tasks: list[dict[str, Any]] = []
        for title in titles:
            task = build_task(title, parent_id, snapshot["nodes"])
            snapshot["nodes"].append(task)
            created_tasks.append(task)
        created_edges: list[dict[str, Any]] = []
        if selected_task:
            for task in created_tasks:
                created_edges.append({"id": uid("edge"), "source": task["id"], "target": selected_task["id"]})
        else:
            for index in range(min(len(created_tasks) - 1, MAX_PROPOSAL_EDGES)):
                created_edges.append({"id": uid("edge"), "source": created_tasks[index]["id"], "target": created_tasks[index + 1]["id"]})

        operations: list[dict[str, Any]] = [{"type": "create_tasks", "tasks": created_tasks}]
        if created_edges:
            operations.append({"type": "create_edges", "edges": created_edges})
        touched_node_ids = [task["id"] for task in created_tasks]
        if selected_task:
            touched_node_ids.append(selected_task["id"])
        proposal = {
            "proposalId": uid("proposal"),
            "intent": intent,
            "mode": "plan",
            "workflow": "planning",
            "summary": f"Drafted {len(created_tasks)} tasks for {anchor_title or graph_context['root']['title']}.",
            "rationale": "I used the current graph scope, selected focus, and graph validation rules to create a reviewable operation bundle.",
            "graphOperations": operations,
            "touchedNodeIds": touched_node_ids,
            "memoryInsight": f"Planning draft created around {anchor_title or graph_context['root']['title']}.",
        }
        response = proposal["summary"]
        if needs_clarification and clarification:
            response = f"{response} Before you apply it, {clarification}"
        return proposal, response, needs_clarification, clarification

    if intent == "update_task":
        target = selected_group or selected_task
        if target:
            rename_match = re.search(r"(?:rename|change).+?to ['\"]?([^'\"]+)['\"]?$", message, flags=re.IGNORECASE)
            fields: dict[str, Any]
            if rename_match:
                fields = {"title": rename_match.group(1).strip()}
                summary = f"Drafted a rename for {target['title']}."
            else:
                fields = {"description": message.strip()}
                summary = f"Drafted a description update for {target['title']}."
            proposal = {
                "proposalId": uid("proposal"),
                "intent": intent,
                "mode": "update",
                "workflow": "planning",
                "summary": summary,
                "rationale": "The update is packaged as a small graph operation so it stays reviewable and backend-validated.",
                "graphOperations": [{"type": "update_node_fields", "targetType": "node", "targetId": target["id"], "fields": fields}],
                "touchedNodeIds": [target["id"]],
                "memoryInsight": f"Decision recorded for {target['title']}: {summary}",
            }
            return proposal, summary, needs_clarification, clarification

    return None, "I reviewed the graph and context. I can help refine structure, explain blockers, or draft a proposal once you point me at a specific workstream.", needs_clarification, clarification


def build_reflection_response(context_bundle: list[dict[str, Any]], graph_context: dict[str, Any]) -> str:
    critical = graph_context.get("summaries", {}).get("criticalPathCandidates", [])
    empty_groups = graph_context.get("summaries", {}).get("emptyGroups", [])
    missing = graph_context.get("summaries", {}).get("itemsMissingDetails", [])
    parts = ["Reflection mode is active."]
    if critical:
        parts.append(f"The graph currently concentrates risk around {critical[0]['title']}.")
    if empty_groups:
        parts.append(f"There are {len(empty_groups)} empty groups that may indicate unresolved decomposition.")
    if missing:
        parts.append(f"{len(missing)} items still lack description or completion criteria.")
    if any(item["source"] == "notion" for item in context_bundle):
        parts.append("Notion knowledge was included in this reflection.")
    return " ".join(parts)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield


app = FastAPI(title="Project Planner AI Service", version="0.2.0", lifespan=lifespan)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "ai-service"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest):
    settings = payload.settings or AiRequestSettings()
    intent, mode, workflow = infer_intent_mode_workflow(payload.message)

    try:
        workflow_context = await fetch_graph_context(payload.projectId, payload.uiContext.model_dump(), settings)
        memory_context = await fetch_memory_context(payload.projectId, payload.message, workflow_context, settings)
        notion_context = await fetch_notion_context(payload.message, settings) if workflow in {"knowledge", "reflection"} else []
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else "Could not resolve workflow context."
        raise HTTPException(status_code=502, detail=detail) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    context_bundle = assemble_context_bundle(workflow_context, memory_context, notion_context, workflow)
    context_score = score_context_bundle(
        workflow_context["graphContext"],
        memory_context,
        notion_context,
        payload.uiContext.selectedNodeIds,
        payload.message,
    )

    proposal_payload: dict[str, Any] | None = None
    needs_clarification = False
    clarification: str | None = None
    if workflow == "reflection":
        response = build_reflection_response(context_bundle, workflow_context["graphContext"])
    elif workflow == "knowledge":
        response = "Knowledge workflow is active. I searched project graph context and any connected Notion knowledge sources to ground the response."
    elif workflow == "memory":
        response = "Memory workflow is active. I can consolidate project memory from the UI when you ask me to run consolidation."
    else:
        proposal_payload, response, needs_clarification, clarification = build_planning_proposal(
            intent,
            workflow_context,
            payload.uiContext.model_dump(),
            payload.message,
            context_score,
        )

    persisted_proposal: ProposalPayload | None = None
    if proposal_payload is not None:
        stored = await persist_proposal(payload.projectId, proposal_payload, settings)
        persisted_proposal = ProposalPayload.model_validate(stored)

    response = maybe_polish_response(
        workflow,
        payload.message,
        workflow_context["graphContext"],
        context_bundle,
        response,
        settings.openaiApiKey,
    )

    return ChatResponse(
        projectId=payload.projectId,
        intent=intent,
        mode=mode,
        workflow=workflow,
        contextScore=context_score,
        contextBundle=context_bundle,
        needsClarification=needs_clarification,
        clarificationQuestion=clarification,
        response=response,
        graphContext=workflow_context["graphContext"],
        memoryContext=memory_context,
        notionContext=notion_context,
        proposal=persisted_proposal,
    )


@app.post("/api/chat/proposals/{proposal_id}/apply", response_model=ApplyProposalResponse)
async def apply_proposal(proposal_id: str, payload: ApplyProposalRequest):
    settings = payload.settings or AiRequestSettings()
    try:
        applied = await apply_stored_proposal(proposal_id, payload.actor, settings)
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else "Could not apply proposal."
        raise HTTPException(status_code=502, detail=detail) from error
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

    proposal = ProposalPayload.model_validate(applied["proposal"])
    policy = classify_memory(proposal.workflow, proposal.intent, "applied", proposal.memoryInsight or proposal.summary)
    if policy["shouldStore"]:
        client = use_client(SUPERMEMORY_MCP_URL, settings.supermemoryMcpUrl)
        graph_root = applied["project"]["root"]
        memory_scope = graph_root.get("memoryScope", {})
        metadata = {
            "projectId": applied["projectId"],
            "category": policy["category"],
            "confidence": policy["confidence"],
            "touchedNodeIds": proposal.touchedNodeIds,
            "conceptIds": [graph_root.get("conceptId"), *[node.get("conceptId") for node in applied["project"].get("nodes", []) if node.get("id") in proposal.touchedNodeIds and node.get("conceptId")]],
        }
        await client.call_tool(
            "store_memory",
            {
                "apiKey": settings.supermemoryApiKey,
                "content": proposal.memoryInsight or proposal.summary,
                "containerTags": memory_scope.get("containerTags", []),
                "metadata": metadata,
            },
        )

    return ApplyProposalResponse(
        proposalId=proposal_id,
        projectId=applied["projectId"],
        project=applied["project"],
        appliedAt=utc_now(),
        proposal=proposal,
        memoryPolicy=policy,
    )


@app.post("/api/memory/consolidate", response_model=ConsolidateMemoryResponse)
async def consolidate_memory(payload: ConsolidateMemoryRequest):
    settings = payload.settings or AiRequestSettings()
    try:
        workflow_context = await fetch_graph_context(payload.projectId, {"activeTabId": "main", "selectedNodeIds": []}, settings)
        client = use_client(SUPERMEMORY_MCP_URL, settings.supermemoryMcpUrl)
        memory_scope = workflow_context["graphContext"]["root"].get("memoryScope", {})
        summary = await client.call_tool(
            "consolidate_project_memories",
            {
                "apiKey": settings.supermemoryApiKey,
                "projectId": payload.projectId,
                "containerTags": memory_scope.get("containerTags", []),
                "filters": memory_scope.get("metadataDefaults", {}),
            },
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return ConsolidateMemoryResponse(projectId=payload.projectId, summary=summary)


@app.post("/api/notion/writeback")
async def notion_writeback(payload: NotionWritebackRequest):
    settings = payload.settings or AiRequestSettings()
    client = use_client(NOTION_MCP_URL, settings.notionMcpUrl)
    try:
        if payload.action == "create_page":
            result = await client.call_tool("create_page", {"apiKey": settings.notionApiKey, "payload": payload.payload})
        else:
            result = await client.call_tool(
                "append_block_children",
                {"apiKey": settings.notionApiKey, "blockId": payload.blockId, "payload": payload.payload},
            )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"status": "ok", "result": result}
