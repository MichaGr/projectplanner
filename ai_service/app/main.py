from __future__ import annotations

import json
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal, NotRequired, TypedDict
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from langgraph.graph import END, StateGraph
from openai import OpenAI
from pydantic import BaseModel, Field


WORKFLOW_SERVICE_URL = os.getenv("WORKFLOW_SERVICE_URL", "http://workflow-service:8000")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4")
SUPERMEMORY_API_URL = os.getenv("SUPERMEMORY_API_URL", "https://api.supermemory.ai")
SUPERMEMORY_API_KEY = os.getenv("SUPERMEMORY_API_KEY")


class UiContextPayload(BaseModel):
    activeTabId: str = "main"
    selectedNodeIds: list[str] = Field(default_factory=list)
    visibleNodeIds: list[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    projectId: str
    message: str
    uiContext: UiContextPayload
    settings: dict[str, str | None] | None = None


class ApplyProposalRequest(BaseModel):
    settings: dict[str, str | None] | None = None


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
    summary: str
    rationale: str
    graphOperations: list[GraphOperationEnvelope]
    touchedNodeIds: list[str] = Field(default_factory=list)
    memoryInsight: str | None = None


class ChatResponse(BaseModel):
    projectId: str
    intent: str
    mode: str
    contextScore: float
    needsClarification: bool
    clarificationQuestion: str | None = None
    response: str
    graphContext: dict[str, Any]
    memoryContext: list[dict[str, Any]]
    proposal: ProposalPayload | None = None


class ApplyProposalResponse(BaseModel):
    proposalId: str
    projectId: str
    project: dict[str, Any]
    appliedAt: str


class StoredProposal(BaseModel):
    proposalId: str
    projectId: str
    summary: str
    graphOperations: list[GraphOperationEnvelope]
    touchedNodeIds: list[str] = Field(default_factory=list)
    memoryInsight: str | None = None
    createdAt: str


class WorkflowGraphResponse(BaseModel):
    projectId: str
    project: dict[str, Any]


class WorkflowContextResponse(BaseModel):
    projectId: str
    project: dict[str, Any]
    graphVersion: int
    uiContext: dict[str, Any]
    graphContext: dict[str, Any]


class AgentState(TypedDict):
    project_id: str
    user_input: str
    ui_context: dict[str, Any]
    request_settings: dict[str, str | None]
    intent: NotRequired[str]
    mode: NotRequired[str]
    project_snapshot: NotRequired[dict[str, Any]]
    graph_context: NotRequired[dict[str, Any]]
    workflow_context: NotRequired[dict[str, Any]]
    memory_context: NotRequired[list[dict[str, Any]]]
    context_score: NotRequired[float]
    needs_clarification: NotRequired[bool]
    clarification: NotRequired[str | None]
    proposal: NotRequired[dict[str, Any] | None]
    response: NotRequired[str]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def uid(prefix: str) -> str:
    return f"{prefix}-{uuid4().hex[:8]}"


def infer_intent_and_mode(message: str) -> tuple[str, str]:
    normalized = message.strip().lower()
    if any(keyword in normalized for keyword in ["plan", "break down", "create", "add", "tasks", "subtasks", "decompose"]):
        return "create_tasks", "plan"
    if any(keyword in normalized for keyword in ["rename", "change", "update", "edit", "revise"]):
        return "update_task", "update"
    if any(keyword in normalized for keyword in ["what", "show", "status", "blocked", "available", "next"]):
        return "query_state", "query"
    return "discuss", "chat"


def summarize_memory_items(memory_items: list[dict[str, Any]]) -> str:
    if not memory_items:
        return ""
    return "\n".join(f"- {item.get('summary', item.get('content', ''))}" for item in memory_items[:6] if item.get("summary") or item.get("content"))


def validate_snapshot(snapshot: dict[str, Any]) -> None:
    nodes = snapshot.get("nodes", [])
    edges = snapshot.get("edges", [])
    node_ids = {node["id"] for node in nodes}
    if len(node_ids) != len(nodes):
        raise HTTPException(status_code=400, detail="AI proposal produced duplicate node IDs.")

    edge_ids = {edge["id"] for edge in edges}
    if len(edge_ids) != len(edges):
        raise HTTPException(status_code=400, detail="AI proposal produced duplicate edge IDs.")

    def same_scope(source_id: str, target_id: str) -> bool:
        source = next((node for node in nodes if node["id"] == source_id), None)
        target = next((node for node in nodes if node["id"] == target_id), None)
        if not source or not target:
            return False
        return source.get("parentId") == target.get("parentId")

    for node in nodes:
        parent_id = node.get("parentId")
        if parent_id and parent_id not in node_ids:
            raise HTTPException(status_code=400, detail=f"AI proposal references missing parent node {parent_id}.")

    adjacency: dict[str, list[str]] = {}
    seen_pairs: set[tuple[str, str]] = set()
    for edge in edges:
        source = edge["source"]
        target = edge["target"]
        if source not in node_ids or target not in node_ids:
            raise HTTPException(status_code=400, detail="AI proposal created an edge to a missing node.")
        if source == target:
            raise HTTPException(status_code=400, detail="AI proposal created a self-referential dependency.")
        if not same_scope(source, target):
            raise HTTPException(status_code=400, detail="AI proposal created a cross-scope dependency.")
        pair = (source, target)
        if pair in seen_pairs:
            raise HTTPException(status_code=400, detail="AI proposal created a duplicate dependency.")
        seen_pairs.add(pair)
        adjacency.setdefault(source, []).append(target)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visited:
            return
        if node_id in visiting:
            raise HTTPException(status_code=400, detail="AI proposal created a dependency cycle.")
        visiting.add(node_id)
        for next_id in adjacency.get(node_id, []):
            visit(next_id)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in node_ids:
        visit(node_id)


def title_from_message(message: str) -> str:
    cleaned = re.sub(r"\s+", " ", message.strip())
    cleaned = re.sub(r"^(please|can you|could you|help me)\s+", "", cleaned, flags=re.IGNORECASE)
    return cleaned[:60].strip() or "New workstream"


def next_position(nodes: list[dict[str, Any]], parent_id: str | None) -> dict[str, float]:
    siblings = [node for node in nodes if node.get("parentId") == parent_id]
    return {
        "x": 90 + (len(siblings) % 4) * 120,
        "y": 110 + (len(siblings) // 4) * 120,
    }


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
        "parentId": parent_id,
    }


def create_plan_titles(message: str, anchor_title: str | None) -> list[str]:
    stem = anchor_title or title_from_message(message)
    return [
        f"Research {stem}",
        f"Define {stem} approach",
        f"Implement {stem}",
    ]


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


class WorkflowServiceClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    async def fetch_context(self, project_id: str, ui_context: dict[str, Any]) -> WorkflowContextResponse:
        params: list[tuple[str, str]] = [("activeTabId", ui_context.get("activeTabId", "main"))]
        for node_id in ui_context.get("selectedNodeIds", []):
            params.append(("selectedNodeIds", node_id))
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(f"{self.base_url}/api/projects/{project_id}/context", params=params)
            response.raise_for_status()
        return WorkflowContextResponse.model_validate(response.json())

    async def apply_operations(self, project_id: str, operations: list[dict[str, Any]]) -> WorkflowGraphResponse:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                f"{self.base_url}/api/projects/{project_id}/operations",
                json={"operations": operations},
            )
            response.raise_for_status()
        return WorkflowGraphResponse.model_validate(response.json())


class SupermemoryClient:
    def __init__(self, base_url: str, api_key: str | None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    async def query(self, project_id: str, message: str, api_key_override: str | None = None) -> list[dict[str, Any]]:
        api_key = api_key_override or self.api_key
        if not api_key:
            return []
        payload = {
            "query": message,
            "filters": {"projectId": project_id},
            "limit": 6,
        }
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                response = await client.post(f"{self.base_url}/v1/memories/search", json=payload, headers=headers)
                response.raise_for_status()
            data = response.json()
        except Exception:
            return []
        items = data.get("memories") or data.get("results") or []
        return [item for item in items if isinstance(item, dict)]

    async def store(self, project_id: str, summary: str, touched_node_ids: list[str], api_key_override: str | None = None) -> None:
        api_key = api_key_override or self.api_key
        if not api_key or not summary.strip():
            return
        payload = {
            "content": summary,
            "metadata": {
                "projectId": project_id,
                "touchedNodeIds": touched_node_ids,
                "kind": "project_planner_insight",
            },
        }
        headers = {"Authorization": f"Bearer {api_key}"}
        try:
            async with httpx.AsyncClient(timeout=12.0) as client:
                response = await client.post(f"{self.base_url}/v1/memories", json=payload, headers=headers)
                response.raise_for_status()
        except Exception:
            return


def llm_client(api_key_override: str | None = None) -> OpenAI | None:
    api_key = api_key_override or OPENAI_API_KEY
    if not api_key:
        return None
    return OpenAI(api_key=api_key)


def maybe_polish_response(
    intent: str,
    message: str,
    graph_context: dict[str, Any],
    memory_context: list[dict[str, Any]],
    draft_response: str,
    openai_api_key: str | None = None,
) -> str:
    client = llm_client(openai_api_key)
    if client is None:
        return draft_response

    system_prompt = (
        "You are a concise project planning assistant inside a node-graph workflow tool. "
        "Summarize the result clearly, mention if a proposal was drafted, and avoid inventing facts."
    )
    user_prompt = json.dumps(
        {
            "intent": intent,
            "message": message,
            "graph_summary": graph_context.get("summaries", {}),
            "memory_context": memory_context[:4],
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


def detect_intent_node(state: AgentState) -> AgentState:
    intent, mode = infer_intent_and_mode(state["user_input"])
    state["intent"] = intent
    state["mode"] = mode
    return state


async def resolve_graph_context_node(state: AgentState) -> AgentState:
    workflow_client: WorkflowServiceClient = app.state.workflow_client
    context = await workflow_client.fetch_context(state["project_id"], state["ui_context"])
    state["project_snapshot"] = context.project
    state["graph_context"] = context.graphContext
    state["workflow_context"] = context.model_dump()
    return state


async def retrieve_memory_node(state: AgentState) -> AgentState:
    memory_client: SupermemoryClient = app.state.memory_client
    settings = state.get("request_settings", {})
    supermemory_api_key = settings.get("supermemoryApiKey") if isinstance(settings, dict) else None
    state["memory_context"] = await memory_client.query(state["project_id"], state["user_input"], supermemory_api_key)
    return state


def assess_context_node(state: AgentState) -> AgentState:
    graph_context = state["graph_context"]
    root_workstreams = graph_context.get("summaries", {}).get("rootWorkstreams", [])
    selected = state["ui_context"].get("selectedNodeIds", [])
    message = state["user_input"].strip()
    score = 0.35
    if root_workstreams:
        score += 0.2
    if selected:
        score += 0.2
    if state.get("memory_context"):
        score += 0.1
    if len(message.split()) >= 6:
        score += 0.15
    if graph_context.get("root", {}).get("description", "").strip():
        score += 0.1
    score = max(0.0, min(1.0, score))

    needs_clarification = False
    clarification: str | None = None
    if state["intent"] in {"create_tasks", "update_task"} and score < 0.5:
        needs_clarification = True
        clarification = "What is the one concrete outcome or deliverable you want this part of the graph to achieve?"
    elif state["intent"] == "update_task" and not selected:
        needs_clarification = True
        clarification = "Which node should I update? Select a node or mention its title."

    state["context_score"] = score
    state["needs_clarification"] = needs_clarification
    state["clarification"] = clarification
    return state


def build_replace_graph_operation(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    validate_snapshot(snapshot)
    return [{"type": "replace_graph", "project": snapshot}]


def generate_proposal_node(state: AgentState) -> AgentState:
    snapshot = json.loads(json.dumps(state["project_snapshot"]))
    graph_context = state["graph_context"]
    ui_context = state["ui_context"]
    selected_nodes = {node["id"]: node for node in graph_context.get("nodeInventory", []) if node["id"] in ui_context.get("selectedNodeIds", [])}
    selected_group = next((node for node in selected_nodes.values() if node["kind"] == "group"), None)
    selected_task = next((node for node in selected_nodes.values() if node["kind"] == "task"), None)
    proposal: dict[str, Any] | None = None

    if state["intent"] == "query_state":
        state["response"] = build_query_response(graph_context, state["workflow_context"]["uiContext"])
        state["proposal"] = None
        return state

    if state["intent"] == "create_tasks":
        parent_id = selected_group["id"] if selected_group else None
        anchor_title = selected_group["title"] if selected_group else selected_task["title"] if selected_task else None
        titles = create_plan_titles(state["user_input"], anchor_title)
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
            for index in range(len(created_tasks) - 1):
                created_edges.append({"id": uid("edge"), "source": created_tasks[index]["id"], "target": created_tasks[index + 1]["id"]})

        snapshot["edges"].extend(created_edges)
        operations = build_replace_graph_operation(snapshot)
        touched_node_ids = [task["id"] for task in created_tasks]
        if selected_task:
            touched_node_ids.append(selected_task["id"])
        proposal = {
            "proposalId": uid("proposal"),
            "intent": state["intent"],
            "mode": state["mode"],
            "summary": f"Drafted {len(created_tasks)} tasks for {anchor_title or graph_context['root']['title']}.",
            "rationale": "I used the current graph scope, selected focus, and existing dependency rules to create a reviewable draft rather than mutating the graph immediately.",
            "graphOperations": operations,
            "touchedNodeIds": touched_node_ids,
            "memoryInsight": f"User prefers iterative planning around {anchor_title or graph_context['root']['title']} with review-before-apply proposals.",
        }
        response = proposal["summary"]
        if state.get("needs_clarification") and state.get("clarification"):
            response = f"{response} Before you apply it, {state['clarification']}"
        state["proposal"] = proposal
        state["response"] = response
        return state

    if state["intent"] == "update_task":
        target = selected_group or selected_task
        if target:
            target_snapshot = next((node for node in snapshot["nodes"] if node["id"] == target["id"]), None)
            if target_snapshot is not None:
                rename_match = re.search(r"(?:rename|change).+?to ['\"]?([^'\"]+)['\"]?$", state["user_input"], flags=re.IGNORECASE)
                if rename_match:
                    target_snapshot["title"] = rename_match.group(1).strip()
                    summary = f"Drafted a rename for {target['title']}."
                else:
                    target_snapshot["description"] = state["user_input"].strip()
                    summary = f"Drafted a description update for {target['title']}."
                operations = build_replace_graph_operation(snapshot)
                proposal = {
                    "proposalId": uid("proposal"),
                    "intent": state["intent"],
                    "mode": state["mode"],
                    "summary": summary,
                    "rationale": "The update is packaged as a reviewable graph replacement so the workflow backend still validates the result before it becomes source of truth.",
                    "graphOperations": operations,
                    "touchedNodeIds": [target["id"]],
                    "memoryInsight": f"Decision recorded for {target_snapshot['title']}: {summary}",
                }
                state["proposal"] = proposal
                state["response"] = summary
                return state

    state["proposal"] = None
    draft = (
        "I reviewed the graph, the current scope, and any retrieved memory. "
        "I can help refine structure, explain blockers, or draft a proposal once you point me at a specific workstream."
    )
    state["response"] = draft
    return state


def validate_proposal_node(state: AgentState) -> AgentState:
    proposal = state.get("proposal")
    if proposal:
        for operation in proposal.get("graphOperations", []):
            if operation["type"] == "replace_graph":
                validate_snapshot(operation["project"])
    return state


def respond_node(state: AgentState) -> AgentState:
    settings = state.get("request_settings", {})
    openai_api_key = settings.get("openaiApiKey") if isinstance(settings, dict) else None
    state["response"] = maybe_polish_response(
        state["intent"],
        state["user_input"],
        state["graph_context"],
        state.get("memory_context", []),
        state["response"],
        openai_api_key,
    )
    return state


def build_agent_graph():
    graph = StateGraph(AgentState)
    graph.add_node("detect_intent", detect_intent_node)
    graph.add_node("resolve_graph_context", resolve_graph_context_node)
    graph.add_node("retrieve_memory", retrieve_memory_node)
    graph.add_node("assess_context", assess_context_node)
    graph.add_node("generate_proposal", generate_proposal_node)
    graph.add_node("validate_proposal", validate_proposal_node)
    graph.add_node("respond", respond_node)
    graph.set_entry_point("detect_intent")
    graph.add_edge("detect_intent", "resolve_graph_context")
    graph.add_edge("resolve_graph_context", "retrieve_memory")
    graph.add_edge("retrieve_memory", "assess_context")
    graph.add_edge("assess_context", "generate_proposal")
    graph.add_edge("generate_proposal", "validate_proposal")
    graph.add_edge("validate_proposal", "respond")
    graph.add_edge("respond", END)
    return graph.compile()


@asynccontextmanager
async def lifespan(app_instance: FastAPI):
    app_instance.state.workflow_client = WorkflowServiceClient(WORKFLOW_SERVICE_URL)
    app_instance.state.memory_client = SupermemoryClient(SUPERMEMORY_API_URL, SUPERMEMORY_API_KEY)
    app_instance.state.agent_graph = build_agent_graph()
    app_instance.state.proposals: dict[str, StoredProposal] = {}
    yield


app = FastAPI(title="Project Planner AI Service", version="0.1.0", lifespan=lifespan)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "ai-service"}


@app.post("/api/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest):
    try:
        result = await app.state.agent_graph.ainvoke(
            {
                "project_id": payload.projectId,
                "user_input": payload.message,
                "ui_context": payload.uiContext.model_dump(),
                "request_settings": payload.settings or {},
            }
        )
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else "Could not resolve workflow context."
        raise HTTPException(status_code=502, detail=detail) from error

    proposal_payload = result.get("proposal")
    proposal_model = ProposalPayload.model_validate(proposal_payload) if proposal_payload else None
    if proposal_model is not None:
        app.state.proposals[proposal_model.proposalId] = StoredProposal(
            proposalId=proposal_model.proposalId,
            projectId=payload.projectId,
            summary=proposal_model.summary,
            graphOperations=proposal_model.graphOperations,
            touchedNodeIds=proposal_model.touchedNodeIds,
            memoryInsight=proposal_model.memoryInsight,
            createdAt=utc_now(),
        )

    return ChatResponse(
        projectId=payload.projectId,
        intent=result["intent"],
        mode=result["mode"],
        contextScore=result["context_score"],
        needsClarification=result["needs_clarification"],
        clarificationQuestion=result.get("clarification"),
        response=result["response"],
        graphContext=result["graph_context"],
        memoryContext=result.get("memory_context", []),
        proposal=proposal_model,
    )


@app.post("/api/chat/proposals/{proposal_id}/apply", response_model=ApplyProposalResponse)
async def apply_proposal(proposal_id: str, payload: ApplyProposalRequest):
    stored_proposal = app.state.proposals.get(proposal_id)
    if not stored_proposal:
        raise HTTPException(status_code=404, detail="Proposal not found or expired.")

    workflow_client: WorkflowServiceClient = app.state.workflow_client
    memory_client: SupermemoryClient = app.state.memory_client
    try:
        response = await workflow_client.apply_operations(
            stored_proposal.projectId,
            [operation.model_dump(exclude_none=True) for operation in stored_proposal.graphOperations],
        )
    except httpx.HTTPStatusError as error:
        detail = error.response.text if error.response is not None else "Could not apply proposal."
        raise HTTPException(status_code=502, detail=detail) from error

    await memory_client.store(
        stored_proposal.projectId,
        stored_proposal.memoryInsight or stored_proposal.summary,
        stored_proposal.touchedNodeIds,
        (payload.settings or {}).get("supermemoryApiKey"),
    )
    del app.state.proposals[proposal_id]

    return ApplyProposalResponse(
        proposalId=proposal_id,
        projectId=response.projectId,
        project=response.project,
        appliedAt=utc_now(),
    )
