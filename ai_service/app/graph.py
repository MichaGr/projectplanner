from __future__ import annotations

import uuid
from typing import Any, Literal, TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

from .models import (
    AIDocument,
    AIChatRequest,
    AIContextBundle,
    AINodeContextSummary,
    AIPlannerOutput,
    AIProposal,
    AIResolvedIntent,
    CreateEdgePayload,
    CreateEdgesOperation,
    CreateGroupOperation,
    CreateGroupPayload,
    CreateTaskPayload,
    CreateTasksOperation,
    PlannerEdgeRecord,
    PlannerNodeRecord,
    Position,
    Size,
    UpdateNodeFieldsOperation,
)

INTENT_LITERAL = Literal["describe_node", "define_completion_criteria", "create_nodes", "split_into_subtasks"]
MAX_CONTEXT_NODES = 5
ROUTE_MAP: dict[INTENT_LITERAL, str] = {
    "describe_node": "describe_node",
    "define_completion_criteria": "define_completion_criteria",
    "create_nodes": "create_nodes",
    "split_into_subtasks": "split_into_subtasks",
}
GRAPH_NODE_METADATA = {
    START: {
        "label": "START",
        "kind": "entry",
        "description": "Entry point for the AI orchestration flow.",
        "inputs": [],
        "outputs": ["Pass orchestration state into planner."],
    },
    "planner": {
        "label": "Planner",
        "kind": "planner",
        "description": "Builds context, resolves user intent, and prepares the planning summary.",
        "inputs": ["AI chat request", "Current graph context", "Optional uploaded documents"],
        "outputs": ["planner_output"],
    },
    "supervisor": {
        "label": "Supervisor",
        "kind": "router",
        "description": "Chooses the worker path that should handle the current request.",
        "inputs": ["planner_output"],
        "outputs": ["intent route"],
    },
    "describe_node": {
        "label": "Describe Node",
        "kind": "worker",
        "description": "Drafts a stronger node or root description.",
        "inputs": ["planner_output", "request"],
        "outputs": ["description update operation"],
    },
    "define_completion_criteria": {
        "label": "Completion Criteria",
        "kind": "worker",
        "description": "Drafts concrete completion criteria for the selected target.",
        "inputs": ["planner_output", "request"],
        "outputs": ["completion criteria update operation"],
    },
    "create_nodes": {
        "label": "Create Nodes",
        "kind": "worker",
        "description": "Creates new task proposals inside the current scope.",
        "inputs": ["planner_output", "request"],
        "outputs": ["create_tasks operation"],
    },
    "split_into_subtasks": {
        "label": "Split Into Subtasks",
        "kind": "worker",
        "description": "Builds a node-group breakdown and prerequisite edges for subtasks.",
        "inputs": ["planner_output", "request"],
        "outputs": ["create_group", "create_tasks", "create_edges"],
    },
    "proposal_formatter": {
        "label": "Proposal Formatter",
        "kind": "formatter",
        "description": "Converts worker output into the reviewable AI proposal returned to the frontend.",
        "inputs": ["worker_output", "planner_output", "request"],
        "outputs": ["proposal", "response_message"],
    },
    END: {
        "label": "END",
        "kind": "terminal",
        "description": "Terminal node that finishes orchestration after the proposal is prepared.",
        "inputs": ["proposal"],
        "outputs": [],
    },
}


class RouteDecision(BaseModel):
    intent: INTENT_LITERAL


class PlannerDecision(BaseModel):
    intent: INTENT_LITERAL
    confidence: Literal["low", "medium", "high"]
    intentSummary: str
    contextSummary: str
    questions: list[str] = Field(default_factory=list)


class DraftNode(BaseModel):
    title: str
    description: str = ""
    completionCriteria: str = ""


class DraftNodeList(BaseModel):
    summary: str
    nodes: list[DraftNode] = Field(default_factory=list)
    changePlan: list[str] = Field(default_factory=list)


class DraftDependency(BaseModel):
    sourceTitle: str
    targetTitle: str
    rationale: str = ""


class DraftSplitPlan(BaseModel):
    summary: str
    nodes: list[DraftNode] = Field(default_factory=list)
    dependencies: list[DraftDependency] = Field(default_factory=list)
    changePlan: list[str] = Field(default_factory=list)
    dependencySummary: str = ""


class DraftText(BaseModel):
    summary: str
    content: str
    changePlan: list[str] = Field(default_factory=list)


class OrchestrationState(TypedDict, total=False):
    request: AIChatRequest
    settings: dict[str, Any]
    planner_output: AIPlannerOutput
    intent: str
    worker_output: dict[str, Any]
    response_message: str
    proposal: AIProposal | None


def get_graph_visualization() -> dict[str, Any]:
    nodes = [
        {
            "id": node_id,
            "label": metadata["label"],
            "kind": metadata["kind"],
            "description": metadata["description"],
            "inputs": metadata["inputs"],
            "outputs": metadata["outputs"],
        }
        for node_id, metadata in GRAPH_NODE_METADATA.items()
    ]

    edges = [
        {"id": "start-planner", "source": START, "target": "planner", "type": "start", "label": "boot"},
        {"id": "planner-supervisor", "source": "planner", "target": "supervisor", "type": "linear", "label": "plan"},
        *[
            {
                "id": f"supervisor-{intent}",
                "source": "supervisor",
                "target": target,
                "type": "conditional",
                "label": intent,
            }
            for intent, target in ROUTE_MAP.items()
        ],
        *[
            {
                "id": f"{node_id}-formatter",
                "source": node_id,
                "target": "proposal_formatter",
                "type": "linear",
                "label": "format proposal",
            }
            for node_id in ROUTE_MAP.values()
        ],
        {"id": "formatter-end", "source": "proposal_formatter", "target": END, "type": "end", "label": "return"},
    ]

    legend = [
        {"kind": "entry", "label": "Entry / Exit", "description": "Lifecycle boundary nodes for the orchestration."},
        {"kind": "planner", "label": "Planner", "description": "Builds intent and context before routing."},
        {"kind": "router", "label": "Router", "description": "Selects the worker branch based on resolved intent."},
        {"kind": "worker", "label": "Worker", "description": "Produces the concrete planning mutation or text draft."},
        {"kind": "formatter", "label": "Formatter", "description": "Packages worker output into a proposal payload."},
        {"kind": "conditional", "label": "Conditional Edge", "description": "A branch selected by the supervisor route."},
    ]

    return {
        "version": "v1",
        "source": "langgraph",
        "nodes": nodes,
        "edges": edges,
        "legend": legend,
    }


def _coerce_request(request: AIChatRequest | dict[str, Any]) -> AIChatRequest:
    if isinstance(request, AIChatRequest):
        return request
    return AIChatRequest.model_validate(request)


def _coerce_planner_output(planner_output: AIPlannerOutput | dict[str, Any]) -> AIPlannerOutput:
    if isinstance(planner_output, AIPlannerOutput):
        return planner_output
    return AIPlannerOutput.model_validate(planner_output)


def _get_model(settings: dict[str, Any]) -> ChatOpenAI:
    api_key = settings.get("api_key")
    model_name = settings.get("selected_model") or "gpt-4.1-mini"
    if not api_key:
        raise ValueError("OpenAI API key is not configured on the backend.")
    return ChatOpenAI(api_key=api_key, model=model_name, temperature=0.2)


def _find_target_node(request: AIChatRequest) -> PlannerNodeRecord | None:
    request = _coerce_request(request)
    if not request.context.targetId:
        return None
    return next((node for node in request.project.nodes if node.id == request.context.targetId), None)


def _find_node(request: AIChatRequest, node_id: str | None) -> PlannerNodeRecord | None:
    request = _coerce_request(request)
    if not node_id:
        return None
    return next((node for node in request.project.nodes if node.id == node_id), None)


def _fallback_intent(message: str) -> str:
    lowered = message.lower()
    if "completion" in lowered or "acceptance" in lowered or "criteria" in lowered:
        return "define_completion_criteria"
    if "split" in lowered or "subtask" in lowered or "decompose" in lowered or "break down" in lowered:
        return "split_into_subtasks"
    if "create" in lowered or "add node" in lowered or "new node" in lowered or "add task" in lowered:
        return "create_nodes"
    return "describe_node"


def _resolve_parent_id(request: AIChatRequest) -> str | None:
    request = _coerce_request(request)
    target_node = _find_target_node(request)
    if request.context.targetType == "group":
        return request.context.targetId
    if request.context.targetType == "node" and target_node is not None:
        return target_node.parentId
    return None


def _next_position(request: AIChatRequest, parent_id: str | None, index: int) -> Position:
    request = _coerce_request(request)
    siblings = [node for node in request.project.nodes if node.parentId == parent_id]
    start = len(siblings) + index
    return Position(x=90 + (start % 4) * 120, y=110 + (start // 4) * 120)


def _summarize_node(node: PlannerNodeRecord, relationship: str) -> AINodeContextSummary:
    return AINodeContextSummary(
        id=node.id,
        kind=node.kind,
        title=node.title,
        parentId=node.parentId,
        description=node.description,
        completionCriteria=node.completionCriteria,
        status=node.status,
        relationship=relationship,
    )


def _incoming_edges(edges: list[PlannerEdgeRecord], node_id: str) -> list[PlannerEdgeRecord]:
    return [edge for edge in edges if edge.target == node_id]


def _neighbor_node_ids(request: AIChatRequest, target: PlannerNodeRecord) -> list[str]:
    scope_id = target.parentId
    same_scope_ids = {node.id for node in request.project.nodes if node.parentId == scope_id and node.id != target.id}
    edge_neighbor_ids = {
        edge.source if edge.target == target.id else edge.target
        for edge in request.project.edges
        if edge.source == target.id or edge.target == target.id
    }
    ordered = sorted(same_scope_ids | edge_neighbor_ids)
    return ordered[:MAX_CONTEXT_NODES]


def _build_context_bundle(request: AIChatRequest) -> AIContextBundle:
    target_node = _find_target_node(request)
    ancestor_group = _find_node(request, target_node.parentId) if target_node and target_node.parentId else None

    surrounding_nodes: list[AINodeContextSummary] = []
    blocking_nodes: list[AINodeContextSummary] = []

    if target_node:
        for neighbor_id in _neighbor_node_ids(request, target_node):
            neighbor = _find_node(request, neighbor_id)
            if neighbor:
                surrounding_nodes.append(_summarize_node(neighbor, "surrounding"))

        if target_node.kind == "task":
            for edge in _incoming_edges(request.project.edges, target_node.id)[:MAX_CONTEXT_NODES]:
                blocker = _find_node(request, edge.source)
                if blocker:
                    blocking_nodes.append(_summarize_node(blocker, "blocker"))
    elif request.context.targetType == "group" and request.context.targetId:
        scope_nodes = [
            node
            for node in request.project.nodes
            if node.parentId == request.context.targetId
        ][:MAX_CONTEXT_NODES]
        surrounding_nodes = [_summarize_node(node, "surrounding") for node in scope_nodes]

    root_summary = (
        f"Project root: {request.project.root.title}. "
        f"Root description: {request.project.root.description or '(empty)'}. "
        f"Root completion criteria: {request.project.root.completionCriteria or '(empty)'}."
    )
    scope_parts = [root_summary, f"Current focus: {request.context.targetTitle} ({request.context.targetType})."]
    if ancestor_group:
        scope_parts.append(f"Ancestor group: {ancestor_group.title}.")
    if surrounding_nodes:
        scope_parts.append(
            "Nearby scope nodes: " + ", ".join(node.title for node in surrounding_nodes[:MAX_CONTEXT_NODES]) + "."
        )
    if blocking_nodes:
        scope_parts.append(
            "Blocking predecessors: " + ", ".join(node.title for node in blocking_nodes[:MAX_CONTEXT_NODES]) + "."
        )
    if not surrounding_nodes and not blocking_nodes and request.context.targetType == "root":
        scope_parts.append(f"Root graph currently contains {len(request.project.nodes)} nodes.")

    return AIContextBundle(
        target=_summarize_node(target_node, "selected") if target_node else None,
        ancestorGroup=_summarize_node(ancestor_group, "ancestor") if ancestor_group else None,
        surroundingNodes=surrounding_nodes,
        blockingNodes=blocking_nodes,
        scopeSummary=" ".join(scope_parts),
    )


def _planner_prompt(request: AIChatRequest, context_bundle: AIContextBundle) -> str:
    lines = [
        f"User message: {request.message}",
        f"Target: {request.context.targetTitle} ({request.context.targetType})",
        f"Scope summary: {context_bundle.scopeSummary}",
    ]
    if context_bundle.target:
        lines.append(f"Selected node details: {context_bundle.target.model_dump_json()}")
    if context_bundle.ancestorGroup:
        lines.append(f"Ancestor group: {context_bundle.ancestorGroup.model_dump_json()}")
    if context_bundle.surroundingNodes:
        lines.append(
            "Surrounding nodes: " + ", ".join(node.title for node in context_bundle.surroundingNodes) + "."
        )
    if context_bundle.blockingNodes:
        lines.append(
            "Blocking nodes: " + ", ".join(node.title for node in context_bundle.blockingNodes) + "."
        )
    if request.conversation:
        lines.append(
            "Recent conversation: "
            + " | ".join(f"{message.role}: {message.content}" for message in request.conversation[-4:])
        )
    if request.documents:
        lines.append(
            "Uploaded PDFs: "
            + " | ".join(f"{document.name} ({document.pageCount} pages): {document.excerpt}" for document in request.documents)
        )
    return "\n".join(lines)


def _document_context_text(documents: list[AIDocument]) -> str:
    if not documents:
        return ""

    sections = ["Uploaded PDF context:"]
    for document in documents:
        sections.append(
            f"- {document.name} ({document.pageCount} pages)\n"
            f"Excerpt: {document.excerpt}\n"
            f"Content: {document.content}"
        )
    return "\n".join(sections)


def planner_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    context_bundle = _build_context_bundle(request)
    fallback_intent = _fallback_intent(request.message)

    try:
        llm = _get_model(state["settings"])
        decision = llm.with_structured_output(PlannerDecision).invoke(
            [
                (
                    "system",
                    "Interpret the user's goal for a project-planning assistant. "
                    "Choose exactly one intent: describe_node, define_completion_criteria, create_nodes, split_into_subtasks. "
                    "Summarize intent and context, and list only concrete open questions when the request is ambiguous. "
                    "For split_into_subtasks, explicitly think about prerequisite stages, execution order, and which work can stay parallel.",
                ),
                ("human", _planner_prompt(request, context_bundle)),
            ]
        )
        planner_output = AIPlannerOutput(
            resolvedIntent=AIResolvedIntent(
                intent=decision.intent,
                confidence=decision.confidence,
                rationale=f"Planner inferred {decision.intent} from the request and graph context.",
            ),
            intentSummary=decision.intentSummary,
            contextSummary=decision.contextSummary,
            openQuestions=decision.questions,
            contextBundle=context_bundle,
        )
    except Exception:
        planner_output = AIPlannerOutput(
            resolvedIntent=AIResolvedIntent(
                intent=fallback_intent,
                confidence="medium",
                rationale="Fallback planner intent based on the user's wording.",
            ),
            intentSummary=f"Interpreting this as {fallback_intent.replace('_', ' ')} for {request.context.targetTitle}.",
            contextSummary=context_bundle.scopeSummary,
            openQuestions=[],
            contextBundle=context_bundle,
        )

    return {"planner_output": planner_output}


def supervisor_node(state: OrchestrationState) -> OrchestrationState:
    planner_output = _coerce_planner_output(state["planner_output"])

    try:
        intent = planner_output.resolvedIntent.intent
    except Exception:
        request = _coerce_request(state["request"])
        intent = _fallback_intent(request.message)

    return {"intent": intent}


def _worker_context_text(planner_output: AIPlannerOutput) -> str:
    planner_output = _coerce_planner_output(planner_output)
    bundle = planner_output.contextBundle
    parts = [
        f"Intent summary: {planner_output.intentSummary}",
        f"Context summary: {planner_output.contextSummary}",
    ]
    if bundle.ancestorGroup:
        parts.append(f"Ancestor group: {bundle.ancestorGroup.title}")
    if bundle.surroundingNodes:
        parts.append("Surrounding nodes: " + ", ".join(node.title for node in bundle.surroundingNodes))
    if bundle.blockingNodes:
        parts.append("Blocking nodes: " + ", ".join(node.title for node in bundle.blockingNodes))
    if planner_output.openQuestions:
        parts.append("Open questions: " + " | ".join(planner_output.openQuestions))
    return "\n".join(parts)


def _resolve_draft_dependencies(
    dependencies: list[DraftDependency],
    tasks: list[CreateTaskPayload],
) -> tuple[list[CreateEdgePayload], list[str]]:
    title_to_task = {task.title.strip().casefold(): task for task in tasks}
    edges: list[CreateEdgePayload] = []
    explanations: list[str] = []
    seen_pairs: set[tuple[str, str]] = set()

    for dependency in dependencies:
        source = title_to_task.get(dependency.sourceTitle.strip().casefold())
        target = title_to_task.get(dependency.targetTitle.strip().casefold())
        if not source or not target or source.id == target.id:
            continue

        pair = (source.id, target.id)
        if pair in seen_pairs:
            continue

        seen_pairs.add(pair)
        edges.append(
            CreateEdgePayload(
                id=f"edge-{uuid.uuid4().hex[:8]}",
                source=source.id,
                target=target.id,
            )
        )

        if dependency.rationale.strip():
            explanations.append(f"{source.title} comes before {target.title}: {dependency.rationale.strip()}")
        else:
            explanations.append(f"{target.title} depends on {source.title}.")

    return edges, explanations


def describe_node_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    planner_output = _coerce_planner_output(state["planner_output"])
    target_node = _find_target_node(request)
    title = target_node.title if target_node else request.project.root.title

    try:
        llm = _get_model(state["settings"])
        draft = llm.with_structured_output(DraftText).invoke(
            [
                (
                    "system",
                    "Write one concise but specific project-planning description for the provided target. "
                    "The description must name a concrete deliverable, artifact, or outcome, not just a vague intention.",
                ),
                (
                    "human",
                    f"Target title: {title}\nUser request: {request.message}\n"
                    f"Existing description: {(target_node.description if target_node else request.project.root.description) or '(empty)'}\n"
                    f"{_worker_context_text(planner_output)}\n{_document_context_text(request.documents)}",
                ),
            ]
        )
        content = draft.content
        change_plan = draft.changePlan or [
            f"Rewrite the description for {title} to reflect the clarified goal.",
        ]
    except Exception:
        content = f"Produce a concrete deliverable for {title.lower()}, with clear scope, owner-ready boundaries, and a visible outcome."
        change_plan = [f"Strengthen the description for {title}."] 

    operation = UpdateNodeFieldsOperation(
        targetType="root" if request.context.targetType == "root" else "node",
        targetId=request.context.targetId or "root",
        fields={"description": content},
    )
    return {
        "worker_output": {
            "summary": f"Draft a stronger description for {title}.",
            "message": "Prepared a description update for review.",
            "operations": [operation],
            "change_plan": change_plan,
            "affected_targets": [title],
        }
    }


def completion_criteria_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    planner_output = _coerce_planner_output(state["planner_output"])
    target_node = _find_target_node(request)
    title = target_node.title if target_node else request.project.root.title

    try:
        llm = _get_model(state["settings"])
        draft = llm.with_structured_output(DraftText).invoke(
            [
                (
                    "system",
                    "Write concise but specific completion criteria for the provided target. "
                    "The criteria must describe a concrete deliverable or observable finished state.",
                ),
                (
                    "human",
                    f"Target title: {title}\nUser request: {request.message}\n"
                    f"Existing criteria: {(target_node.completionCriteria if target_node else request.project.root.completionCriteria) or '(empty)'}\n"
                    f"{_worker_context_text(planner_output)}\n{_document_context_text(request.documents)}",
                ),
            ]
        )
        content = draft.content
        change_plan = draft.changePlan or [f"Replace vague completion criteria on {title} with concrete checks."]
    except Exception:
        content = f"Completion is clear when {title.lower()} has a documented outcome, an owner-ready scope, and no unresolved blockers."
        change_plan = [f"Make completion criteria for {title} more specific."]

    operation = UpdateNodeFieldsOperation(
        targetType="root" if request.context.targetType == "root" else "node",
        targetId=request.context.targetId or "root",
        fields={"completionCriteria": content},
    )
    return {
        "worker_output": {
            "summary": f"Draft completion criteria for {title}.",
            "message": "Prepared completion criteria for review.",
            "operations": [operation],
            "change_plan": change_plan,
            "affected_targets": [title],
        }
    }


def create_nodes_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    planner_output = _coerce_planner_output(state["planner_output"])
    parent_id = _resolve_parent_id(request)
    target_title = request.context.targetTitle

    try:
        llm = _get_model(state["settings"])
        draft = llm.with_structured_output(DraftNodeList).invoke(
            [
                (
                    "system",
                    "Create 2 to 4 concise project-planning tasks based on the user's request and graph context. "
                    "Every task must have a clear deliverable. Return standalone task titles plus short descriptions "
                    "that name the artifact/outcome and completion criteria that describe what exists when the task is done.",
                ),
                (
                    "human",
                    f"Context title: {target_title}\nContext type: {request.context.targetType}\n"
                    f"User request: {request.message}\n{_worker_context_text(planner_output)}\n{_document_context_text(request.documents)}",
                ),
            ]
        )
        nodes = draft.nodes or [
            DraftNode(title="Define scope", description="", completionCriteria=""),
            DraftNode(title="Implement work", description="Produce the main deliverable for this work item.", completionCriteria="A concrete deliverable exists and is ready for review."),
        ]
        summary = draft.summary
        change_plan = draft.changePlan or [
            f"Add new tasks in the {target_title} context.",
            "Keep them aligned with nearby scope work and blockers.",
        ]
    except Exception:
        nodes = [
            DraftNode(
                title=f"Plan {target_title}",
                description=f"Produce a scoped execution plan for {target_title}.",
                completionCriteria="A written plan exists with scope, sequence, and owners.",
            ),
            DraftNode(
                title=f"Execute {target_title}",
                description=f"Produce the primary deliverable for {target_title}.",
                completionCriteria="The requested deliverable exists in a reviewable form.",
            ),
            DraftNode(
                title=f"Review {target_title}",
                description=f"Produce review feedback and final approval notes for {target_title}.",
                completionCriteria="Review comments are resolved and approval notes are captured.",
            ),
        ]
        summary = f"Create new tasks in the {target_title} context."
        change_plan = [summary]

    tasks = [
        CreateTaskPayload(
            id=f"task-{uuid.uuid4().hex[:8]}",
            title=node.title,
            description=node.description,
            completionCriteria=node.completionCriteria,
            parentId=parent_id,
            position=_next_position(request, parent_id, index),
            tags=[],
        )
        for index, node in enumerate(nodes)
    ]

    return {
        "worker_output": {
            "summary": summary,
            "message": f"Prepared {len(tasks)} new task proposals.",
            "operations": [CreateTasksOperation(tasks=tasks)],
            "change_plan": change_plan,
            "affected_targets": [task.title for task in tasks],
        }
    }


def split_into_subtasks_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    planner_output = _coerce_planner_output(state["planner_output"])
    target_node = _find_target_node(request)
    if not target_node or target_node.kind != "task":
        raise ValueError("Split requires a selected task node.")

    try:
        llm = _get_model(state["settings"])
        draft = llm.with_structured_output(DraftSplitPlan).invoke(
            [
                (
                    "system",
                    "Break the task into 3 to 5 meaningful subtasks for a project planner. "
                    "Every subtask must have a concrete deliverable and a completion criterion with a visible outcome. "
                    "Also return the prerequisite relationships between those subtasks as a minimal DAG: only add a dependency "
                    "when one subtask truly must finish before another can start. Bias toward setup or research tasks feeding "
                    "analysis, estimation, strategy, and final synthesis tasks. Preserve parallelism when justified.",
                ),
                (
                    "human",
                    f"Task title: {target_node.title}\nDescription: {target_node.description}\n"
                    f"User request: {request.message}\n{_worker_context_text(planner_output)}\n{_document_context_text(request.documents)}",
                ),
            ]
        )
        nodes = draft.nodes or [
            DraftNode(title="Plan subtasks"),
            DraftNode(title="Build subtasks"),
            DraftNode(title="Review subtasks"),
        ]
        summary = draft.summary
        dependency_drafts = draft.dependencies
        dependency_summary = draft.dependencySummary.strip()
        change_plan = draft.changePlan or [
            f"Create a breakdown group for {target_node.title}.",
            "Place meaningful subtasks inside the new group with clear deliverables.",
            "Add only the prerequisite edges needed to express execution order.",
            "Link the new group back to the original task as a dependency.",
        ]
    except Exception:
        nodes = [
            DraftNode(
                title=f"Scope {target_node.title}",
                description=f"Produce the scoped breakdown and delivery plan for {target_node.title}.",
                completionCriteria="A written breakdown exists with deliverables and ownership.",
            ),
            DraftNode(
                title=f"Implement {target_node.title}",
                description=f"Produce the main deliverable required for {target_node.title}.",
                completionCriteria="The main deliverable exists and is ready for review.",
            ),
            DraftNode(
                title=f"Review {target_node.title}",
                description=f"Produce review feedback and sign-off notes for {target_node.title}.",
                completionCriteria="Feedback is captured, resolved, and approval is documented.",
            ),
        ]
        summary = f"Split {target_node.title} into a new node group with subtasks."
        change_plan = [
            f"Create a breakdown group for {target_node.title}.",
            "Add subtasks beneath that group with concrete deliverables.",
            "Make implementation depend on scoping, and review depend on implementation.",
            "Connect the group to the original task.",
        ]
        dependency_drafts = [
            DraftDependency(
                sourceTitle=f"Scope {target_node.title}",
                targetTitle=f"Implement {target_node.title}",
                rationale="The main deliverable should follow the scoped breakdown and plan.",
            ),
            DraftDependency(
                sourceTitle=f"Implement {target_node.title}",
                targetTitle=f"Review {target_node.title}",
                rationale="Review starts after the main deliverable exists.",
            ),
        ]
        dependency_summary = (
            "Scoping comes first, implementation depends on the agreed plan, and review waits for a completed deliverable."
        )

    group_id = f"group-{uuid.uuid4().hex[:8]}"
    group = CreateGroupOperation(
        group=CreateGroupPayload(
            id=group_id,
            title=f"{target_node.title} breakdown",
            description=f"AI-generated decomposition for {target_node.title}.",
            completionCriteria="All proposed subtasks are complete and ready to support the parent task.",
            parentId=target_node.parentId,
            position=Position(x=target_node.position.x + 80, y=target_node.position.y + 80),
            tags=target_node.tags,
            size=Size(width=320, height=170),
        )
    )

    tasks = CreateTasksOperation(
        tasks=[
            CreateTaskPayload(
                id=f"task-{uuid.uuid4().hex[:8]}",
                title=node.title,
                description=node.description,
                completionCriteria=node.completionCriteria,
                parentId=group_id,
                position=Position(x=80 + index * 110, y=120),
                tags=target_node.tags,
            )
            for index, node in enumerate(nodes)
        ]
    )

    child_edges, child_edge_explanations = _resolve_draft_dependencies(dependency_drafts, tasks.tasks)
    dependency = CreateEdgesOperation(
        edges=[
            CreateEdgePayload(
                id=f"edge-{uuid.uuid4().hex[:8]}",
                source=group_id,
                target=target_node.id,
            ),
            *child_edges,
        ]
    )

    combined_change_plan = list(change_plan)
    if dependency_summary:
        combined_change_plan.append(dependency_summary)
    combined_change_plan.extend(child_edge_explanations)

    return {
        "worker_output": {
            "summary": summary,
            "message": "Prepared a new node group plus subtasks for review.",
            "operations": [group, tasks, dependency],
            "change_plan": combined_change_plan,
            "affected_targets": [target_node.title, group.group.title, *[task.title for task in tasks.tasks]],
        }
    }


def _describe_affected_targets(operations: list[Any], request: AIChatRequest) -> list[str]:
    labels: list[str] = []
    for operation in operations:
        if operation.type == "update_node_fields":
            labels.append(request.context.targetTitle if operation.targetType == "root" else operation.targetId)
        elif operation.type == "create_group":
            labels.append(operation.group.title)
        elif operation.type == "create_tasks":
            labels.extend(task.title for task in operation.tasks)
        elif operation.type == "create_edges":
            labels.extend(f"{edge.source} -> {edge.target}" for edge in operation.edges)
    return labels


def proposal_formatter_node(state: OrchestrationState) -> OrchestrationState:
    request = _coerce_request(state["request"])
    planner_output = _coerce_planner_output(state["planner_output"])
    output = state["worker_output"]
    proposal = AIProposal(
        proposalId=f"proposal-{uuid.uuid4().hex[:10]}",
        summary=output["summary"],
        context=request.context,
        intentSummary=planner_output.intentSummary,
        contextSummary=planner_output.contextSummary,
        changePlan=output.get("change_plan", []),
        affectedTargets=output.get("affected_targets") or _describe_affected_targets(output["operations"], request),
        openQuestions=planner_output.openQuestions,
        operations=output["operations"],
    )
    return {
        "proposal": proposal,
        "response_message": output["message"],
    }


def build_graph():
    graph = StateGraph(OrchestrationState)
    graph.add_node("planner", planner_node)
    graph.add_node("supervisor", supervisor_node)
    graph.add_node("describe_node", describe_node_node)
    graph.add_node("define_completion_criteria", completion_criteria_node)
    graph.add_node("create_nodes", create_nodes_node)
    graph.add_node("split_into_subtasks", split_into_subtasks_node)
    graph.add_node("proposal_formatter", proposal_formatter_node)

    graph.add_edge(START, "planner")
    graph.add_edge("planner", "supervisor")

    graph.add_conditional_edges(
        "supervisor",
        lambda state: state["intent"],
        ROUTE_MAP,
    )

    graph.add_edge("describe_node", "proposal_formatter")
    graph.add_edge("define_completion_criteria", "proposal_formatter")
    graph.add_edge("create_nodes", "proposal_formatter")
    graph.add_edge("split_into_subtasks", "proposal_formatter")
    graph.add_edge("proposal_formatter", END)
    return graph.compile()
