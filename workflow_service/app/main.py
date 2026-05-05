from __future__ import annotations

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://projectplanner:projectplanner@postgres:5432/projectplanner",
)


class Base(DeclarativeBase):
    pass


class ProjectModel(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    title: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    completion_criteria: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    graph_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    nodes: Mapped[list["NodeModel"]] = relationship(back_populates="project", cascade="all, delete-orphan")
    edges: Mapped[list["EdgeModel"]] = relationship(back_populates="project", cascade="all, delete-orphan")


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
    parent_node_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    position_x: Mapped[float] = mapped_column(Float, default=0)
    position_y: Mapped[float] = mapped_column(Float, default=0)
    width: Mapped[float | None] = mapped_column(Float, nullable=True)
    height: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    project: Mapped[ProjectModel] = relationship(back_populates="nodes")


class EdgeModel(Base):
    __tablename__ = "edges"
    __table_args__ = (UniqueConstraint("project_id", "source_node_id", "target_node_id", name="uq_project_edge"),)

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    source_node_id: Mapped[str] = mapped_column(String(255))
    target_node_id: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    project: Mapped[ProjectModel] = relationship(back_populates="edges")


engine = create_engine(DATABASE_URL, future=True)
SessionLocal = sessionmaker(bind=engine, future=True, autoflush=False, autocommit=False)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def get_session():
    with SessionLocal() as session:
        yield session


class RootPayload(BaseModel):
    title: str = ""
    description: str = ""
    completionCriteria: str = ""
    tags: list[str] = Field(default_factory=list)


class NodePayload(BaseModel):
    id: str
    kind: Literal["task", "group"]
    title: str
    status: Literal["todo", "done"]
    position: dict[str, float]
    description: str = ""
    completionCriteria: str = ""
    tags: list[str] = Field(default_factory=list)
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


class UpdateNodeFieldsOperation(BaseModel):
    type: Literal["update_node_fields"]
    targetType: Literal["root", "node"]
    targetId: str
    fields: dict[str, str]


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


class ProjectListItem(BaseModel):
    projectId: str
    title: str
    description: str
    graphVersion: int
    nodeCount: int
    edgeCount: int
    updatedAt: str


def serialize_project(project: ProjectModel) -> PlannerSnapshotPayload:
    nodes = sorted(project.nodes, key=lambda node: node.id)
    edges = sorted(project.edges, key=lambda edge: edge.id)

    return PlannerSnapshotPayload(
        root=RootPayload(
            title=project.title,
            description=project.description,
            completionCriteria=project.completion_criteria,
            tags=list(project.tags or []),
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
                parentId=node.parent_node_id,
                size={"width": node.width, "height": node.height} if node.width and node.height else None,
            )
            for node in nodes
        ],
        edges=[
            EdgePayload(id=edge.id, source=edge.source_node_id, target=edge.target_node_id)
            for edge in edges
        ],
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
    return [
        {
            "id": ancestor_id,
            "title": nodes_by_id[ancestor_id].title,
        }
        for ancestor_id in ordered
        if ancestor_id in nodes_by_id
    ]


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
        inherited_blockers = [
            edge.source
            for ancestor_id in ancestor_group_ids
            for edge in get_incoming_edges(edges, ancestor_id)
        ]
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
        [
            {
                "id": node.id,
                "title": node.title,
                "kind": node.kind,
                "dependencyDepth": get_dependency_depth(node.id),
            }
            for node in nodes
            if not is_node_complete(node.id)
        ],
        key=lambda item: item["dependencyDepth"],
        reverse=True,
    )[:5]

    selected_nodes = [
        {
            "id": node_id,
            "title": nodes_by_id[node_id].title,
            "kind": nodes_by_id[node_id].kind,
        }
        for node_id in valid_selected_ids
    ]

    root_workstreams = [
        {
            "id": node.id,
            "title": node.title,
            "kind": node.kind,
        }
        for node in nodes
        if node.parentId is None
    ]

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
    project.graph_version += 1
    project.updated_at = utc_now()

    session.query(NodeModel).filter(NodeModel.project_id == project.id).delete()
    session.query(EdgeModel).filter(EdgeModel.project_id == project.id).delete()

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
                parent_node_id=node.parentId,
                position_x=node.position["x"],
                position_y=node.position["y"],
                width=node.size["width"] if node.size else None,
                height=node.size["height"] if node.size else None,
            )
        )

    for edge in snapshot.edges:
        session.add(
            EdgeModel(
                id=edge.id,
                project_id=project.id,
                source_node_id=edge.source,
                target_node_id=edge.target,
            )
        )


def apply_operations(session: Session, project: ProjectModel, operations: list[GraphOperation]) -> None:
    snapshot = serialize_project(project)

    for operation in operations:
        if isinstance(operation, ReplaceGraphOperation):
            snapshot = operation.project
            continue

        if isinstance(operation, UpdateNodeFieldsOperation):
            if operation.targetType == "root":
                for key, value in operation.fields.items():
                    if key == "title":
                        snapshot.root.title = value
                    elif key == "description":
                        snapshot.root.description = value
                    elif key == "completionCriteria":
                        snapshot.root.completionCriteria = value
            else:
                target = next((node for node in snapshot.nodes if node.id == operation.targetId), None)
                if not target:
                    raise HTTPException(status_code=400, detail=f"Node {operation.targetId} not found.")
                for key, value in operation.fields.items():
                    if key == "title":
                        target.title = value
                    elif key == "description":
                        target.description = value
                    elif key == "completionCriteria":
                        target.completionCriteria = value
            continue

        if isinstance(operation, CreateGroupOperation):
            snapshot.nodes.append(operation.group)
            continue

        if isinstance(operation, CreateTasksOperation):
            snapshot.nodes.extend(operation.tasks)
            continue

        if isinstance(operation, CreateEdgesOperation):
            snapshot.edges.extend(operation.edges)

    replace_graph(session, project, snapshot)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Project Planner Workflow Service", version="0.1.0", lifespan=lifespan)


@app.get("/api/health")
def health(session: Session = Depends(get_session)):
    session.execute(select(1))
    return {"status": "ok"}


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
        graph_version=1,
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
        raise HTTPException(status_code=400, detail="Duplicate edge or invalid graph mutation.") from error

    session.refresh(project)
    return ProjectGraphResponse(projectId=project.id, project=serialize_project(project))
