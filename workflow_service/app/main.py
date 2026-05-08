from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://projectplanner:projectplanner@postgres:5432/projectplanner",
)
logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class ProjectModel(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    title: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    completion_criteria: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    concept_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    external_refs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    source_kind: Mapped[str | None] = mapped_column(String(64), nullable=True)
    memory_scope: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    graph_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    nodes: Mapped[list["NodeModel"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    edges: Mapped[list["EdgeModel"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    proposals: Mapped[list["ProposalModel"]] = relationship(back_populates="project", cascade="all, delete-orphan")


class NodeModel(Base):
    __tablename__ = "nodes"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="todo")
    description: Mapped[str] = mapped_column(Text, default="")
    completion_criteria: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    concept_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    external_refs: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    source_kind: Mapped[str | None] = mapped_column(String(64), nullable=True)
    parent_node_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    position_x: Mapped[float] = mapped_column(Float, default=0)
    position_y: Mapped[float] = mapped_column(Float, default=0)
    width: Mapped[float | None] = mapped_column(Float, nullable=True)
    height: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    project: Mapped[ProjectModel] = relationship(back_populates="nodes")


class EdgeModel(Base):
    __tablename__ = "edges"
    __table_args__ = (UniqueConstraint("project_id", "source_node_id", "target_node_id", name="uq_project_edge"),)

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    source_node_id: Mapped[str] = mapped_column(String(255))
    target_node_id: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)

    project: Mapped[ProjectModel] = relationship(back_populates="edges")


class ProposalModel(Base):
    __tablename__ = "proposals"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    intent: Mapped[str] = mapped_column(String(64), default="discuss")
    mode: Mapped[str] = mapped_column(String(64), default="chat")
    workflow: Mapped[str] = mapped_column(String(64), default="planning")
    summary: Mapped[str] = mapped_column(Text, default="")
    rationale: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="draft")
    graph_operations: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    touched_node_ids: Mapped[list[str]] = mapped_column(JSONB, default=list)
    memory_insight: Mapped[str | None] = mapped_column(Text, nullable=True)
    diff: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    actor: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[ProjectModel] = relationship(back_populates="proposals")


engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, future=True, autoflush=False, autocommit=False)


def get_session():
    with SessionLocal() as session:
        yield session


class ExternalRefPayload(BaseModel):
    system: str
    id: str
    label: str | None = None
    url: str | None = None


class RetrievalDefaultsPayload(BaseModel):
    limit: int = 6
    searchMode: str = "hybrid"


class MemoryScopePayload(BaseModel):
    containerTags: list[str] = Field(default_factory=list)
    metadataDefaults: dict[str, str] = Field(default_factory=dict)
    retrievalDefaults: RetrievalDefaultsPayload = Field(default_factory=RetrievalDefaultsPayload)


class RootPayload(BaseModel):
    title: str = ""
    description: str = ""
    completionCriteria: str = ""
    tags: list[str] = Field(default_factory=list)
    conceptId: str | None = None
    externalRefs: list[ExternalRefPayload] = Field(default_factory=list)
    sourceKind: str | None = None
    memoryScope: MemoryScopePayload = Field(default_factory=MemoryScopePayload)


class NodePayload(BaseModel):
    id: str
    kind: Literal["task", "group"]
    title: str
    status: Literal["todo", "done"]
    position: dict[str, float]
    description: str = ""
    completionCriteria: str = ""
    tags: list[str] = Field(default_factory=list)
    conceptId: str | None = None
    externalRefs: list[ExternalRefPayload] = Field(default_factory=list)
    sourceKind: str | None = None
    parentId: str | None = None
    size: dict[str, float] | None = None


class EdgePayload(BaseModel):
    id: str
    source: str
    target: str


class PlannerSnapshotPayload(BaseModel):
    root: RootPayload
    nodes: list[NodePayload]
    edges: list[EdgePayload]


class CreateProjectRequest(BaseModel):
    projectId: str
    title: str | None = None
    project: PlannerSnapshotPayload | None = None


class UpdateProjectRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    completionCriteria: str | None = None
    tags: list[str] | None = None
    conceptId: str | None = None
    externalRefs: list[ExternalRefPayload] | None = None
    sourceKind: str | None = None
    memoryScope: MemoryScopePayload | None = None


class UpdateNodeFieldsOperation(BaseModel):
    type: Literal["update_node_fields"]
    targetType: Literal["root", "node"]
    targetId: str
    fields: dict[str, Any]


class CreateGroupOperation(BaseModel):
    type: Literal["create_group"]
    group: NodePayload


class CreateTasksOperation(BaseModel):
    type: Literal["create_tasks"]
    tasks: list[NodePayload]


class CreateEdgesOperation(BaseModel):
    type: Literal["create_edges"]
    edges: list[EdgePayload]


class ReplaceGraphOperation(BaseModel):
    type: Literal["replace_graph"]
    project: PlannerSnapshotPayload


GraphOperation = UpdateNodeFieldsOperation | CreateGroupOperation | CreateTasksOperation | CreateEdgesOperation | ReplaceGraphOperation


class OperationsRequest(BaseModel):
    operations: list[GraphOperation]


class ProjectGraphResponse(BaseModel):
    projectId: str
    project: PlannerSnapshotPayload


class ProjectContextResponse(BaseModel):
    projectId: str
    project: PlannerSnapshotPayload
    graphVersion: int
    uiContext: dict[str, Any]
    graphContext: dict[str, Any]


class ProjectSettingsResponse(BaseModel):
    projectId: str
    memoryScope: MemoryScopePayload
    rootIdentity: dict[str, Any]


class ProjectListItem(BaseModel):
    projectId: str
    title: str
    description: str
    graphVersion: int
    nodeCount: int
    edgeCount: int
    updatedAt: str


class PersistProposalRequest(BaseModel):
    proposalId: str
    projectId: str
    intent: str
    mode: str
    workflow: str = "planning"
    summary: str
    rationale: str
    graphOperations: list[dict[str, Any]] = Field(default_factory=list)
    touchedNodeIds: list[str] = Field(default_factory=list)
    memoryInsight: str | None = None
    diff: dict[str, Any] = Field(default_factory=dict)
    actor: str | None = None


class ProposalStatusPatchRequest(BaseModel):
    status: Literal["draft", "approved", "applied", "rejected", "expired"]
    actor: str | None = None


class ApplyProposalRequest(BaseModel):
    actor: str | None = None


class ProposalResponse(BaseModel):
    proposalId: str
    projectId: str
    intent: str
    mode: str
    workflow: str
    summary: str
    rationale: str
    status: str
    graphOperations: list[dict[str, Any]]
    touchedNodeIds: list[str]
    memoryInsight: str | None = None
    diff: dict[str, Any]
    actor: str | None = None
    createdAt: str
    updatedAt: str
    approvedAt: str | None = None
    appliedAt: str | None = None
    rejectedAt: str | None = None
    expiredAt: str | None = None


class ApplyProposalResponse(BaseModel):
    proposal: ProposalResponse
    projectId: str
    project: PlannerSnapshotPayload


def normalize_external_refs(refs: list[ExternalRefPayload] | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not refs:
        return []
    normalized: list[dict[str, Any]] = []
    for ref in refs:
        if isinstance(ref, ExternalRefPayload):
            normalized.append(ref.model_dump(exclude_none=True))
        elif isinstance(ref, dict) and ref.get("system") and ref.get("id"):
            normalized.append(
                {
                    "system": str(ref["system"]),
                    "id": str(ref["id"]),
                    "label": ref.get("label"),
                    "url": ref.get("url"),
                }
            )
    return normalized


def normalize_memory_scope(scope: MemoryScopePayload | dict[str, Any] | None) -> dict[str, Any]:
    if isinstance(scope, MemoryScopePayload):
        return scope.model_dump()
    if not isinstance(scope, dict):
        return MemoryScopePayload().model_dump()
    retrieval_defaults = scope.get("retrievalDefaults") or {}
    return MemoryScopePayload(
        containerTags=[str(tag) for tag in scope.get("containerTags", []) if str(tag).strip()],
        metadataDefaults={str(key): str(value) for key, value in (scope.get("metadataDefaults") or {}).items()},
        retrievalDefaults=RetrievalDefaultsPayload(
            limit=int(retrieval_defaults.get("limit", 6)),
            searchMode=str(retrieval_defaults.get("searchMode", "hybrid")),
        ),
    ).model_dump()


def serialize_project(project: ProjectModel) -> PlannerSnapshotPayload:
    nodes = sorted(project.nodes, key=lambda node: node.id)
    edges = sorted(project.edges, key=lambda edge: edge.id)

    return PlannerSnapshotPayload(
        root=RootPayload(
            title=project.title,
            description=project.description,
            completionCriteria=project.completion_criteria,
            tags=list(project.tags or []),
            conceptId=project.concept_id,
            externalRefs=list(project.external_refs or []),
            sourceKind=project.source_kind,
            memoryScope=normalize_memory_scope(project.memory_scope),
        ),
        nodes=[
            NodePayload(
                id=node.id,
                kind=node.kind,  # type: ignore[arg-type]
                title=node.title,
                status=node.status,  # type: ignore[arg-type]
                position={"x": node.position_x, "y": node.position_y},
                description=node.description,
                completionCriteria=node.completion_criteria,
                tags=list(node.tags or []),
                conceptId=node.concept_id,
                externalRefs=list(node.external_refs or []),
                sourceKind=node.source_kind,
                parentId=node.parent_node_id,
                size={"width": node.width, "height": node.height} if node.width is not None and node.height is not None else None,
            )
            for node in nodes
        ],
        edges=[EdgePayload(id=edge.id, source=edge.source_node_id, target=edge.target_node_id) for edge in edges],
    )


def serialize_proposal(proposal: ProposalModel) -> ProposalResponse:
    return ProposalResponse(
        proposalId=proposal.id,
        projectId=proposal.project_id,
        intent=proposal.intent,
        mode=proposal.mode,
        workflow=proposal.workflow,
        summary=proposal.summary,
        rationale=proposal.rationale,
        status=proposal.status,
        graphOperations=list(proposal.graph_operations or []),
        touchedNodeIds=list(proposal.touched_node_ids or []),
        memoryInsight=proposal.memory_insight,
        diff=dict(proposal.diff or {}),
        actor=proposal.actor,
        createdAt=proposal.created_at.isoformat(),
        updatedAt=proposal.updated_at.isoformat(),
        approvedAt=proposal.approved_at.isoformat() if proposal.approved_at else None,
        appliedAt=proposal.applied_at.isoformat() if proposal.applied_at else None,
        rejectedAt=proposal.rejected_at.isoformat() if proposal.rejected_at else None,
        expiredAt=proposal.expired_at.isoformat() if proposal.expired_at else None,
    )


def get_children(nodes: list[NodePayload], node_id: str) -> list[NodePayload]:
    return [node for node in nodes if node.parentId == node_id]


def get_descendant_task_ids(nodes: list[NodePayload], node_id: str) -> list[str]:
    task_ids: list[str] = []
    for child in get_children(nodes, node_id):
        if child.kind == "task":
            task_ids.append(child.id)
        else:
            task_ids.extend(get_descendant_task_ids(nodes, child.id))
    return task_ids


def get_descendant_node_ids(nodes: list[NodePayload], node_id: str) -> list[str]:
    descendant_ids: list[str] = []
    for child in get_children(nodes, node_id):
        descendant_ids.append(child.id)
        descendant_ids.extend(get_descendant_node_ids(nodes, child.id))
    return descendant_ids


def get_ancestor_group_ids(nodes_by_id: dict[str, NodePayload], node_id: str) -> list[str]:
    ancestors: list[str] = []
    current = nodes_by_id.get(node_id)
    while current and current.parentId:
        ancestors.append(current.parentId)
        current = nodes_by_id.get(current.parentId)
    return ancestors


def get_group_path(nodes_by_id: dict[str, NodePayload], node_id: str) -> list[dict[str, str]]:
    node = nodes_by_id.get(node_id)
    if not node:
        return []
    ancestors = get_ancestor_group_ids(nodes_by_id, node_id)
    ordered = list(reversed(ancestors))
    return [{"id": ancestor_id, "title": nodes_by_id[ancestor_id].title} for ancestor_id in ordered if ancestor_id in nodes_by_id]


def get_incoming_edges(edges: list[EdgePayload], node_id: str) -> list[EdgePayload]:
    return [edge for edge in edges if edge.target == node_id]


def get_outgoing_edges(edges: list[EdgePayload], node_id: str) -> list[EdgePayload]:
    return [edge for edge in edges if edge.source == node_id]


def get_scope_nodes(nodes: list[NodePayload], scope_id: str | None) -> list[NodePayload]:
    return [node for node in nodes if node.parentId == scope_id]


def get_scope_edges(nodes: list[NodePayload], edges: list[EdgePayload], scope_id: str | None) -> list[EdgePayload]:
    scope_node_ids = {node.id for node in get_scope_nodes(nodes, scope_id)}
    return [edge for edge in edges if edge.source in scope_node_ids and edge.target in scope_node_ids]


def build_project_context(
    project_id: str,
    snapshot: PlannerSnapshotPayload,
    graph_version: int,
    active_tab_id: str | None,
    selected_node_ids: list[str],
) -> ProjectContextResponse:
    nodes = snapshot.nodes
    edges = snapshot.edges
    nodes_by_id = {node.id: node for node in nodes}
    valid_selected_ids = [node_id for node_id in selected_node_ids if node_id in nodes_by_id]
    normalized_active_tab_id = active_tab_id if active_tab_id and active_tab_id != "main" and active_tab_id in nodes_by_id else None

    completion_cache: dict[str, bool] = {}

    def is_node_complete(node_id: str) -> bool:
        if node_id in completion_cache:
            return completion_cache[node_id]

        node = nodes_by_id.get(node_id)
        if not node:
            completion_cache[node_id] = False
            return False

        if node.kind == "task":
            completion_cache[node_id] = node.status == "done"
            return completion_cache[node_id]

        descendant_task_ids = get_descendant_task_ids(nodes, node_id)
        completion_cache[node_id] = len(descendant_task_ids) > 0 and all(is_node_complete(task_id) for task_id in descendant_task_ids)
        return completion_cache[node_id]

    def is_task_available(node: NodePayload) -> bool:
        if node.kind != "task" or node.status == "done":
            return False

        inherited_edges = [
            edge
            for ancestor_id in get_ancestor_group_ids(nodes_by_id, node.id)
            for edge in get_incoming_edges(edges, ancestor_id)
        ]
        blockers = [*get_incoming_edges(edges, node.id), *inherited_edges]
        return all(is_node_complete(edge.source) for edge in blockers)

    def is_group_available(node: NodePayload) -> bool:
        if node.kind != "group" or is_node_complete(node.id):
            return False
        return all(is_node_complete(edge.source) for edge in get_incoming_edges(edges, node.id))

    def count_group_progress(node_id: str) -> dict[str, int]:
        descendant_task_ids = get_descendant_task_ids(nodes, node_id)
        done_count = sum(1 for task_id in descendant_task_ids if is_node_complete(task_id))
        return {"done": done_count, "total": len(descendant_task_ids)}

    dependency_depth_cache: dict[str, int] = {}

    def get_dependency_depth(node_id: str) -> int:
        if node_id in dependency_depth_cache:
            return dependency_depth_cache[node_id]

        incoming = get_incoming_edges(edges, node_id)
        if not incoming:
            dependency_depth_cache[node_id] = 0
            return 0

        dependency_depth_cache[node_id] = 1 + max(get_dependency_depth(edge.source) for edge in incoming)
        return dependency_depth_cache[node_id]

    scope_nodes = get_scope_nodes(nodes, normalized_active_tab_id)
    scope_edges = get_scope_edges(nodes, edges, normalized_active_tab_id)

    node_details: list[dict[str, Any]] = []
    available_global: list[dict[str, str]] = []
    available_scope: list[dict[str, str]] = []
    empty_groups: list[dict[str, str]] = []
    missing_details: list[dict[str, str]] = []
    leaves_without_subtasks: list[dict[str, str]] = []
    ready_without_blockers: list[dict[str, str]] = []

    for node in nodes:
        incoming = get_incoming_edges(edges, node.id)
        outgoing = get_outgoing_edges(edges, node.id)
        ancestor_group_ids = get_ancestor_group_ids(nodes_by_id, node.id)
        inherited_blockers = [edge.source for ancestor_id in ancestor_group_ids for edge in get_incoming_edges(edges, ancestor_id)]
        descendant_task_ids = get_descendant_task_ids(nodes, node.id) if node.kind == "group" else []
        child_count = len(get_children(nodes, node.id))
        is_complete = is_node_complete(node.id)
        is_available = is_group_available(node) if node.kind == "group" else is_task_available(node)
        is_empty = node.kind == "group" and child_count == 0
        progress = count_group_progress(node.id) if node.kind == "group" else None

        if node.kind == "task" and is_available:
            available_global.append({"id": node.id, "title": node.title})
            if node in scope_nodes:
                available_scope.append({"id": node.id, "title": node.title})

        if is_empty:
            empty_groups.append({"id": node.id, "title": node.title})

        if child_count == 0:
            leaves_without_subtasks.append({"id": node.id, "title": node.title, "kind": node.kind})

        if node.kind == "task" and node.status != "done" and not incoming and not inherited_blockers:
            ready_without_blockers.append({"id": node.id, "title": node.title})

        if not node.description.strip() or not node.completionCriteria.strip():
            missing_details.append(
                {
                    "id": node.id,
                    "title": node.title,
                    "kind": node.kind,
                    "missing": "description and completion criteria"
                    if not node.description.strip() and not node.completionCriteria.strip()
                    else "description"
                    if not node.description.strip()
                    else "completion criteria",
                }
            )

        node_details.append(
            {
                "id": node.id,
                "kind": node.kind,
                "title": node.title,
                "description": node.description,
                "completionCriteria": node.completionCriteria,
                "tags": list(node.tags),
                "conceptId": node.conceptId,
                "externalRefs": list(node.externalRefs),
                "sourceKind": node.sourceKind,
                "status": node.status,
                "parentId": node.parentId,
                "groupPath": get_group_path(nodes_by_id, node.id),
                "childCount": child_count,
                "descendantNodeIds": get_descendant_node_ids(nodes, node.id) if node.kind == "group" else [],
                "descendantTaskIds": descendant_task_ids,
                "incomingBlockerIds": [edge.source for edge in incoming],
                "inheritedBlockerIds": inherited_blockers,
                "outgoingDependentIds": [edge.target for edge in outgoing],
                "isComplete": is_complete,
                "isAvailable": is_available,
                "isBlocked": not is_available and not is_complete,
                "isEmpty": is_empty,
                "progress": progress,
                "dependencyDepth": get_dependency_depth(node.id),
            }
        )

    critical_path_candidates = sorted(
        [{"id": node.id, "title": node.title, "kind": node.kind, "dependencyDepth": get_dependency_depth(node.id)} for node in nodes if not is_node_complete(node.id)],
        key=lambda item: item["dependencyDepth"],
        reverse=True,
    )[:5]

    selected_nodes = [{"id": node_id, "title": nodes_by_id[node_id].title, "kind": nodes_by_id[node_id].kind} for node_id in valid_selected_ids]
    root_workstreams = [{"id": node.id, "title": node.title, "kind": node.kind} for node in nodes if node.parentId is None]

    return ProjectContextResponse(
        projectId=project_id,
        project=snapshot,
        graphVersion=graph_version,
        uiContext={
            "activeTabId": normalized_active_tab_id or "main",
            "selectedNodeIds": valid_selected_ids,
            "selectedNodes": selected_nodes,
            "scopeNodeIds": [node.id for node in scope_nodes],
            "scopeEdgeIds": [edge.id for edge in scope_edges],
        },
        graphContext={
            "root": {
                "title": snapshot.root.title,
                "description": snapshot.root.description,
                "completionCriteria": snapshot.root.completionCriteria,
                "tags": list(snapshot.root.tags),
                "conceptId": snapshot.root.conceptId,
                "externalRefs": list(snapshot.root.externalRefs),
                "sourceKind": snapshot.root.sourceKind,
                "memoryScope": snapshot.root.memoryScope.model_dump(),
            },
            "nodeInventory": node_details,
            "scope": {
                "activeScopeId": normalized_active_tab_id,
                "activeScopeTitle": nodes_by_id[normalized_active_tab_id].title if normalized_active_tab_id else snapshot.root.title,
                "scopeNodes": [{"id": node.id, "title": node.title, "kind": node.kind} for node in scope_nodes],
                "scopeEdges": [{"id": edge.id, "source": edge.source, "target": edge.target} for edge in scope_edges],
                "availableTasksInScope": available_scope,
            },
            "availableTasksGlobal": available_global,
            "summaries": {
                "rootWorkstreams": root_workstreams,
                "leavesWithoutSubtasks": leaves_without_subtasks,
                "tasksWithoutBlockers": ready_without_blockers,
                "itemsMissingDetails": missing_details,
                "emptyGroups": empty_groups,
                "criticalPathCandidates": critical_path_candidates,
            },
            "changeAwareness": {
                "graphVersion": graph_version,
            },
        },
    )


def ensure_project(session: Session, project_id: str) -> ProjectModel:
    project = session.get(ProjectModel, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found.")
    return project


def ensure_proposal(session: Session, proposal_id: str) -> ProposalModel:
    proposal = session.get(ProposalModel, proposal_id)
    if not proposal:
        raise HTTPException(status_code=404, detail="Proposal not found.")
    return proposal


def validate_snapshot(snapshot: PlannerSnapshotPayload) -> None:
    node_ids = {node.id for node in snapshot.nodes}
    if len(node_ids) != len(snapshot.nodes):
        raise HTTPException(status_code=400, detail="Node IDs must be unique within a project.")

    edge_ids = {edge.id for edge in snapshot.edges}
    if len(edge_ids) != len(snapshot.edges):
        raise HTTPException(status_code=400, detail="Edge IDs must be unique within a project.")

    for node in snapshot.nodes:
        if node.parentId and node.parentId not in node_ids:
            raise HTTPException(status_code=400, detail=f"Parent node {node.parentId} does not exist.")

    edge_pairs: set[tuple[str, str]] = set()
    for edge in snapshot.edges:
        if edge.source not in node_ids or edge.target not in node_ids:
            raise HTTPException(status_code=400, detail="Edges must reference existing nodes.")
        if edge.source == edge.target:
            raise HTTPException(status_code=400, detail="Self-referential edges are not allowed.")
        pair = (edge.source, edge.target)
        if pair in edge_pairs:
            raise HTTPException(status_code=400, detail="Duplicate edges are not allowed.")
        edge_pairs.add(pair)

    adjacency: dict[str, list[str]] = {}
    for edge in snapshot.edges:
        adjacency.setdefault(edge.source, []).append(edge.target)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> None:
        if node_id in visited:
            return
        if node_id in visiting:
            raise HTTPException(status_code=400, detail="Dependency cycles are not allowed.")

        visiting.add(node_id)
        for next_id in adjacency.get(node_id, []):
            visit(next_id)
        visiting.remove(node_id)
        visited.add(node_id)

    for node_id in node_ids:
        visit(node_id)


def replace_graph(session: Session, project: ProjectModel, snapshot: PlannerSnapshotPayload) -> None:
    validate_snapshot(snapshot)

    project.title = snapshot.root.title
    project.description = snapshot.root.description
    project.completion_criteria = snapshot.root.completionCriteria
    project.tags = list(snapshot.root.tags)
    project.concept_id = snapshot.root.conceptId
    project.external_refs = normalize_external_refs(snapshot.root.externalRefs)
    project.source_kind = snapshot.root.sourceKind
    project.memory_scope = normalize_memory_scope(snapshot.root.memoryScope)
    project.graph_version += 1
    project.updated_at = utc_now()

    session.query(EdgeModel).filter(EdgeModel.project_id == project.id).delete()
    session.query(NodeModel).filter(NodeModel.project_id == project.id).delete()
    session.flush()

    for node in snapshot.nodes:
        session.add(
            NodeModel(
                id=node.id,
                project_id=project.id,
                kind=node.kind,
                title=node.title,
                status=node.status,
                description=node.description,
                completion_criteria=node.completionCriteria,
                tags=list(node.tags),
                concept_id=node.conceptId,
                external_refs=normalize_external_refs(node.externalRefs),
                source_kind=node.sourceKind,
                parent_node_id=node.parentId,
                position_x=node.position["x"],
                position_y=node.position["y"],
                width=node.size["width"] if node.size else None,
                height=node.size["height"] if node.size else None,
            )
        )
    session.flush()

    for edge in snapshot.edges:
        session.add(EdgeModel(id=edge.id, project_id=project.id, source_node_id=edge.source, target_node_id=edge.target))


def log_integrity_error(action: str, project_id: str, error: IntegrityError) -> None:
    constraint_name = getattr(getattr(error.orig, "diag", None), "constraint_name", None)
    logger.exception(
        "Graph integrity error during %s for project %s (constraint=%s): %s",
        action,
        project_id,
        constraint_name or "unknown",
        error.orig,
    )


def apply_operations(session: Session, project: ProjectModel, operations: list[GraphOperation]) -> PlannerSnapshotPayload:
    snapshot = serialize_project(project)
    snapshot = apply_operations_to_snapshot(snapshot, operations)
    replace_graph(session, project, snapshot)
    return snapshot


def apply_operations_to_snapshot(snapshot: PlannerSnapshotPayload, operations: list[GraphOperation]) -> PlannerSnapshotPayload:
    next_snapshot = snapshot.model_copy(deep=True)

    for operation in operations:
        if isinstance(operation, ReplaceGraphOperation):
            next_snapshot = operation.project.model_copy(deep=True)
            continue

        if isinstance(operation, UpdateNodeFieldsOperation):
            if operation.targetType == "root":
                for key, value in operation.fields.items():
                    if key == "title":
                        next_snapshot.root.title = str(value)
                    elif key == "description":
                        next_snapshot.root.description = str(value)
                    elif key == "completionCriteria":
                        next_snapshot.root.completionCriteria = str(value)
                    elif key == "conceptId":
                        next_snapshot.root.conceptId = str(value) if value else None
                    elif key == "sourceKind":
                        next_snapshot.root.sourceKind = str(value) if value else None
                    elif key == "externalRefs":
                        next_snapshot.root.externalRefs = [ExternalRefPayload.model_validate(ref) for ref in (value or [])]
                    elif key == "memoryScope":
                        next_snapshot.root.memoryScope = MemoryScopePayload.model_validate(value or {})
            else:
                target = next((node for node in next_snapshot.nodes if node.id == operation.targetId), None)
                if not target:
                    raise HTTPException(status_code=400, detail=f"Node {operation.targetId} not found.")
                for key, value in operation.fields.items():
                    if key == "title":
                        target.title = str(value)
                    elif key == "description":
                        target.description = str(value)
                    elif key == "completionCriteria":
                        target.completionCriteria = str(value)
                    elif key == "conceptId":
                        target.conceptId = str(value) if value else None
                    elif key == "sourceKind":
                        target.sourceKind = str(value) if value else None
                    elif key == "externalRefs":
                        target.externalRefs = [ExternalRefPayload.model_validate(ref) for ref in (value or [])]
            continue

        if isinstance(operation, CreateGroupOperation):
            next_snapshot.nodes.append(operation.group.model_copy(deep=True))
            continue

        if isinstance(operation, CreateTasksOperation):
            next_snapshot.nodes.extend(task.model_copy(deep=True) for task in operation.tasks)
            continue

        if isinstance(operation, CreateEdgesOperation):
            next_snapshot.edges.extend(edge.model_copy(deep=True) for edge in operation.edges)

    validate_snapshot(next_snapshot)
    return next_snapshot


def build_snapshot_diff(before: PlannerSnapshotPayload, after: PlannerSnapshotPayload) -> dict[str, Any]:
    before_nodes = {node.id: node for node in before.nodes}
    after_nodes = {node.id: node for node in after.nodes}
    before_edges = {edge.id: edge for edge in before.edges}
    after_edges = {edge.id: edge for edge in after.edges}

    root_changes: list[dict[str, Any]] = []
    for field in ("title", "description", "completionCriteria", "conceptId", "sourceKind"):
        before_value = getattr(before.root, field)
        after_value = getattr(after.root, field)
        if before_value != after_value:
            root_changes.append({"field": field, "before": before_value, "after": after_value})
    if before.root.memoryScope != after.root.memoryScope:
        root_changes.append({"field": "memoryScope", "before": before.root.memoryScope.model_dump(), "after": after.root.memoryScope.model_dump()})
    if before.root.externalRefs != after.root.externalRefs:
        root_changes.append({"field": "externalRefs", "before": [ref.model_dump() for ref in before.root.externalRefs], "after": [ref.model_dump() for ref in after.root.externalRefs]})

    node_creates = [node.model_dump() for node_id, node in after_nodes.items() if node_id not in before_nodes]
    node_deletes = [node.model_dump() for node_id, node in before_nodes.items() if node_id not in after_nodes]

    node_updates: list[dict[str, Any]] = []
    for node_id in sorted(set(before_nodes) & set(after_nodes)):
        before_node = before_nodes[node_id]
        after_node = after_nodes[node_id]
        changes: list[dict[str, Any]] = []
        for field in ("title", "description", "completionCriteria", "status", "parentId", "conceptId", "sourceKind"):
            if getattr(before_node, field) != getattr(after_node, field):
                changes.append({"field": field, "before": getattr(before_node, field), "after": getattr(after_node, field)})
        if before_node.externalRefs != after_node.externalRefs:
            changes.append({"field": "externalRefs", "before": [ref.model_dump() for ref in before_node.externalRefs], "after": [ref.model_dump() for ref in after_node.externalRefs]})
        if changes:
            node_updates.append({"id": node_id, "title": after_node.title, "kind": after_node.kind, "changes": changes})

    edge_creates = [edge.model_dump() for edge_id, edge in after_edges.items() if edge_id not in before_edges]
    edge_deletes = [edge.model_dump() for edge_id, edge in before_edges.items() if edge_id not in after_edges]

    return {
        "rootChanges": root_changes,
        "nodeCreates": node_creates,
        "nodeUpdates": node_updates,
        "nodeDeletes": node_deletes,
        "edgeCreates": edge_creates,
        "edgeDeletes": edge_deletes,
    }


def ensure_schema() -> None:
    Base.metadata.create_all(bind=engine)
    statements = [
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS concept_id VARCHAR(255)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '[]'::jsonb NOT NULL",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_kind VARCHAR(64)",
        "ALTER TABLE projects ADD COLUMN IF NOT EXISTS memory_scope JSONB DEFAULT '{}'::jsonb NOT NULL",
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS concept_id VARCHAR(255)",
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS external_refs JSONB DEFAULT '[]'::jsonb NOT NULL",
        "ALTER TABLE nodes ADD COLUMN IF NOT EXISTS source_kind VARCHAR(64)",
    ]
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


@asynccontextmanager
async def lifespan(_: FastAPI):
    ensure_schema()
    yield


app = FastAPI(title="Project Planner Workflow Service", version="0.2.0", lifespan=lifespan)


@app.get("/api/health")
def health(session: Session = Depends(get_session)):
    session.execute(select(1))
    return {"status": "ok", "service": "workflow-service"}


@app.post("/api/projects", response_model=ProjectGraphResponse)
def create_project(payload: CreateProjectRequest, session: Session = Depends(get_session)):
    existing = session.get(ProjectModel, payload.projectId)
    if existing:
        return ProjectGraphResponse(projectId=existing.id, project=serialize_project(existing))

    snapshot = payload.project or PlannerSnapshotPayload(root=RootPayload(title=payload.title or ""), nodes=[], edges=[])
    validate_snapshot(snapshot)

    project = ProjectModel(
        id=payload.projectId,
        title=snapshot.root.title or (payload.title or ""),
        description=snapshot.root.description,
        completion_criteria=snapshot.root.completionCriteria,
        tags=list(snapshot.root.tags),
        concept_id=snapshot.root.conceptId,
        external_refs=normalize_external_refs(snapshot.root.externalRefs),
        source_kind=snapshot.root.sourceKind,
        memory_scope=normalize_memory_scope(snapshot.root.memoryScope),
        graph_version=0,
    )
    session.add(project)
    session.flush()
    replace_graph(session, project, snapshot)
    session.commit()
    session.refresh(project)
    return ProjectGraphResponse(projectId=project.id, project=serialize_project(project))


@app.get("/api/projects", response_model=list[ProjectListItem])
def list_projects(session: Session = Depends(get_session)):
    projects = session.scalars(select(ProjectModel).order_by(ProjectModel.updated_at.desc())).all()
    return [
        ProjectListItem(
            projectId=project.id,
            title=project.title,
            description=project.description,
            graphVersion=project.graph_version,
            nodeCount=len(project.nodes),
            edgeCount=len(project.edges),
            updatedAt=project.updated_at.isoformat(),
        )
        for project in projects
    ]


@app.get("/api/projects/{project_id}/graph", response_model=ProjectGraphResponse)
def get_project_graph(project_id: str, session: Session = Depends(get_session)):
    project = ensure_project(session, project_id)
    return ProjectGraphResponse(projectId=project.id, project=serialize_project(project))


@app.get("/api/projects/{project_id}/context", response_model=ProjectContextResponse)
def get_project_context(
    project_id: str,
    activeTabId: str | None = None,
    selectedNodeIds: list[str] = Query(default_factory=list),
    session: Session = Depends(get_session),
):
    project = ensure_project(session, project_id)
    snapshot = serialize_project(project)
    return build_project_context(project.id, snapshot, project.graph_version, activeTabId, selectedNodeIds)


@app.get("/api/projects/{project_id}/settings", response_model=ProjectSettingsResponse)
def get_project_settings(project_id: str, session: Session = Depends(get_session)):
    project = ensure_project(session, project_id)
    return ProjectSettingsResponse(
        projectId=project.id,
        memoryScope=normalize_memory_scope(project.memory_scope),
        rootIdentity={
            "conceptId": project.concept_id,
            "externalRefs": list(project.external_refs or []),
            "sourceKind": project.source_kind,
        },
    )


@app.patch("/api/projects/{project_id}", response_model=ProjectGraphResponse)
def update_project(project_id: str, payload: UpdateProjectRequest, session: Session = Depends(get_session)):
    project = ensure_project(session, project_id)
    if payload.title is not None:
        project.title = payload.title
    if payload.description is not None:
        project.description = payload.description
    if payload.completionCriteria is not None:
        project.completion_criteria = payload.completionCriteria
    if payload.tags is not None:
        project.tags = list(payload.tags)
    if payload.conceptId is not None:
        project.concept_id = payload.conceptId
    if payload.externalRefs is not None:
        project.external_refs = normalize_external_refs(payload.externalRefs)
    if payload.sourceKind is not None:
        project.source_kind = payload.sourceKind
    if payload.memoryScope is not None:
        project.memory_scope = normalize_memory_scope(payload.memoryScope)
    project.graph_version += 1
    project.updated_at = utc_now()
    session.commit()
    session.refresh(project)
    return ProjectGraphResponse(projectId=project.id, project=serialize_project(project))


@app.post("/api/projects/{project_id}/operations", response_model=ProjectGraphResponse)
def apply_project_operations(project_id: str, payload: OperationsRequest, session: Session = Depends(get_session)):
    project = ensure_project(session, project_id)
    try:
        apply_operations(session, project, payload.operations)
        session.commit()
    except IntegrityError as error:
        session.rollback()
        log_integrity_error("apply_project_operations", project_id, error)
        raise HTTPException(status_code=400, detail="Duplicate edge or invalid graph mutation.") from error

    session.refresh(project)
    return ProjectGraphResponse(projectId=project.id, project=serialize_project(project))


@app.post("/api/proposals", response_model=ProposalResponse)
def create_proposal(payload: PersistProposalRequest, session: Session = Depends(get_session)):
    project = ensure_project(session, payload.projectId)
    before_snapshot = serialize_project(project)

    # Compute a safe diff by simulating the operations against an in-memory snapshot.
    try:
        operations_payload = OperationsRequest.model_validate({"operations": payload.graphOperations})
        temp_snapshot = apply_operations_to_snapshot(before_snapshot, operations_payload.operations)
        diff = build_snapshot_diff(before_snapshot, temp_snapshot)
    except Exception:
        diff = payload.diff or {}

    proposal = ProposalModel(
        id=payload.proposalId,
        project_id=project.id,
        intent=payload.intent,
        mode=payload.mode,
        workflow=payload.workflow,
        summary=payload.summary,
        rationale=payload.rationale,
        status="draft",
        graph_operations=list(payload.graphOperations),
        touched_node_ids=list(payload.touchedNodeIds),
        memory_insight=payload.memoryInsight,
        diff=diff,
        actor=payload.actor,
    )
    proposal = session.merge(proposal)
    session.commit()
    session.refresh(proposal)
    return serialize_proposal(proposal)


@app.get("/api/projects/{project_id}/proposals", response_model=list[ProposalResponse])
def list_project_proposals(project_id: str, session: Session = Depends(get_session)):
    ensure_project(session, project_id)
    proposals = session.scalars(select(ProposalModel).where(ProposalModel.project_id == project_id).order_by(ProposalModel.created_at.desc())).all()
    return [serialize_proposal(proposal) for proposal in proposals]


@app.get("/api/proposals/{proposal_id}", response_model=ProposalResponse)
def get_proposal(proposal_id: str, session: Session = Depends(get_session)):
    proposal = ensure_proposal(session, proposal_id)
    return serialize_proposal(proposal)


@app.patch("/api/proposals/{proposal_id}", response_model=ProposalResponse)
def update_proposal_status(proposal_id: str, payload: ProposalStatusPatchRequest, session: Session = Depends(get_session)):
    proposal = ensure_proposal(session, proposal_id)
    proposal.status = payload.status
    proposal.actor = payload.actor or proposal.actor
    proposal.updated_at = utc_now()
    now = utc_now()
    if payload.status == "approved":
        proposal.approved_at = now
    elif payload.status == "rejected":
        proposal.rejected_at = now
    elif payload.status == "expired":
        proposal.expired_at = now
    elif payload.status == "applied":
        proposal.applied_at = now
    session.commit()
    session.refresh(proposal)
    return serialize_proposal(proposal)


@app.post("/api/proposals/{proposal_id}/apply", response_model=ApplyProposalResponse)
def apply_proposal(proposal_id: str, payload: ApplyProposalRequest, session: Session = Depends(get_session)):
    proposal = ensure_proposal(session, proposal_id)
    project = ensure_project(session, proposal.project_id)
    operations_payload = OperationsRequest.model_validate({"operations": proposal.graph_operations})

    try:
        apply_operations(session, project, operations_payload.operations)
        proposal.status = "applied"
        proposal.actor = payload.actor or proposal.actor
        if proposal.approved_at is None:
            proposal.approved_at = utc_now()
        proposal.applied_at = utc_now()
        proposal.updated_at = utc_now()
        session.commit()
    except IntegrityError as error:
        session.rollback()
        log_integrity_error("apply_proposal", project.id, error)
        raise HTTPException(status_code=400, detail="Duplicate edge or invalid graph mutation.") from error

    session.refresh(project)
    session.refresh(proposal)
    return ApplyProposalResponse(proposal=serialize_proposal(proposal), projectId=project.id, project=serialize_project(project))
