from __future__ import annotations

import uuid
from typing import Any

from ..schemas.planner import (
    AIDocument,
    AIChatRequest,
    AIContextBundle,
    AINodeContextSummary,
    AIPlannerOutput,
    CreateEdgePayload,
    CreateTaskPayload,
    PlannerEdgeRecord,
    PlannerNodeRecord,
    Position,
)
from .types import DraftDependency, MAX_CONTEXT_NODES


def coerce_request(request: AIChatRequest | dict[str, Any]) -> AIChatRequest:
    if isinstance(request, AIChatRequest):
        return request
    return AIChatRequest.model_validate(request)


def coerce_planner_output(planner_output: AIPlannerOutput | dict[str, Any]) -> AIPlannerOutput:
    if isinstance(planner_output, AIPlannerOutput):
        return planner_output
    return AIPlannerOutput.model_validate(planner_output)


def find_target_node(request: AIChatRequest) -> PlannerNodeRecord | None:
    if not request.context.targetId:
        return None
    return next((node for node in request.project.nodes if node.id == request.context.targetId), None)


def find_node(request: AIChatRequest, node_id: str | None) -> PlannerNodeRecord | None:
    if not node_id:
        return None
    return next((node for node in request.project.nodes if node.id == node_id), None)


def fallback_intent(message: str) -> str:
    lowered = message.lower()
    if "completion" in lowered or "acceptance" in lowered or "criteria" in lowered:
        return "define_completion_criteria"
    if "split" in lowered or "subtask" in lowered or "decompose" in lowered or "break down" in lowered:
        return "split_into_subtasks"
    if "create" in lowered or "add node" in lowered or "new node" in lowered or "add task" in lowered:
        return "create_nodes"
    return "describe_node"


def resolve_parent_id(request: AIChatRequest) -> str | None:
    target_node = find_target_node(request)
    if request.context.targetType == "group":
        return request.context.targetId
    if request.context.targetType == "node" and target_node is not None:
        return target_node.parentId
    return None


def next_position(request: AIChatRequest, parent_id: str | None, index: int) -> Position:
    siblings = [node for node in request.project.nodes if node.parentId == parent_id]
    start = len(siblings) + index
    return Position(x=90 + (start % 4) * 120, y=110 + (start // 4) * 120)


def summarize_node(node: PlannerNodeRecord, relationship: str) -> AINodeContextSummary:
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


def incoming_edges(edges: list[PlannerEdgeRecord], node_id: str) -> list[PlannerEdgeRecord]:
    return [edge for edge in edges if edge.target == node_id]


def neighbor_node_ids(request: AIChatRequest, target: PlannerNodeRecord) -> list[str]:
    scope_id = target.parentId
    same_scope_ids = {node.id for node in request.project.nodes if node.parentId == scope_id and node.id != target.id}
    edge_neighbor_ids = {
        edge.source if edge.target == target.id else edge.target
        for edge in request.project.edges
        if edge.source == target.id or edge.target == target.id
    }
    return sorted(same_scope_ids | edge_neighbor_ids)[:MAX_CONTEXT_NODES]


def build_context_bundle(request: AIChatRequest) -> AIContextBundle:
    target_node = find_target_node(request)
    ancestor_group = find_node(request, target_node.parentId) if target_node and target_node.parentId else None

    surrounding_nodes: list[AINodeContextSummary] = []
    blocking_nodes: list[AINodeContextSummary] = []

    if target_node:
        for neighbor_id in neighbor_node_ids(request, target_node):
            neighbor = find_node(request, neighbor_id)
            if neighbor:
                surrounding_nodes.append(summarize_node(neighbor, "surrounding"))

        if target_node.kind == "task":
            for edge in incoming_edges(request.project.edges, target_node.id)[:MAX_CONTEXT_NODES]:
                blocker = find_node(request, edge.source)
                if blocker:
                    blocking_nodes.append(summarize_node(blocker, "blocker"))
    elif request.context.targetType == "group" and request.context.targetId:
        scope_nodes = [node for node in request.project.nodes if node.parentId == request.context.targetId][:MAX_CONTEXT_NODES]
        surrounding_nodes = [summarize_node(node, "surrounding") for node in scope_nodes]

    root_summary = (
        f"Project root: {request.project.root.title}. "
        f"Root description: {request.project.root.description or '(empty)'}. "
        f"Root completion criteria: {request.project.root.completionCriteria or '(empty)'}."
    )
    scope_parts = [root_summary, f"Current focus: {request.context.targetTitle} ({request.context.targetType})."]
    if ancestor_group:
        scope_parts.append(f"Ancestor group: {ancestor_group.title}.")
    if surrounding_nodes:
        scope_parts.append("Nearby scope nodes: " + ", ".join(node.title for node in surrounding_nodes[:MAX_CONTEXT_NODES]) + ".")
    if blocking_nodes:
        scope_parts.append("Blocking predecessors: " + ", ".join(node.title for node in blocking_nodes[:MAX_CONTEXT_NODES]) + ".")
    if not surrounding_nodes and not blocking_nodes and request.context.targetType == "root":
        scope_parts.append(f"Root graph currently contains {len(request.project.nodes)} nodes.")

    return AIContextBundle(
        target=summarize_node(target_node, "selected") if target_node else None,
        ancestorGroup=summarize_node(ancestor_group, "ancestor") if ancestor_group else None,
        surroundingNodes=surrounding_nodes,
        blockingNodes=blocking_nodes,
        scopeSummary=" ".join(scope_parts),
    )


def planner_prompt(request: AIChatRequest, context_bundle: AIContextBundle) -> str:
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
        lines.append("Surrounding nodes: " + ", ".join(node.title for node in context_bundle.surroundingNodes) + ".")
    if context_bundle.blockingNodes:
        lines.append("Blocking nodes: " + ", ".join(node.title for node in context_bundle.blockingNodes) + ".")
    if request.conversation:
        lines.append("Recent conversation: " + " | ".join(f"{message.role}: {message.content}" for message in request.conversation[-4:]))
    if request.documents:
        lines.append("Uploaded PDFs: " + " | ".join(f"{document.name} ({document.pageCount} pages): {document.excerpt}" for document in request.documents))
    return "\n".join(lines)


def document_context_text(documents: list[AIDocument]) -> str:
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


def worker_context_text(planner_output: AIPlannerOutput) -> str:
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


def resolve_draft_dependencies(
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
        edges.append(CreateEdgePayload(id=f"edge-{uuid.uuid4().hex[:8]}", source=source.id, target=target.id))
        if dependency.rationale.strip():
            explanations.append(f"{source.title} comes before {target.title}: {dependency.rationale.strip()}")
        else:
            explanations.append(f"{target.title} depends on {source.title}.")

    return edges, explanations


def describe_affected_targets(operations: list[Any], request: AIChatRequest) -> list[str]:
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
