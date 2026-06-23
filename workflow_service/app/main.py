from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, delete, insert, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+psycopg://projectplanner:projectplanner@postgres:5432/projectplanner",
)


class Base(DeclarativeBase):
    pass


class WorkspaceModel(Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    name: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    projects: Mapped[list["ProjectModel"]] = relationship(
        back_populates="workspace",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ProjectModel(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(255), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
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

    workspace: Mapped[WorkspaceModel] = relationship(back_populates="projects")
    nodes: Mapped[list["NodeModel"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    edges: Mapped[list["EdgeModel"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


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


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = ""


class UpdateWorkspaceRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class CreateProjectRequest(BaseModel):
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
    workspaceId: str
    projectId: str
    project: PlannerSnapshotPayload


class ProjectListItem(BaseModel):
    workspaceId: str
    projectId: str
    title: str
    description: str
    graphVersion: int
    nodeCount: int
    edgeCount: int
    updatedAt: str


class WorkspaceListItem(BaseModel):
    workspaceId: str
    name: str
    description: str
    projectCount: int
    createdAt: str
    updatedAt: str
    projects: list[ProjectListItem]


class DeleteWorkspaceResponse(BaseModel):
    deletedWorkspaceId: str
    replacementWorkspaceId: str


class DeleteProjectResponse(BaseModel):
    deletedProjectId: str


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


def serialize_project_list_item(project: ProjectModel) -> ProjectListItem:
    return ProjectListItem(
        workspaceId=project.workspace_id,
        projectId=project.id,
        title=project.title,
        description=project.description,
        graphVersion=project.graph_version,
        nodeCount=len(project.nodes),
        edgeCount=len(project.edges),
        updatedAt=project.updated_at.isoformat(),
    )


def serialize_workspace(workspace: WorkspaceModel) -> WorkspaceListItem:
    projects = sorted(workspace.projects, key=lambda project: project.updated_at, reverse=True)
    return WorkspaceListItem(
        workspaceId=workspace.id,
        name=workspace.name,
        description=workspace.description,
        projectCount=len(projects),
        createdAt=workspace.created_at.isoformat(),
        updatedAt=workspace.updated_at.isoformat(),
        projects=[serialize_project_list_item(project) for project in projects],
    )


def create_default_workspace(session: Session) -> WorkspaceModel:
    workspace = WorkspaceModel(id=str(uuid4()), name="Default Workspace", description="")
    session.add(workspace)
    session.flush()
    return workspace


def ensure_workspace(session: Session, workspace_id: str) -> WorkspaceModel:
    workspace = session.get(WorkspaceModel, workspace_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found.")
    return workspace


def ensure_project(session: Session, workspace_id: str, project_id: str) -> ProjectModel:
    project = session.scalar(
        select(ProjectModel).where(
            ProjectModel.id == project_id,
            ProjectModel.workspace_id == workspace_id,
        )
    )
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


def order_nodes_for_insert(nodes: list[NodePayload]) -> list[NodePayload]:
    nodes_by_id = {node.id: node for node in nodes}
    ordered: list[NodePayload] = []
    visiting: set[str] = set()
    inserted: set[str] = set()

    def add_node(node: NodePayload) -> None:
        if node.id in inserted:
            return
        if node.id in visiting:
            raise HTTPException(status_code=400, detail="Node hierarchy cycles are not allowed.")

        visiting.add(node.id)
        if node.parentId:
            parent = nodes_by_id.get(node.parentId)
            if not parent:
                raise HTTPException(status_code=400, detail=f"Parent node {node.parentId} does not exist.")
            add_node(parent)
        visiting.remove(node.id)
        inserted.add(node.id)
        ordered.append(node)

    for node in nodes:
        add_node(node)

    return ordered


def replace_graph(session: Session, project: ProjectModel, snapshot: PlannerSnapshotPayload) -> None:
    validate_snapshot(snapshot)

    project.title = snapshot.root.title
    project.description = snapshot.root.description
    project.completion_criteria = snapshot.root.completionCriteria
    project.tags = list(snapshot.root.tags)
    project.graph_version += 1
    project.updated_at = utc_now()

    session.execute(delete(EdgeModel).where(EdgeModel.project_id == project.id))
    session.execute(delete(NodeModel).where(NodeModel.project_id == project.id))

    timestamp = utc_now()
    ordered_nodes = order_nodes_for_insert(snapshot.nodes)
    if ordered_nodes:
        session.execute(
            insert(NodeModel),
            [
                {
                    "id": node.id,
                    "project_id": project.id,
                    "kind": node.kind,
                    "title": node.title,
                    "status": node.status,
                    "description": node.description,
                    "completion_criteria": node.completionCriteria,
                    "tags": list(node.tags),
                    "parent_node_id": node.parentId,
                    "position_x": node.position["x"],
                    "position_y": node.position["y"],
                    "width": node.size["width"] if node.size else None,
                    "height": node.size["height"] if node.size else None,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
                for node in ordered_nodes
            ],
        )

    if snapshot.edges:
        session.execute(
            insert(EdgeModel),
            [
                {
                    "id": edge.id,
                    "project_id": project.id,
                    "source_node_id": edge.source,
                    "target_node_id": edge.target,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                }
                for edge in snapshot.edges
            ],
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


app = FastAPI(title="Project Planner Workflow Service", version="0.2.0")


@app.get("/api/health")
def health(session: Session = Depends(get_session)):
    session.execute(select(1))
    return {"status": "ok"}


@app.get("/api/workspaces", response_model=list[WorkspaceListItem])
def list_workspaces(session: Session = Depends(get_session)):
    workspaces = session.scalars(select(WorkspaceModel).order_by(WorkspaceModel.updated_at.desc())).all()
    return [serialize_workspace(workspace) for workspace in workspaces]


@app.post("/api/workspaces", response_model=WorkspaceListItem, status_code=201)
def create_workspace(payload: CreateWorkspaceRequest, session: Session = Depends(get_session)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Workspace name cannot be blank.")
    workspace = WorkspaceModel(id=str(uuid4()), name=name, description=payload.description.strip())
    session.add(workspace)
    session.commit()
    session.refresh(workspace)
    return serialize_workspace(workspace)


@app.get("/api/workspaces/{workspace_id}", response_model=WorkspaceListItem)
def get_workspace(workspace_id: str, session: Session = Depends(get_session)):
    return serialize_workspace(ensure_workspace(session, workspace_id))


@app.patch("/api/workspaces/{workspace_id}", response_model=WorkspaceListItem)
def update_workspace(
    workspace_id: str,
    payload: UpdateWorkspaceRequest,
    session: Session = Depends(get_session),
):
    workspace = ensure_workspace(session, workspace_id)
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(status_code=422, detail="Workspace name cannot be blank.")
        workspace.name = name
    if payload.description is not None:
        workspace.description = payload.description.strip()
    workspace.updated_at = utc_now()
    session.commit()
    session.refresh(workspace)
    return serialize_workspace(workspace)


@app.delete("/api/workspaces/{workspace_id}", response_model=DeleteWorkspaceResponse)
def delete_workspace(workspace_id: str, session: Session = Depends(get_session)):
    workspace = ensure_workspace(session, workspace_id)
    remaining = session.scalars(
        select(WorkspaceModel)
        .where(WorkspaceModel.id != workspace_id)
        .order_by(WorkspaceModel.updated_at.desc())
    ).all()
    session.delete(workspace)
    session.flush()
    replacement = remaining[0] if remaining else create_default_workspace(session)
    session.commit()
    return DeleteWorkspaceResponse(
        deletedWorkspaceId=workspace_id,
        replacementWorkspaceId=replacement.id,
    )


@app.get("/api/workspaces/{workspace_id}/projects", response_model=list[ProjectListItem])
def list_projects(workspace_id: str, session: Session = Depends(get_session)):
    ensure_workspace(session, workspace_id)
    projects = session.scalars(
        select(ProjectModel)
        .where(ProjectModel.workspace_id == workspace_id)
        .order_by(ProjectModel.updated_at.desc())
    ).all()
    return [serialize_project_list_item(project) for project in projects]


@app.post("/api/workspaces/{workspace_id}/projects", response_model=ProjectGraphResponse, status_code=201)
def create_project(
    workspace_id: str,
    payload: CreateProjectRequest,
    session: Session = Depends(get_session),
):
    workspace = ensure_workspace(session, workspace_id)

    title = (payload.title or "Untitled Project").strip() or "Untitled Project"
    snapshot = payload.project or PlannerSnapshotPayload(root=RootPayload(title=title), nodes=[], edges=[])
    validate_snapshot(snapshot)

    project = ProjectModel(
        id=str(uuid4()),
        workspace_id=workspace.id,
        title=snapshot.root.title or title,
        description=snapshot.root.description,
        completion_criteria=snapshot.root.completionCriteria,
        tags=list(snapshot.root.tags),
        graph_version=1,
    )
    workspace.updated_at = utc_now()
    session.add(project)
    session.flush()
    replace_graph(session, project, snapshot)
    session.commit()
    session.refresh(project)
    return ProjectGraphResponse(workspaceId=workspace.id, projectId=project.id, project=serialize_project(project))


@app.get("/api/workspaces/{workspace_id}/projects/{project_id}", response_model=ProjectListItem)
def get_project(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    return serialize_project_list_item(ensure_project(session, workspace_id, project_id))


@app.get("/api/workspaces/{workspace_id}/projects/{project_id}/graph", response_model=ProjectGraphResponse)
def get_project_graph(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    project = ensure_project(session, workspace_id, project_id)
    return ProjectGraphResponse(workspaceId=workspace_id, projectId=project.id, project=serialize_project(project))


@app.patch("/api/workspaces/{workspace_id}/projects/{project_id}", response_model=ProjectGraphResponse)
def update_project(
    workspace_id: str,
    project_id: str,
    payload: UpdateProjectRequest,
    session: Session = Depends(get_session),
):
    project = ensure_project(session, workspace_id, project_id)
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
    project.workspace.updated_at = project.updated_at
    session.commit()
    session.refresh(project)
    return ProjectGraphResponse(workspaceId=workspace_id, projectId=project.id, project=serialize_project(project))


@app.delete("/api/workspaces/{workspace_id}/projects/{project_id}", response_model=DeleteProjectResponse)
def delete_project(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    project = ensure_project(session, workspace_id, project_id)
    workspace = project.workspace
    session.delete(project)
    workspace.updated_at = utc_now()
    session.commit()
    return DeleteProjectResponse(deletedProjectId=project_id)


@app.post(
    "/api/workspaces/{workspace_id}/projects/{project_id}/operations",
    response_model=ProjectGraphResponse,
)
def apply_project_operations(
    workspace_id: str,
    project_id: str,
    payload: OperationsRequest,
    session: Session = Depends(get_session),
):
    project = ensure_project(session, workspace_id, project_id)
    try:
        apply_operations(session, project, payload.operations)
        project.workspace.updated_at = utc_now()
        session.commit()
    except IntegrityError as error:
        session.rollback()
        raise HTTPException(status_code=400, detail="Duplicate edge or invalid graph mutation.") from error

    session.refresh(project)
    return ProjectGraphResponse(workspaceId=workspace_id, projectId=project.id, project=serialize_project(project))
