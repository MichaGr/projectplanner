from __future__ import annotations

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import delete

from app.main import SessionLocal, WorkspaceModel, app


@pytest.fixture(autouse=True)
def clean_database():
    with SessionLocal() as session:
        session.execute(delete(WorkspaceModel))
        session.commit()
    yield
    with SessionLocal() as session:
        session.execute(delete(WorkspaceModel))
        session.commit()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def create_workspace(client: TestClient, name: str = "Engineering") -> dict:
    response = client.post("/api/workspaces", json={"name": name, "description": "Delivery workspace"})
    assert response.status_code == 201
    return response.json()


def test_listing_empty_database_recreates_default(client: TestClient):
    listed = client.get("/api/workspaces")

    assert listed.status_code == 200
    assert len(listed.json()) == 1
    assert listed.json()[0]["name"] == "Default Workspace"
    assert listed.json()[0]["projects"] == []


def create_project(client: TestClient, workspace_id: str, title: str = "Launch") -> dict:
    response = client.post(f"/api/workspaces/{workspace_id}/projects", json={"title": title})
    assert response.status_code == 201
    return response.json()


def replace_graph(client: TestClient, workspace_id: str, project_id: str, graph: dict) -> dict:
    project = client.get(f"/api/workspaces/{workspace_id}/projects/{project_id}/graph")
    assert project.status_code == 200
    graph_version = project.json()["graphVersion"]
    response = client.post(
        f"/api/workspaces/{workspace_id}/projects/{project_id}/operations",
        json={
            "transactionId": "replace-graph",
            "baseGraphVersion": graph_version,
            "operations": [{"type": "replace_graph", "project": graph}],
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    return response.json()


def test_workspace_project_crud_and_nested_ownership(client: TestClient):
    workspace = create_workspace(client)
    other_workspace = create_workspace(client, "Research")
    project = create_project(client, workspace["workspaceId"])

    listed = client.get("/api/workspaces").json()
    engineering = next(item for item in listed if item["workspaceId"] == workspace["workspaceId"])
    assert engineering["projectCount"] == 1
    assert engineering["projects"][0]["projectId"] == project["projectId"]

    wrong_scope = client.get(
        f"/api/workspaces/{other_workspace['workspaceId']}/projects/{project['projectId']}/graph"
    )
    assert wrong_scope.status_code == 404

    renamed = client.patch(
        f"/api/workspaces/{workspace['workspaceId']}",
        json={"name": "Product Engineering"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Product Engineering"

    deleted = client.delete(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}"
    )
    assert deleted.status_code == 200
    assert client.get(f"/api/workspaces/{workspace['workspaceId']}/projects").json() == []


def test_graph_operations_remain_workspace_scoped(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"])
    graph = {
        "root": {
            "title": "Scoped Graph",
            "description": "",
            "completionCriteria": "",
            "tags": [],
        },
        "nodes": [
            {
                "id": "task-1",
                "kind": "task",
                "title": "First task",
                "status": "todo",
                "position": {"x": 10, "y": 20},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            }
        ],
        "edges": [],
    }
    response = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/operations",
        json={
            "transactionId": "graph-scope",
            "baseGraphVersion": project["graphVersion"],
            "operations": [{"type": "replace_graph", "project": graph}],
        },
    )
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert response.json()["workspaceId"] == workspace["workspaceId"]
    assert response.json()["project"]["nodes"][0]["id"] == "task-1"


def test_deleting_final_workspace_recreates_default(client: TestClient):
    workspace = create_workspace(client)
    create_project(client, workspace["workspaceId"])

    response = client.delete(f"/api/workspaces/{workspace['workspaceId']}")
    assert response.status_code == 200
    replacement_id = response.json()["replacementWorkspaceId"]
    assert replacement_id != workspace["workspaceId"]

    listed = client.get("/api/workspaces").json()
    assert len(listed) == 1
    assert listed[0]["workspaceId"] == replacement_id
    assert listed[0]["name"] == "Default Workspace"
    assert listed[0]["projects"] == []


def test_available_tasks_support_all_scopes_and_inherited_blockers(client: TestClient):
    alpha = create_workspace(client, "Alpha")
    beta = create_workspace(client, "Beta")
    alpha_project = create_project(client, alpha["workspaceId"], "Alpha Project")
    beta_project = create_project(client, beta["workspaceId"], "Beta Project")

    replace_graph(
        client,
        alpha["workspaceId"],
        alpha_project["projectId"],
        {
            "root": {"title": "Alpha Project", "description": "", "completionCriteria": "", "tags": []},
            "nodes": [
                {"id": "prerequisite", "kind": "task", "title": "Prerequisite", "status": "done", "position": {"x": 0, "y": 0}, "tags": []},
                {"id": "group", "kind": "group", "title": "Phase", "status": "todo", "position": {"x": 100, "y": 0}, "tags": []},
                {"id": "nested", "kind": "task", "title": "Shared title", "status": "todo", "position": {"x": 0, "y": 0}, "parentId": "group", "tags": []},
                {"id": "blocked", "kind": "task", "title": "Blocked", "status": "todo", "position": {"x": 200, "y": 0}, "tags": []},
                {"id": "unfinished", "kind": "task", "title": "Unfinished", "status": "todo", "position": {"x": 300, "y": 0}, "tags": []},
            ],
            "edges": [
                {"id": "edge-group", "source": "prerequisite", "target": "group"},
                {"id": "edge-blocked", "source": "unfinished", "target": "blocked"},
            ],
        },
    )
    replace_graph(
        client,
        beta["workspaceId"],
        beta_project["projectId"],
        {
            "root": {"title": "Beta Project", "description": "", "completionCriteria": "", "tags": []},
            "nodes": [
                {"id": "beta-task", "kind": "task", "title": "Shared title", "status": "todo", "position": {"x": 0, "y": 0}, "tags": []},
            ],
            "edges": [],
        },
    )

    all_tasks = client.get("/api/available-tasks", params={"scope": "all"})
    assert all_tasks.status_code == 200
    assert [(item["workspaceName"], item["projectTitle"], item["title"]) for item in all_tasks.json()] == [
        ("Alpha", "Alpha Project", "Shared title"),
        ("Alpha", "Alpha Project", "Unfinished"),
        ("Beta", "Beta Project", "Shared title"),
    ]

    workspace_tasks = client.get(
        "/api/available-tasks",
        params={"scope": "workspace", "workspaceId": alpha["workspaceId"]},
    )
    assert [item["taskId"] for item in workspace_tasks.json()] == ["nested", "unfinished"]

    project_tasks = client.get(
        "/api/available-tasks",
        params={
            "scope": "project",
            "workspaceId": beta["workspaceId"],
            "projectId": beta_project["projectId"],
        },
    )
    assert [item["taskId"] for item in project_tasks.json()] == ["beta-task"]

    invalid_scope = client.get("/api/available-tasks", params={"scope": "workspace"})
    assert invalid_scope.status_code == 422


def test_complete_available_task_is_targeted_and_increments_graph_version(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"])
    graph = {
        "root": {"title": "Launch", "description": "", "completionCriteria": "", "tags": []},
        "nodes": [
            {"id": "ready", "kind": "task", "title": "Ready", "status": "todo", "position": {"x": 0, "y": 0}, "tags": []},
            {"id": "blocked", "kind": "task", "title": "Blocked", "status": "todo", "position": {"x": 100, "y": 0}, "tags": []},
        ],
        "edges": [{"id": "dependency", "source": "ready", "target": "blocked"}],
    }
    replace_graph(client, workspace["workspaceId"], project["projectId"], graph)
    version_before = client.get(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}"
    ).json()["graphVersion"]

    stale = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/tasks/blocked/complete"
    )
    assert stale.status_code == 409

    completed = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/tasks/ready/complete"
    )
    assert completed.status_code == 200
    assert completed.json()["graphVersion"] == version_before + 1

    graph_after = client.get(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/graph"
    ).json()["project"]
    statuses = {node["id"]: node["status"] for node in graph_after["nodes"]}
    assert statuses == {"blocked": "todo", "ready": "done"}

    repeated = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/tasks/ready/complete"
    )
    assert repeated.status_code == 409


def test_node_metadata_dates_tags_and_created_at_are_persisted(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"], "Scheduled Project")
    graph = {
        "root": {"title": "Scheduled Project", "description": "", "completionCriteria": "", "tags": []},
        "nodes": [
            {
                "id": "scheduled-task",
                "kind": "task",
                "title": "Prepare release",
                "status": "todo",
                "position": {"x": 0, "y": 0},
                "tags": ["Delivery.Release.QA"],
                "doDate": "2026-07-01",
                "dueDate": "2026-07-04",
            }
        ],
        "edges": [],
    }

    stored = replace_graph(client, workspace["workspaceId"], project["projectId"], graph)
    node = stored["project"]["nodes"][0]
    created_at = node["createdAt"]
    assert created_at
    assert node["tags"] == ["Delivery.Release.QA"]
    assert node["doDate"] == "2026-07-01"
    assert node["dueDate"] == "2026-07-04"

    graph["nodes"][0]["title"] = "Prepare final release"
    graph["nodes"][0]["createdAt"] = "2000-01-01T00:00:00Z"
    stored_again = replace_graph(client, workspace["workspaceId"], project["projectId"], graph)
    assert stored_again["project"]["nodes"][0]["createdAt"] == created_at

    graph["nodes"][0]["doDate"] = "2026-07-05"
    invalid = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/operations",
        json={
            "transactionId": "invalid-graph",
            "baseGraphVersion": stored_again["graphVersion"],
            "operations": [{"type": "replace_graph", "project": graph}],
        },
    )
    assert invalid.status_code == 422


def test_workspace_tags_are_global_and_collected_from_project_nodes(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"], "Tagged Project")

    replace_graph(
        client,
        workspace["workspaceId"],
        project["projectId"],
        {
            "root": {"title": "Tagged Project", "description": "", "completionCriteria": "", "tags": [" Legacy.Root.Tag "]},
            "nodes": [
                {
                    "id": "task-1",
                    "kind": "task",
                    "title": "Tag me",
                    "status": "todo",
                    "position": {"x": 0, "y": 0},
                    "tags": ["Delivery.Release.QA", "Delivery.Release.QA", " Research.Users "],
                }
            ],
            "edges": [],
        },
    )

    workspace_response = client.get(f"/api/workspaces/{workspace['workspaceId']}")
    assert workspace_response.status_code == 200
    assert workspace_response.json()["tags"] == ["Delivery.Release.QA", "Legacy.Root.Tag", "Research.Users"]

    graph_response = client.get(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/graph"
    )
    assert graph_response.status_code == 200
    assert graph_response.json()["project"]["root"]["tags"] == []


def test_incremental_graph_operations_update_only_changed_entities(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"], "Incremental Project")

    replace_graph(
        client,
        workspace["workspaceId"],
        project["projectId"],
        {
            "root": {"title": "Incremental Project", "description": "", "completionCriteria": "", "tags": []},
            "nodes": [
                {"id": "a", "kind": "task", "title": "Task A", "status": "todo", "position": {"x": 0, "y": 0}, "tags": []},
                {"id": "b", "kind": "task", "title": "Task B", "status": "todo", "position": {"x": 100, "y": 0}, "tags": []},
            ],
            "edges": [{"id": "ab", "source": "a", "target": "b"}],
        },
    )
    current_version = client.get(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}"
    ).json()["graphVersion"]

    response = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/operations",
        json={
            "transactionId": "incremental-update",
            "baseGraphVersion": current_version,
            "operations": [
                {
                    "type": "upsert_nodes",
                    "nodes": [
                        {
                            "id": "b",
                            "kind": "task",
                            "title": "Task B updated",
                            "status": "done",
                            "position": {"x": 100, "y": 20},
                            "tags": ["Delivery.Release"],
                        },
                        {
                            "id": "c",
                            "kind": "task",
                            "title": "Task C",
                            "status": "todo",
                            "position": {"x": 220, "y": 20},
                            "tags": [],
                        },
                    ],
                },
                {"type": "delete_edges", "edgeIds": ["ab"]},
                {"type": "upsert_edges", "edges": [{"id": "bc", "source": "b", "target": "c"}]},
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    graph = response.json()["project"]
    assert graph["root"]["title"] == "Incremental Project"
    assert {node["id"]: node["title"] for node in graph["nodes"]} == {
        "a": "Task A",
        "b": "Task B updated",
        "c": "Task C",
    }
    assert {node["id"]: node["status"] for node in graph["nodes"]}["b"] == "done"
    assert graph["edges"] == [{"id": "bc", "source": "b", "target": "c"}]


def test_stale_graph_version_is_rejected_with_canonical_graph(client: TestClient):
    workspace = create_workspace(client)
    project = create_project(client, workspace["workspaceId"], "Versioned Project")

    replace_graph(
      client,
      workspace["workspaceId"],
      project["projectId"],
      {
          "root": {"title": "Versioned Project", "description": "", "completionCriteria": "", "tags": []},
          "nodes": [
              {"id": "task-a", "kind": "task", "title": "Task A", "status": "todo", "position": {"x": 0, "y": 0}, "tags": []},
          ],
          "edges": [],
      },
    )

    current = client.get(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/graph"
    ).json()

    accepted = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/operations",
        json={
            "transactionId": "accepted-update",
            "baseGraphVersion": current["graphVersion"],
            "operations": [
                {
                    "type": "upsert_nodes",
                    "nodes": [
                        {"id": "task-a", "kind": "task", "title": "Task A accepted", "status": "todo", "position": {"x": 0, "y": 0}, "tags": []},
                    ],
                }
            ],
        },
    )
    assert accepted.status_code == 200
    assert accepted.json()["status"] == "accepted"

    rejected = client.post(
        f"/api/workspaces/{workspace['workspaceId']}/projects/{project['projectId']}/operations",
        json={
            "transactionId": "stale-update",
            "baseGraphVersion": current["graphVersion"],
            "operations": [
                {
                    "type": "upsert_nodes",
                    "nodes": [
                        {"id": "task-a", "kind": "task", "title": "Task A stale", "status": "done", "position": {"x": 0, "y": 0}, "tags": []},
                    ],
                }
            ],
        },
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["code"] == "stale_graph_version"
    assert rejected.json()["project"]["nodes"][0]["title"] == "Task A accepted"
