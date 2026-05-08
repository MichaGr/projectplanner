from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import app


def test_project_round_trip_with_identity_and_memory_scope():
    project_id = f"test-project-identity-{uuid4().hex[:8]}"
    payload = {
        "projectId": project_id,
        "project": {
            "root": {
                "title": "Test Root",
                "description": "desc",
                "completionCriteria": "done",
                "tags": ["Alpha.Root"],
                "conceptId": "root-1",
                "externalRefs": [{"system": "notion", "id": "page-1"}],
                "sourceKind": "human-authored",
                "memoryScope": {
                    "containerTags": [project_id],
                    "metadataDefaults": {"projectId": project_id},
                    "retrievalDefaults": {"limit": 4, "searchMode": "hybrid"},
                },
            },
            "nodes": [
                {
                    "id": "node-1",
                    "kind": "task",
                    "title": "First task",
                    "status": "todo",
                    "position": {"x": 10, "y": 20},
                    "description": "",
                    "completionCriteria": "",
                    "tags": [],
                    "conceptId": "task-1",
                    "externalRefs": [],
                    "sourceKind": "human-authored",
                }
            ],
            "edges": [],
        },
    }
    with TestClient(app) as client:
        response = client.post("/api/projects", json=payload)
    assert response.status_code == 200, response.text
    graph = response.json()["project"]
    assert graph["root"]["conceptId"] == "root-1"
    assert graph["root"]["memoryScope"]["containerTags"] == [project_id]
    assert graph["nodes"][0]["conceptId"] == "task-1"


def test_proposal_persists_and_applies():
    project_id = f"test-project-proposal-{uuid4().hex[:8]}"
    proposal_id = f"proposal-{uuid4().hex[:8]}"
    with TestClient(app) as client:
        create_response = client.post("/api/projects", json={"projectId": project_id, "title": "Proposal Test"})
        assert create_response.status_code == 200

        proposal_payload = {
            "proposalId": proposal_id,
            "projectId": project_id,
            "intent": "create_tasks",
            "mode": "plan",
            "workflow": "planning",
            "summary": "Drafted one task.",
            "rationale": "Test rationale.",
            "graphOperations": [
                {
                    "type": "create_tasks",
                    "tasks": [
                        {
                            "id": "task-apply-1",
                            "kind": "task",
                            "title": "Created from proposal",
                            "status": "todo",
                            "position": {"x": 10, "y": 20},
                            "description": "",
                            "completionCriteria": "",
                            "tags": [],
                            "conceptId": "created-from-proposal",
                            "externalRefs": [],
                            "sourceKind": "ai-generated",
                        }
                    ],
                }
            ],
            "touchedNodeIds": ["task-apply-1"],
            "memoryInsight": "Stored planning decision.",
        }
        proposal_response = client.post("/api/proposals", json=proposal_payload)
        assert proposal_response.status_code == 200, proposal_response.text
        assert proposal_response.json()["status"] == "draft"

        apply_response = client.post(f"/api/proposals/{proposal_id}/apply", json={})
        assert apply_response.status_code == 200, apply_response.text
        assert apply_response.json()["proposal"]["status"] == "applied"
        assert any(node["id"] == "task-apply-1" for node in apply_response.json()["project"]["nodes"])


def test_replace_graph_allows_node_deletion_while_preserving_other_edges():
    project_id = f"test-project-delete-node-{uuid4().hex[:8]}"
    initial_graph = {
        "root": {
            "title": "Delete Test",
            "description": "",
            "completionCriteria": "",
            "tags": [],
        },
        "nodes": [
            {
                "id": "node-a",
                "kind": "task",
                "title": "Node A",
                "status": "todo",
                "position": {"x": 0, "y": 0},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            },
            {
                "id": "node-b",
                "kind": "task",
                "title": "Node B",
                "status": "todo",
                "position": {"x": 120, "y": 0},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            },
            {
                "id": "node-c",
                "kind": "task",
                "title": "Node C",
                "status": "todo",
                "position": {"x": 240, "y": 0},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            },
        ],
        "edges": [
            {"id": "edge-a-c", "source": "node-a", "target": "node-c"},
            {"id": "edge-b-c", "source": "node-b", "target": "node-c"},
        ],
    }

    replacement_graph = {
        "root": initial_graph["root"],
        "nodes": [initial_graph["nodes"][0], initial_graph["nodes"][2]],
        "edges": [{"id": "edge-a-c", "source": "node-a", "target": "node-c"}],
    }

    with TestClient(app) as client:
        create_response = client.post("/api/projects", json={"projectId": project_id, "project": initial_graph})
        assert create_response.status_code == 200, create_response.text

        replace_response = client.post(
            f"/api/projects/{project_id}/operations",
            json={"operations": [{"type": "replace_graph", "project": replacement_graph}]},
        )
        assert replace_response.status_code == 200, replace_response.text
        payload = replace_response.json()["project"]
        assert {node["id"] for node in payload["nodes"]} == {"node-a", "node-c"}
        assert payload["edges"] == [{"id": "edge-a-c", "source": "node-a", "target": "node-c"}]


def test_replace_graph_allows_position_updates_for_existing_nodes():
    project_id = f"test-project-move-node-{uuid4().hex[:8]}"
    initial_graph = {
        "root": {
            "title": "Move Test",
            "description": "",
            "completionCriteria": "",
            "tags": [],
        },
        "nodes": [
            {
                "id": "node-a",
                "kind": "task",
                "title": "Node A",
                "status": "todo",
                "position": {"x": 0, "y": 0},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            },
            {
                "id": "node-b",
                "kind": "task",
                "title": "Node B",
                "status": "todo",
                "position": {"x": 120, "y": 0},
                "description": "",
                "completionCriteria": "",
                "tags": [],
            },
        ],
        "edges": [{"id": "edge-a-b", "source": "node-a", "target": "node-b"}],
    }

    moved_graph = {
        "root": initial_graph["root"],
        "nodes": [
            {**initial_graph["nodes"][0], "position": {"x": 300, "y": 180}},
            initial_graph["nodes"][1],
        ],
        "edges": initial_graph["edges"],
    }

    with TestClient(app) as client:
        create_response = client.post("/api/projects", json={"projectId": project_id, "project": initial_graph})
        assert create_response.status_code == 200, create_response.text

        replace_response = client.post(
            f"/api/projects/{project_id}/operations",
            json={"operations": [{"type": "replace_graph", "project": moved_graph}]},
        )
        assert replace_response.status_code == 200, replace_response.text
        payload = replace_response.json()["project"]
        positions = {node["id"]: node["position"] for node in payload["nodes"]}
        assert positions["node-a"] == {"x": 300, "y": 180}
        assert payload["edges"] == [{"id": "edge-a-b", "source": "node-a", "target": "node-b"}]
