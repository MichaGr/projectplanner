from __future__ import annotations

import os
import base64
import hashlib
import hmac
import json
import time
from datetime import date, datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, create_engine, delete, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, selectinload, sessionmaker


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
    tags: Mapped[list[str]] = mapped_column(JSONB, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
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
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)
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
    due_date: Mapped[date | None] = mapped_column(nullable=True)
    do_date: Mapped[date | None] = mapped_column(nullable=True)
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

SESSION_COOKIE_NAME = "projectplanner_session"
PUBLIC_API_PATHS = {
    "/api/health",
    "/api/auth/login",
    "/api/auth/logout",
    "/api/auth/session",
}
login_attempts: dict[str, dict[str, float | list[float]]] = {}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def get_required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} must be set.")
    return value


def get_auth_config() -> dict[str, str | int | bool]:
    username = get_required_env("APP_LOGIN_USERNAME")
    password = get_required_env("APP_LOGIN_PASSWORD")
    session_secret = get_required_env("APP_SESSION_SECRET")
    return {
        "username": username,
        "password": password,
        "session_secret": session_secret,
        "session_max_age_seconds": max(60, int(os.getenv("APP_SESSION_MAX_AGE_SECONDS", "43200"))),
        "session_secure": os.getenv("APP_SESSION_SECURE", "false").strip().lower() in {"1", "true", "yes", "on"},
    }


def validate_runtime_auth_config() -> None:
    get_auth_config()


def get_login_limits() -> dict[str, int]:
    return {
        "max_attempts": max(1, int(os.getenv("APP_LOGIN_MAX_ATTEMPTS", "5"))),
        "window_seconds": max(1, int(os.getenv("APP_LOGIN_WINDOW_SECONDS", "300"))),
        "lockout_seconds": max(1, int(os.getenv("APP_LOGIN_LOCKOUT_SECONDS", "900"))),
    }


def encode_session_cookie(username: str) -> str:
    config = get_auth_config()
    payload = {
        "u": username,
        "exp": int(time.time()) + int(config["session_max_age_seconds"]),
    }
    payload_bytes = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_token = base64.urlsafe_b64encode(payload_bytes).decode("ascii").rstrip("=")
    signature = hmac.new(
        str(config["session_secret"]).encode("utf-8"),
        payload_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{payload_token}.{signature}"


def decode_session_cookie(token: str | None) -> dict[str, str | int] | None:
    if not token or "." not in token:
        return None
    payload_token, signature = token.rsplit(".", 1)
    expected_signature = hmac.new(
        str(get_auth_config()["session_secret"]).encode("utf-8"),
        payload_token.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(signature, expected_signature):
        return None

    padding = "=" * (-len(payload_token) % 4)
    try:
        payload_bytes = base64.urlsafe_b64decode(f"{payload_token}{padding}")
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None

    if not isinstance(payload, dict):
        return None
    username = payload.get("u")
    expires_at = payload.get("exp")
    if not isinstance(username, str) or not isinstance(expires_at, int):
        return None
    if expires_at <= int(time.time()):
        return None
    return {"username": username, "expires_at": expires_at}


def get_client_ip(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        first_hop = forwarded_for.split(",")[0].strip()
        if first_hop:
            return first_hop
    return request.client.host if request.client else "unknown"


def trim_attempts(now: float, attempts: list[float]) -> list[float]:
    return [attempt for attempt in attempts if now - attempt <= get_login_limits()["window_seconds"]]


def is_login_blocked(request: Request) -> bool:
    entry = login_attempts.get(get_client_ip(request))
    now = time.time()
    if not entry:
        return False
    lock_until = float(entry.get("lock_until", 0))
    if lock_until > now:
        return True
    if lock_until:
        login_attempts.pop(get_client_ip(request), None)
    return False


def record_failed_login(request: Request) -> None:
    ip = get_client_ip(request)
    now = time.time()
    limits = get_login_limits()
    entry = login_attempts.get(ip, {"attempts": [], "lock_until": 0.0})
    attempts = trim_attempts(now, list(entry.get("attempts", []))) + [now]
    lock_until = float(entry.get("lock_until", 0))
    if len(attempts) >= limits["max_attempts"]:
        lock_until = now + limits["lockout_seconds"]
        attempts = []
    login_attempts[ip] = {"attempts": attempts, "lock_until": lock_until}


def clear_failed_logins(request: Request) -> None:
    login_attempts.pop(get_client_ip(request), None)


def is_authenticated_request(request: Request) -> tuple[bool, str | None]:
    session = decode_session_cookie(request.cookies.get(SESSION_COOKIE_NAME))
    if not session:
        return False, None
    username = session["username"]
    expected_username = str(get_auth_config()["username"])
    if not hmac.compare_digest(str(username), expected_username):
        return False, None
    return True, str(username)


def set_session_cookie(response: Response, username: str) -> None:
    config = get_auth_config()
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=encode_session_cookie(username),
        max_age=int(config["session_max_age_seconds"]),
        httponly=True,
        secure=bool(config["session_secure"]),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        httponly=True,
        secure=bool(get_auth_config()["session_secure"]),
        samesite="lax",
        path="/",
    )


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
    createdAt: datetime | None = None
    dueDate: date | None = None
    doDate: date | None = None
    parentId: str | None = None
    size: dict[str, float] | None = None

    @model_validator(mode="after")
    def validate_schedule(self):
        if self.doDate and self.dueDate and self.doDate > self.dueDate:
            raise ValueError("Do date cannot be later than due date.")
        return self


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
    tags: list[str] | None = None


class CreateProjectRequest(BaseModel):
    title: str | None = None
    project: PlannerSnapshotPayload | None = None


class UpdateProjectRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    completionCriteria: str | None = None
    tags: list[str] | None = None


class UpdateRootOperation(BaseModel):
    type: Literal["update_root"]
    root: RootPayload


class UpsertNodesOperation(BaseModel):
    type: Literal["upsert_nodes"]
    nodes: list[NodePayload]


class DeleteNodesOperation(BaseModel):
    type: Literal["delete_nodes"]
    nodeIds: list[str]


class UpsertEdgesOperation(BaseModel):
    type: Literal["upsert_edges"]
    edges: list[EdgePayload]


class DeleteEdgesOperation(BaseModel):
    type: Literal["delete_edges"]
    edgeIds: list[str]


class ReplaceGraphOperation(BaseModel):
    type: Literal["replace_graph"]
    project: PlannerSnapshotPayload


GraphOperation = (
    UpdateRootOperation
    | UpsertNodesOperation
    | DeleteNodesOperation
    | UpsertEdgesOperation
    | DeleteEdgesOperation
    | ReplaceGraphOperation
)


class OperationsRequest(BaseModel):
    transactionId: str
    baseGraphVersion: int
    operations: list[GraphOperation]


class ProjectGraphResponse(BaseModel):
    workspaceId: str
    projectId: str
    graphVersion: int
    project: PlannerSnapshotPayload


class ApplyProjectOperationsAcceptedResponse(ProjectGraphResponse):
    status: Literal["accepted"]
    transactionId: str


class ApplyProjectOperationsRejectedResponse(ProjectGraphResponse):
    status: Literal["rejected"]
    transactionId: str
    code: str
    message: str


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
    tags: list[str]
    projectCount: int
    createdAt: str
    updatedAt: str
    projects: list[ProjectListItem]


class DeleteWorkspaceResponse(BaseModel):
    deletedWorkspaceId: str
    replacementWorkspaceId: str


class DeleteProjectResponse(BaseModel):
    deletedProjectId: str


class ReorderWorkspacesRequest(BaseModel):
    workspaceIds: list[str]


class ReorderProjectsRequest(BaseModel):
    projectIds: list[str]


class AvailableTaskItem(BaseModel):
    workspaceId: str
    workspaceName: str
    projectId: str
    projectTitle: str
    taskId: str
    title: str


class CompleteTaskResponse(BaseModel):
    workspaceId: str
    projectId: str
    taskId: str
    status: Literal["done"]
    graphVersion: int


class LoginRequest(BaseModel):
    username: str = ""
    password: str = ""


class AuthSessionResponse(BaseModel):
    authenticated: bool
    username: str | None = None


def serialize_project_response(project: ProjectModel, workspace_id: str | None = None) -> ProjectGraphResponse:
    return ProjectGraphResponse(
        workspaceId=workspace_id or project.workspace_id,
        projectId=project.id,
        graphVersion=project.graph_version,
        project=serialize_project(project),
    )


def build_rejected_operations_response(
    *,
    project: ProjectModel,
    transaction_id: str,
    code: str,
    message: str,
    workspace_id: str | None = None,
) -> ApplyProjectOperationsRejectedResponse:
    response = serialize_project_response(project, workspace_id)
    return ApplyProjectOperationsRejectedResponse(
        status="rejected",
        transactionId=transaction_id,
        code=code,
        message=message,
        **response.model_dump(),
    )


def normalize_tag(value: str) -> str:
    return ".".join(segment.strip() for segment in value.split(".") if segment.strip())


def normalize_tags(tags: list[str]) -> list[str]:
    normalized: set[str] = set()
    for tag in tags:
        value = normalize_tag(tag)
        if value:
            normalized.add(value)
    return sorted(normalized)


def collect_snapshot_tags(snapshot: PlannerSnapshotPayload) -> list[str]:
    return normalize_tags([
        *snapshot.root.tags,
        *(tag for node in snapshot.nodes for tag in node.tags),
    ])


def serialize_project(project: ProjectModel) -> PlannerSnapshotPayload:
    nodes = sorted(project.nodes, key=lambda node: node.id)
    edges = sorted(project.edges, key=lambda edge: edge.id)

    return PlannerSnapshotPayload(
        root=RootPayload(
            title=project.title,
            description=project.description,
            completionCriteria=project.completion_criteria,
            tags=[],
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
                createdAt=node.created_at,
                dueDate=node.due_date,
                doDate=node.do_date,
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
    projects = sorted(workspace.projects, key=lambda project: (project.sort_order, project.updated_at), reverse=False)
    return WorkspaceListItem(
        workspaceId=workspace.id,
        name=workspace.name,
        description=workspace.description,
        tags=normalize_tags(list(workspace.tags or [])),
        projectCount=len(projects),
        createdAt=workspace.created_at.isoformat(),
        updatedAt=workspace.updated_at.isoformat(),
        projects=[serialize_project_list_item(project) for project in projects],
    )


def next_workspace_sort_order(session: Session) -> int:
    orders = session.scalars(select(WorkspaceModel.sort_order)).all()
    return (max(orders) + 1) if orders else 0


def next_project_sort_order(session: Session, workspace_id: str) -> int:
    orders = session.scalars(select(ProjectModel.sort_order).where(ProjectModel.workspace_id == workspace_id)).all()
    return (max(orders) + 1) if orders else 0


def reorder_workspaces_in_session(session: Session, workspace_ids: list[str]) -> list[WorkspaceModel]:
    workspaces = session.scalars(select(WorkspaceModel)).all()
    by_id = {workspace.id: workspace for workspace in workspaces}
    if set(workspace_ids) != set(by_id):
        raise HTTPException(status_code=400, detail="workspaceIds must include every workspace exactly once.")
    for index, workspace_id in enumerate(workspace_ids):
        by_id[workspace_id].sort_order = index
    return sorted(workspaces, key=lambda workspace: workspace.sort_order)


def reorder_projects_in_session(session: Session, workspace_id: str, project_ids: list[str]) -> list[ProjectModel]:
    projects = session.scalars(select(ProjectModel).where(ProjectModel.workspace_id == workspace_id)).all()
    by_id = {project.id: project for project in projects}
    if set(project_ids) != set(by_id):
        raise HTTPException(status_code=400, detail="projectIds must include every project in the workspace exactly once.")
    for index, project_id in enumerate(project_ids):
        by_id[project_id].sort_order = index
    return sorted(projects, key=lambda project: project.sort_order)


def create_default_workspace(session: Session) -> WorkspaceModel:
    workspace = WorkspaceModel(
        id=str(uuid4()),
        name="Default Workspace",
        description="",
        tags=[],
        sort_order=next_workspace_sort_order(session),
    )
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


def load_project_graph(session: Session, workspace_id: str, project_id: str, *, for_update: bool = False) -> ProjectModel:
    query = (
        select(ProjectModel)
        .where(ProjectModel.id == project_id, ProjectModel.workspace_id == workspace_id)
        .options(
            selectinload(ProjectModel.workspace),
            selectinload(ProjectModel.nodes),
            selectinload(ProjectModel.edges),
        )
    )
    if for_update:
        query = query.with_for_update()
    project = session.scalar(query)
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


def build_snapshot_availability_index(snapshot: PlannerSnapshotPayload):
    nodes_by_id = {node.id: node for node in snapshot.nodes}
    children_by_parent: dict[str, list[NodePayload]] = {}
    incoming_by_target: dict[str, list[EdgePayload]] = {}

    for node in snapshot.nodes:
        if node.parentId:
            children_by_parent.setdefault(node.parentId, []).append(node)

    for edge in snapshot.edges:
        incoming_by_target.setdefault(edge.target, []).append(edge)

    descendant_task_ids_cache: dict[str, list[str]] = {}
    completion_cache: dict[str, bool] = {}
    availability_cache: dict[str, bool] = {}
    ancestor_group_ids_cache: dict[str, list[str]] = {}

    def get_descendant_task_ids(node_id: str) -> list[str]:
        cached = descendant_task_ids_cache.get(node_id)
        if cached is not None:
            return cached

        result: list[str] = []
        for child in children_by_parent.get(node_id, []):
            if child.kind == "task":
                result.append(child.id)
            else:
                result.extend(get_descendant_task_ids(child.id))
        descendant_task_ids_cache[node_id] = result
        return result

    def is_node_complete(node_id: str) -> bool:
        cached = completion_cache.get(node_id)
        if cached is not None:
            return cached

        node = nodes_by_id.get(node_id)
        if not node:
            return False

        if node.kind == "task":
            result = node.status == "done"
        else:
            descendant_task_ids = get_descendant_task_ids(node_id)
            result = bool(descendant_task_ids) and all(is_node_complete(task_id) for task_id in descendant_task_ids)
        completion_cache[node_id] = result
        return result

    def get_ancestor_group_ids(node_id: str) -> list[str]:
        cached = ancestor_group_ids_cache.get(node_id)
        if cached is not None:
            return cached

        result: list[str] = []
        parent_id = nodes_by_id.get(node_id).parentId if nodes_by_id.get(node_id) else None
        while parent_id:
            result.append(parent_id)
            parent = nodes_by_id.get(parent_id)
            parent_id = parent.parentId if parent else None
        ancestor_group_ids_cache[node_id] = result
        return result

    def is_task_available(task_id: str) -> bool:
        cached = availability_cache.get(task_id)
        if cached is not None:
            return cached

        node = nodes_by_id.get(task_id)
        if not node or node.kind != "task" or is_node_complete(task_id):
            availability_cache[task_id] = False
            return False

        blockers = list(incoming_by_target.get(task_id, []))
        for group_id in get_ancestor_group_ids(task_id):
            blockers.extend(incoming_by_target.get(group_id, []))

        result = all(is_node_complete(edge.source) for edge in blockers)
        availability_cache[task_id] = result
        return result

    return is_task_available


def available_task_items(projects: list[ProjectModel]) -> list[AvailableTaskItem]:
    items: list[AvailableTaskItem] = []
    for project in projects:
        snapshot = serialize_project(project)
        is_task_available = build_snapshot_availability_index(snapshot)
        for node in snapshot.nodes:
            if node.kind != "task" or not is_task_available(node.id):
                continue
            items.append(
                AvailableTaskItem(
                    workspaceId=project.workspace_id,
                    workspaceName=project.workspace.name,
                    projectId=project.id,
                    projectTitle=project.title,
                    taskId=node.id,
                    title=node.title,
                )
            )
    return sorted(
        items,
        key=lambda item: (
            item.workspaceName.casefold(),
            item.projectTitle.casefold(),
            item.title.casefold(),
            item.taskId,
        ),
    )


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


def apply_snapshot_to_project(session: Session, project: ProjectModel, snapshot: PlannerSnapshotPayload) -> None:
    validate_snapshot(snapshot)

    existing_nodes_by_id = {node.id: node for node in project.nodes}
    existing_edges_by_id = {edge.id: edge for edge in project.edges}
    existing_node_ids = set(existing_nodes_by_id)
    existing_edge_ids = set(existing_edges_by_id)
    next_node_ids = {node.id for node in snapshot.nodes}
    next_edge_ids = {edge.id for edge in snapshot.edges}

    project.title = snapshot.root.title
    project.description = snapshot.root.description
    project.completion_criteria = snapshot.root.completionCriteria
    project.tags = []
    project.workspace.tags = normalize_tags([*list(project.workspace.tags or []), *collect_snapshot_tags(snapshot)])
    project.graph_version += 1
    project.updated_at = utc_now()
    project.workspace.updated_at = project.updated_at

    timestamp = utc_now()
    for edge_id in existing_edge_ids - next_edge_ids:
        session.delete(existing_edges_by_id[edge_id])

    for node_id in existing_node_ids - next_node_ids:
        session.delete(existing_nodes_by_id[node_id])

    ordered_nodes = order_nodes_for_insert(snapshot.nodes)
    for node in ordered_nodes:
        existing = existing_nodes_by_id.get(node.id)
        if existing:
            existing.kind = node.kind
            existing.title = node.title
            existing.status = node.status
            existing.description = node.description
            existing.completion_criteria = node.completionCriteria
            existing.tags = list(node.tags)
            existing.due_date = node.dueDate
            existing.do_date = node.doDate
            existing.parent_node_id = node.parentId
            existing.position_x = node.position["x"]
            existing.position_y = node.position["y"]
            existing.width = node.size["width"] if node.size else None
            existing.height = node.size["height"] if node.size else None
            existing.updated_at = timestamp
            continue

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
                due_date=node.dueDate,
                do_date=node.doDate,
                parent_node_id=node.parentId,
                position_x=node.position["x"],
                position_y=node.position["y"],
                width=node.size["width"] if node.size else None,
                height=node.size["height"] if node.size else None,
                created_at=node.createdAt or timestamp,
                updated_at=timestamp,
            )
        )

    for edge in snapshot.edges:
        existing = existing_edges_by_id.get(edge.id)
        if existing:
            existing.source_node_id = edge.source
            existing.target_node_id = edge.target
            existing.updated_at = timestamp
            continue

        session.add(
            EdgeModel(
                id=edge.id,
                project_id=project.id,
                source_node_id=edge.source,
                target_node_id=edge.target,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )


def apply_operations(session: Session, project: ProjectModel, operations: list[GraphOperation]) -> None:
    snapshot = serialize_project(project)

    for operation in operations:
        if isinstance(operation, ReplaceGraphOperation):
            snapshot = operation.project
            continue

        if isinstance(operation, UpdateRootOperation):
            snapshot.root = operation.root
            continue

        if isinstance(operation, UpsertNodesOperation):
            by_id = {node.id: node for node in snapshot.nodes}
            for node in operation.nodes:
                by_id[node.id] = node
            snapshot.nodes = list(by_id.values())
            continue

        if isinstance(operation, DeleteNodesOperation):
            deleted_ids = set(operation.nodeIds)
            snapshot.nodes = [node for node in snapshot.nodes if node.id not in deleted_ids]
            snapshot.edges = [
                edge
                for edge in snapshot.edges
                if edge.source not in deleted_ids and edge.target not in deleted_ids
            ]
            continue

        if isinstance(operation, UpsertEdgesOperation):
            by_id = {edge.id: edge for edge in snapshot.edges}
            for edge in operation.edges:
                by_id[edge.id] = edge
            snapshot.edges = list(by_id.values())
            continue

        if isinstance(operation, DeleteEdgesOperation):
            deleted_ids = set(operation.edgeIds)
            snapshot.edges = [edge for edge in snapshot.edges if edge.id not in deleted_ids]

    apply_snapshot_to_project(session, project, snapshot)


app = FastAPI(title="Project Planner Workflow Service", version="0.2.0")


@app.middleware("http")
async def require_authenticated_api_session(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API_PATHS:
        authenticated, _ = is_authenticated_request(request)
        if not authenticated:
            return JSONResponse(status_code=401, content={"detail": "Authentication required."})
    return await call_next(request)


@app.get("/api/health")
def health(session: Session = Depends(get_session)):
    session.execute(select(1))
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(payload: LoginRequest, request: Request):
    if is_login_blocked(request):
        raise HTTPException(status_code=429, detail="Too many login attempts. Please try again later.")

    config = get_auth_config()
    username = payload.username.strip()
    password = payload.password
    valid_username = hmac.compare_digest(username, str(config["username"]))
    valid_password = hmac.compare_digest(password, str(config["password"]))
    if not (valid_username and valid_password):
        record_failed_login(request)
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    clear_failed_logins(request)
    response = JSONResponse(status_code=200, content={"authenticated": True, "username": username})
    set_session_cookie(response, username)
    return response


@app.post("/api/auth/logout")
def logout():
    response = JSONResponse(status_code=200, content={"authenticated": False})
    clear_session_cookie(response)
    return response


@app.get("/api/auth/session", response_model=AuthSessionResponse)
def auth_session(request: Request):
    authenticated, username = is_authenticated_request(request)
    if not authenticated:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return AuthSessionResponse(authenticated=True, username=username)


@app.get("/api/workspaces", response_model=list[WorkspaceListItem])
def list_workspaces(session: Session = Depends(get_session)):
    workspaces = session.scalars(select(WorkspaceModel).order_by(WorkspaceModel.sort_order.asc(), WorkspaceModel.updated_at.desc())).all()
    if not workspaces:
        workspace = create_default_workspace(session)
        session.commit()
        session.refresh(workspace)
        workspaces = [workspace]
    return [serialize_workspace(workspace) for workspace in workspaces]


@app.get("/api/available-tasks", response_model=list[AvailableTaskItem])
def list_available_tasks(
    scope: Literal["all", "workspace", "project"] = Query(default="project"),
    workspace_id: str | None = Query(default=None, alias="workspaceId"),
    project_id: str | None = Query(default=None, alias="projectId"),
    session: Session = Depends(get_session),
):
    query = select(ProjectModel).options(
        selectinload(ProjectModel.workspace),
        selectinload(ProjectModel.nodes),
        selectinload(ProjectModel.edges),
    )

    if scope == "workspace":
        if not workspace_id:
            raise HTTPException(status_code=422, detail="workspaceId is required for workspace scope.")
        ensure_workspace(session, workspace_id)
        query = query.where(ProjectModel.workspace_id == workspace_id)
    elif scope == "project":
        if not workspace_id or not project_id:
            raise HTTPException(status_code=422, detail="workspaceId and projectId are required for project scope.")
        ensure_project(session, workspace_id, project_id)
        query = query.where(ProjectModel.id == project_id, ProjectModel.workspace_id == workspace_id)

    projects = list(session.scalars(query).all())
    return available_task_items(projects)


@app.post("/api/workspaces", response_model=WorkspaceListItem, status_code=201)
def create_workspace(payload: CreateWorkspaceRequest, session: Session = Depends(get_session)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Workspace name cannot be blank.")
    workspace = WorkspaceModel(
        id=str(uuid4()),
        name=name,
        description=payload.description.strip(),
        sort_order=next_workspace_sort_order(session),
    )
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
    if payload.tags is not None:
        workspace.tags = normalize_tags(payload.tags)
    workspace.updated_at = utc_now()
    session.commit()
    session.refresh(workspace)
    return serialize_workspace(workspace)


@app.post("/api/workspaces/reorder", response_model=list[WorkspaceListItem])
def reorder_workspaces(payload: ReorderWorkspacesRequest, session: Session = Depends(get_session)):
    ordered_workspaces = reorder_workspaces_in_session(session, payload.workspaceIds)
    session.commit()
    return [serialize_workspace(workspace) for workspace in ordered_workspaces]


@app.delete("/api/workspaces/{workspace_id}", response_model=DeleteWorkspaceResponse)
def delete_workspace(workspace_id: str, session: Session = Depends(get_session)):
    workspace = ensure_workspace(session, workspace_id)
    remaining = session.scalars(
        select(WorkspaceModel)
        .where(WorkspaceModel.id != workspace_id)
        .order_by(WorkspaceModel.sort_order.asc(), WorkspaceModel.updated_at.desc())
    ).all()
    session.delete(workspace)
    session.flush()
    for index, remaining_workspace in enumerate(remaining):
        remaining_workspace.sort_order = index
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
        .order_by(ProjectModel.sort_order.asc(), ProjectModel.updated_at.desc())
    ).all()
    return [serialize_project_list_item(project) for project in projects]


@app.post("/api/workspaces/{workspace_id}/projects/reorder", response_model=list[ProjectListItem])
def reorder_projects(workspace_id: str, payload: ReorderProjectsRequest, session: Session = Depends(get_session)):
    ensure_workspace(session, workspace_id)
    ordered_projects = reorder_projects_in_session(session, workspace_id, payload.projectIds)
    session.commit()
    return [serialize_project_list_item(project) for project in ordered_projects]


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
        tags=[],
        sort_order=next_project_sort_order(session, workspace.id),
        graph_version=1,
    )
    workspace.tags = normalize_tags([*list(workspace.tags or []), *collect_snapshot_tags(snapshot)])
    workspace.updated_at = utc_now()
    session.add(project)
    session.flush()
    apply_snapshot_to_project(session, project, snapshot)
    session.commit()
    stored_project = load_project_graph(session, workspace.id, project.id)
    return serialize_project_response(stored_project, workspace.id)


@app.get("/api/workspaces/{workspace_id}/projects/{project_id}", response_model=ProjectListItem)
def get_project(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    return serialize_project_list_item(ensure_project(session, workspace_id, project_id))


@app.get("/api/workspaces/{workspace_id}/projects/{project_id}/graph", response_model=ProjectGraphResponse)
def get_project_graph(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    project = load_project_graph(session, workspace_id, project_id)
    return serialize_project_response(project, workspace_id)


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
        project.workspace.tags = normalize_tags([*list(project.workspace.tags or []), *payload.tags])
    project.tags = []
    project.graph_version += 1
    project.updated_at = utc_now()
    project.workspace.updated_at = project.updated_at
    session.commit()
    session.refresh(project)
    return serialize_project_response(project, workspace_id)


@app.delete("/api/workspaces/{workspace_id}/projects/{project_id}", response_model=DeleteProjectResponse)
def delete_project(workspace_id: str, project_id: str, session: Session = Depends(get_session)):
    project = ensure_project(session, workspace_id, project_id)
    workspace = project.workspace
    session.delete(project)
    remaining_projects = session.scalars(
        select(ProjectModel)
        .where(ProjectModel.workspace_id == workspace_id, ProjectModel.id != project_id)
        .order_by(ProjectModel.sort_order.asc(), ProjectModel.updated_at.desc())
    ).all()
    for index, remaining_project in enumerate(remaining_projects):
        remaining_project.sort_order = index
    workspace.updated_at = utc_now()
    session.commit()
    return DeleteProjectResponse(deletedProjectId=project_id)


@app.post(
    "/api/workspaces/{workspace_id}/projects/{project_id}/tasks/{task_id}/complete",
    response_model=CompleteTaskResponse,
)
def complete_available_task(
    workspace_id: str,
    project_id: str,
    task_id: str,
    session: Session = Depends(get_session),
):
    project = load_project_graph(session, workspace_id, project_id, for_update=True)

    task = next((node for node in project.nodes if node.id == task_id), None)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found.")
    if task.kind != "task":
        raise HTTPException(status_code=409, detail="Only tasks can be completed.")
    if task.status == "done":
        raise HTTPException(status_code=409, detail="Task is already complete.")
    if not build_snapshot_availability_index(serialize_project(project))(task_id):
        raise HTTPException(status_code=409, detail="Task is no longer available.")

    timestamp = utc_now()
    task.status = "done"
    task.updated_at = timestamp
    project.graph_version += 1
    project.updated_at = timestamp
    project.workspace.updated_at = timestamp
    session.commit()

    return CompleteTaskResponse(
        workspaceId=workspace_id,
        projectId=project_id,
        taskId=task_id,
        status="done",
        graphVersion=project.graph_version,
    )


@app.post(
    "/api/workspaces/{workspace_id}/projects/{project_id}/operations",
    response_model=ApplyProjectOperationsAcceptedResponse | ApplyProjectOperationsRejectedResponse,
)
def apply_project_operations(
    workspace_id: str,
    project_id: str,
    payload: OperationsRequest,
    session: Session = Depends(get_session),
):
    project = load_project_graph(session, workspace_id, project_id, for_update=True)
    if payload.baseGraphVersion != project.graph_version:
        return build_rejected_operations_response(
            project=project,
            workspace_id=workspace_id,
            transaction_id=payload.transactionId,
            code="stale_graph_version",
            message="The graph changed on the server before this change could be approved.",
        )
    try:
        apply_operations(session, project, payload.operations)
        project.workspace.updated_at = utc_now()
        session.commit()
    except HTTPException as error:
        session.rollback()
        current_project = load_project_graph(session, workspace_id, project_id)
        return build_rejected_operations_response(
            project=current_project,
            workspace_id=workspace_id,
            transaction_id=payload.transactionId,
            code="validation_error",
            message=str(error.detail),
        )
    except IntegrityError as error:
        session.rollback()
        current_project = load_project_graph(session, workspace_id, project_id)
        return build_rejected_operations_response(
            project=current_project,
            workspace_id=workspace_id,
            transaction_id=payload.transactionId,
            code="conflict",
            message="Duplicate edge or invalid graph mutation.",
        )

    stored_project = load_project_graph(session, workspace_id, project_id)
    response = serialize_project_response(stored_project, workspace_id)
    return ApplyProjectOperationsAcceptedResponse(
        status="accepted",
        transactionId=payload.transactionId,
        **response.model_dump(),
    )
