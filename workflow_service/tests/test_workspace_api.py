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


def create_project(client: TestClient, workspace_id: str, title: str = "Launch") -> dict:
    response = client.post(f"/api/workspaces/{workspace_id}/projects", json={"title": title})
    assert response.status_code == 201
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
        json={"operations": [{"type": "replace_graph", "project": graph}]},
    )
    assert response.status_code == 200
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
