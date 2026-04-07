from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import graph as graph_module
from app import main
from app import notion as notion_module
from app.models import AIDocument, AIChatRequest, ModelOption
from app.settings_store import SettingsStore


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    settings_path = tmp_path / "settings.json"
    monkeypatch.setattr(main, "store", SettingsStore(str(settings_path)))
    return TestClient(main.app)


def sample_project() -> dict:
    return {
        "root": {
            "title": "Main Graph",
            "description": "",
            "completionCriteria": "",
            "tags": [],
        },
        "nodes": [
            {
                "id": "task-0",
                "kind": "task",
                "title": "Approve scope",
                "status": "done",
                "position": {"x": 0, "y": 20},
                "description": "Upstream prerequisite",
                "completionCriteria": "Scope approved",
                "tags": ["Delivery"],
                "parentId": "group-1",
                "size": None,
            },
            {
                "id": "task-1",
                "kind": "task",
                "title": "Plan release",
                "status": "todo",
                "position": {"x": 10, "y": 20},
                "description": "",
                "completionCriteria": "",
                "tags": ["Delivery"],
                "parentId": "group-1",
                "size": None,
            },
            {
                "id": "task-2",
                "kind": "task",
                "title": "Publish notes",
                "status": "todo",
                "position": {"x": 150, "y": 20},
                "description": "Sibling task",
                "completionCriteria": "",
                "tags": ["Delivery"],
                "parentId": "group-1",
                "size": None,
            },
            {
                "id": "group-1",
                "kind": "group",
                "title": "Release work",
                "status": "todo",
                "position": {"x": 100, "y": 200},
                "description": "",
                "completionCriteria": "",
                "tags": [],
                "parentId": None,
                "size": {"width": 320, "height": 170},
            },
        ],
        "edges": [{"id": "edge-1", "source": "task-0", "target": "task-1"}],
    }


def chat_payload(message: str, *, target_type: str = "node", target_id: str | None = "task-1") -> dict:
    target_title = "Plan release" if target_id == "task-1" else "Main Graph"
    if target_type == "group":
        target_title = "Release work"
    if target_type == "root":
        target_title = "Main Graph"

    return {
        "message": message,
        "context": {
            "targetType": target_type,
            "targetId": target_id,
            "targetTitle": target_title,
            "scopeId": None,
        },
        "project": sample_project(),
        "conversation": [],
    }


def test_get_settings_returns_backend_summary(client: TestClient) -> None:
    response = client.get("/api/settings")

    assert response.status_code == 200
    assert response.json() == {
        "backendStatus": "online",
        "openai": {
            "hasApiKey": False,
            "selectedModel": None,
        },
        "notion": {
            "tokenConfigured": False,
            "notesDatabaseId": None,
            "progressDatabaseId": None,
            "useNotesForAiContext": False,
            "enableProgressSync": False,
            "progressFieldMap": {},
            "notesFieldMap": {},
        },
    }


def test_update_openai_settings_rejects_model_without_key(client: TestClient) -> None:
    response = client.post("/api/settings/openai", json={"selectedModel": "gpt-4.1-mini"})

    assert response.status_code == 400
    assert response.json()["detail"] == "Configure an API key before choosing a model."


def test_update_openai_settings_rejects_unavailable_model(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "_load_supported_models",
        lambda api_key: [ModelOption(id="gpt-4.1-mini", label="gpt-4.1-mini", ownedBy="openai")],
    )

    response = client.post(
        "/api/settings/openai",
        json={"apiKey": "sk-test", "selectedModel": "gpt-4.1"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "The selected model is not available for this backend configuration."


def test_update_openai_settings_saves_valid_configuration(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "_load_supported_models",
        lambda api_key: [ModelOption(id="gpt-4.1-mini", label="gpt-4.1-mini", ownedBy="openai")],
    )

    response = client.post(
        "/api/settings/openai",
        json={"apiKey": "sk-test", "selectedModel": "gpt-4.1-mini"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "backendStatus": "online",
        "openai": {
            "hasApiKey": True,
            "selectedModel": "gpt-4.1-mini",
        },
        "notion": {
            "tokenConfigured": False,
            "notesDatabaseId": None,
            "progressDatabaseId": None,
            "useNotesForAiContext": False,
            "enableProgressSync": False,
            "progressFieldMap": {},
            "notesFieldMap": {},
        },
    }


def test_update_notion_settings_rejects_missing_database_for_enabled_feature(client: TestClient) -> None:
    response = client.post(
        "/api/settings/notion",
        json={
            "token": "secret_test",
            "useNotesForAiContext": True,
            "enableProgressSync": False,
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Provide a notes database ID before enabling Notion AI context."


def test_update_notion_settings_rejects_invalid_progress_schema(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "validate_notes_database_schema",
        lambda client, database_id, notes_field_map=None: (
            {"titleField": "Name"},
            {"databaseId": database_id, "dataSourceId": "ds-notes", "title": "Notes DB", "properties": []},
        ),
    )
    monkeypatch.setattr(
        main,
        "validate_progress_database",
        lambda client, database_id, progress_field_map=None: (_ for _ in ()).throw(
            RuntimeError("Progress database schema is invalid: missing: Scope")
        ),
    )

    response = client.post(
        "/api/settings/notion",
        json={
            "token": "secret_test",
            "notesDatabaseId": "notes_db",
            "progressDatabaseId": "progress_db",
            "useNotesForAiContext": True,
            "enableProgressSync": True,
        },
    )

    assert response.status_code == 400
    assert "Progress database schema is invalid" in response.json()["detail"]


def test_update_notion_settings_saves_valid_configuration(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "validate_notes_database_schema",
        lambda client, database_id, notes_field_map=None: (
            {
                "titleField": "Name",
                "summaryField": "Summary",
                "statusField": "Status",
                "tagsField": "Tags",
                "scopeField": "Project",
            },
            {"databaseId": database_id, "dataSourceId": "ds-notes", "title": "Notes DB", "properties": []},
        ),
    )
    monkeypatch.setattr(
        main,
        "validate_progress_database",
        lambda client, database_id, progress_field_map=None: (
            {
                "titleField": "Title",
                "projectNameField": "Project",
                "syncedAtField": "Synced",
                "changedCountField": "Changed",
                "completedCountField": "Completed",
                "scopeField": "Scope",
            },
            {"databaseId": database_id, "dataSourceId": "ds-progress", "title": "Progress DB", "properties": []},
        ),
    )

    response = client.post(
        "/api/settings/notion",
        json={
            "token": "secret_test",
            "notesDatabaseId": "notes_db",
            "progressDatabaseId": "progress_db",
            "useNotesForAiContext": True,
            "enableProgressSync": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["notion"] == {
        "tokenConfigured": True,
        "notesDatabaseId": "notes_db",
        "progressDatabaseId": "progress_db",
        "useNotesForAiContext": True,
        "enableProgressSync": True,
        "progressFieldMap": {
            "titleField": "Title",
            "projectNameField": "Project",
            "syncedAtField": "Synced",
            "changedCountField": "Changed",
            "completedCountField": "Completed",
            "scopeField": "Scope",
        },
        "notesFieldMap": {
            "titleField": "Name",
            "summaryField": "Summary",
            "statusField": "Status",
            "tagsField": "Tags",
            "scopeField": "Project",
        },
    }
    assert "notion_token" in main.store.get()
    assert response.json()["notion"].get("token") is None


def test_notion_database_schema_returns_properties(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "get_database_schema",
        lambda client, database_id: {
            "databaseId": database_id,
            "dataSourceId": "ds-123",
            "title": "Progress Logs",
            "properties": [
                {"id": "title", "name": "Task Name", "type": "title"},
                {"id": "scope", "name": "Team Scope", "type": "rich_text"},
            ],
        },
    )

    response = client.post("/api/notion/database-schema", json={"token": "secret_test", "databaseId": "db-123"})

    assert response.status_code == 200
    assert response.json()["databaseId"] == "db-123"
    assert response.json()["dataSourceId"] == "ds-123"
    assert len(response.json()["properties"]) == 2


def test_get_models_requires_api_key(client: TestClient) -> None:
    response = client.get("/api/models")

    assert response.status_code == 400
    assert response.json()["detail"] == "Configure an OpenAI API key first."


def test_ai_chat_requires_api_key(client: TestClient) -> None:
    response = client.post("/api/ai/chat", json=chat_payload("describe this task"))

    assert response.status_code == 400
    assert response.json()["detail"] == "Configure the OpenAI API key in Settings before using AI assistance."


def test_ai_chat_uses_fallback_routing_when_model_is_unavailable(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main.store.update(api_key="sk-test")
    monkeypatch.setattr(graph_module, "_get_model", lambda settings: (_ for _ in ()).throw(RuntimeError("offline")))

    response = client.post("/api/ai/chat", json=chat_payload("create 3 tasks for this work"))

    assert response.status_code == 200
    payload = response.json()
    assert payload["proposal"]["operations"][0]["type"] == "create_tasks"
    assert len(payload["proposal"]["operations"][0]["tasks"]) >= 2
    assert payload["proposal"]["intentSummary"]
    assert payload["proposal"]["contextSummary"]
    assert payload["proposal"]["changePlan"]
    assert payload["proposal"]["affectedTargets"]


def test_ai_chat_appends_notion_context_documents_when_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    main.store.update(
        api_key="sk-test",
        notion_token="secret_test",
        notion_notes_database_id="notes-db",
        notion_use_notes_for_ai_context=True,
    )

    captured_documents: list[str] = []

    def fake_invoke(payload: dict) -> dict:
        request = payload["request"]
        captured_documents.extend(document.name for document in request.documents)
        return {"response_message": "Prepared a proposal.", "proposal": None}

    monkeypatch.setattr(
        main,
        "fetch_context_documents",
        lambda client, database_id, message, context, snapshot, notes_field_map=None: [
            AIDocument(
                id="notion-1",
                name="Notion: Release notes",
                pageCount=1,
                excerpt="Recent release notes",
                content="Recent release notes and decisions.",
            )
        ],
    )
    monkeypatch.setattr(main, "graph", type("GraphStub", (), {"invoke": staticmethod(fake_invoke)})())

    response = client.post("/api/ai/chat", json=chat_payload("describe this task"))

    assert response.status_code == 200
    assert captured_documents == ["Notion: Release notes"]


def test_ai_chat_handles_no_notion_matches_cleanly(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    main.store.update(
        api_key="sk-test",
        notion_token="secret_test",
        notion_notes_database_id="notes-db",
        notion_use_notes_for_ai_context=True,
    )

    captured_count = {"documents": 0}

    def fake_invoke(payload: dict) -> dict:
        request = payload["request"]
        captured_count["documents"] = len(request.documents)
        return {"response_message": "Prepared a proposal.", "proposal": None}

    monkeypatch.setattr(main, "fetch_context_documents", lambda client, database_id, message, context, snapshot, notes_field_map=None: [])
    monkeypatch.setattr(main, "graph", type("GraphStub", (), {"invoke": staticmethod(fake_invoke)})())

    response = client.post("/api/ai/chat", json=chat_payload("describe this task"))

    assert response.status_code == 200
    assert captured_count["documents"] == 0


def test_get_ai_graph_returns_expected_nodes_and_edges(client: TestClient) -> None:
    response = client.get("/api/ai/graph")

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "langgraph"
    assert payload["version"] == "v1"

    node_ids = {node["id"] for node in payload["nodes"]}
    assert node_ids == {
        "__start__",
        "planner",
        "supervisor",
        "describe_node",
        "define_completion_criteria",
        "create_nodes",
        "split_into_subtasks",
        "proposal_formatter",
        "__end__",
    }

    conditional_edges = [edge for edge in payload["edges"] if edge["type"] == "conditional"]
    assert {edge["label"] for edge in conditional_edges} == {
        "describe_node",
        "define_completion_criteria",
        "create_nodes",
        "split_into_subtasks",
    }
    assert any(edge["source"] == "proposal_formatter" and edge["target"] == "__end__" for edge in payload["edges"])


def test_notion_fetch_context_documents_ranks_and_limits_database_results() -> None:
    request = AIChatRequest.model_validate(chat_payload("x"))

    class FakeClient:
        def __init__(self) -> None:
            self.query_calls: list[dict] = []

        def retrieve_data_source(self, data_source_id: str) -> dict:
            if data_source_id == "notes-db":
                raise RuntimeError("not a data source id")
            return {
                "id": data_source_id,
                "title": [{"plain_text": "Notes"}],
                "properties": {
                    "Name": {"id": "title", "type": "title"},
                    "Summary": {"id": "summary", "type": "rich_text"},
                },
            }

        def retrieve_database(self, database_id: str) -> dict:
            return {"id": database_id, "data_sources": [{"id": "ds-notes"}]}

        def query_data_source(self, data_source_id: str, *, filter_payload=None, page_size: int = 10, start_cursor: str | None = None) -> dict:
            self.query_calls.append({"data_source_id": data_source_id, "page_size": page_size, "start_cursor": start_cursor})
            if start_cursor is None:
                return {
                    "results": [
                        {
                            "id": "page-1",
                            "last_edited_time": "2026-03-25T12:00:00Z",
                            "properties": {
                                "Name": {"type": "title", "title": [{"plain_text": "Plan release architecture"}]},
                                "Summary": {"type": "rich_text", "rich_text": [{"plain_text": "Release architecture decision log"}]},
                            },
                        },
                        {
                            "id": "page-2",
                            "last_edited_time": "2026-01-10T12:00:00Z",
                            "properties": {
                                "Name": {"type": "title", "title": [{"plain_text": "Random brainstorm"}]},
                                "Summary": {"type": "rich_text", "rich_text": [{"plain_text": "Unrelated experiments"}]},
                            },
                        },
                    ],
                    "has_more": True,
                    "next_cursor": "cursor-2",
                }
            return {
                "results": [
                    {
                        "id": "page-3",
                        "last_edited_time": "2026-03-26T12:00:00Z",
                        "properties": {
                            "Name": {"type": "title", "title": [{"plain_text": "Plan release checklist"}]},
                            "Summary": {"type": "rich_text", "rich_text": [{"plain_text": "Completion criteria and release steps"}]},
                        },
                    }
                ],
                "has_more": False,
                "next_cursor": None,
            }

        def retrieve_block_children(self, block_id: str, *, page_size: int = 50) -> dict:
            payload = {
                "page-1": {
                    "results": [
                        {
                            "id": "block-1",
                            "type": "paragraph",
                            "has_children": False,
                            "paragraph": {"rich_text": [{"plain_text": "Detailed plan release architecture notes"}]},
                        }
                    ]
                },
                "page-3": {
                    "results": [
                        {
                            "id": "block-3",
                            "type": "toggle",
                            "has_children": True,
                            "toggle": {"rich_text": [{"plain_text": "Release plan details"}]},
                        }
                    ]
                },
                "block-3": {
                    "results": [
                        {
                            "id": "block-3-child",
                            "type": "bulleted_list_item",
                            "has_children": False,
                            "bulleted_list_item": {"rich_text": [{"plain_text": "Completion criteria for release"}]},
                        }
                    ]
                },
            }
            return payload.get(block_id, {"results": []})

    documents = notion_module.fetch_context_documents(
        FakeClient(),
        database_id="notes-db",
        message='Plan release architecture and "completion criteria"',
        context=request.context,
        snapshot=request.project,
    )

    assert len(documents) == 2
    assert documents[0].name == "Notion: Plan release architecture"
    assert "Why relevant:" in documents[0].content
    assert any("completion criteria" in document.content.lower() for document in documents)


def test_notion_fetch_context_documents_returns_no_low_score_matches() -> None:
    request = AIChatRequest.model_validate(chat_payload("x"))

    class FakeClient:
        def retrieve_data_source(self, data_source_id: str) -> dict:
            if data_source_id == "notes-db":
                raise RuntimeError("not a data source id")
            return {
                "id": data_source_id,
                "title": [{"plain_text": "Notes"}],
                "properties": {
                    "Name": {"id": "title", "type": "title"},
                    "Summary": {"id": "summary", "type": "rich_text"},
                },
            }

        def retrieve_database(self, database_id: str) -> dict:
            return {"id": database_id, "data_sources": [{"id": "ds-notes"}]}

        def query_data_source(self, data_source_id: str, *, filter_payload=None, page_size: int = 10, start_cursor: str | None = None) -> dict:
            return {
                "results": [
                    {
                        "id": "page-1",
                        "last_edited_time": "2026-03-25T12:00:00Z",
                        "properties": {
                            "Name": {"type": "title", "title": [{"plain_text": "Vacation planning"}]},
                            "Summary": {"type": "rich_text", "rich_text": [{"plain_text": "Beach ideas"}]},
                        },
                    }
                ],
                "has_more": False,
                "next_cursor": None,
            }

        def retrieve_block_children(self, block_id: str, *, page_size: int = 50) -> dict:
            return {"results": []}

    documents = notion_module.fetch_context_documents(
        FakeClient(),
        database_id="notes-db",
        message="split this task into subtasks",
        context=request.context,
        snapshot=request.project,
    )

    assert documents == []


def test_ai_chat_split_requires_selected_task(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    main.store.update(api_key="sk-test")
    monkeypatch.setattr(graph_module, "_get_model", lambda settings: (_ for _ in ()).throw(RuntimeError("offline")))

    response = client.post(
        "/api/ai/chat",
        json=chat_payload("split this", target_type="root", target_id=None),
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Split requires a selected task node."


def test_upload_ai_documents_extracts_pdf_content(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        main,
        "_extract_pdf_document",
        lambda upload, content: AIDocument(
            id="doc-test",
            name=upload.filename or "uploaded.pdf",
            pageCount=2,
            excerpt="Milestone plan and scope notes",
            content="Milestone plan and scope notes for the release.",
        ),
    )

    response = client.post(
        "/api/ai/documents",
        files={"files": ("brief.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": "doc-test",
            "name": "brief.pdf",
            "pageCount": 2,
            "excerpt": "Milestone plan and scope notes",
            "content": "Milestone plan and scope notes for the release.",
        }
    ]


def test_upload_ai_documents_rejects_non_pdf(client: TestClient) -> None:
    response = client.post(
        "/api/ai/documents",
        files={"files": ("brief.txt", b"not a pdf", "text/plain")},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Only PDF uploads are supported."


def test_planner_includes_ancestor_surrounding_and_blocker_context(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(graph_module, "_get_model", lambda settings: (_ for _ in ()).throw(RuntimeError("offline")))

    compiled_graph = graph_module.build_graph()
    result = compiled_graph.invoke(
        {
            "request": AIChatRequest.model_validate(chat_payload("improve this task description")),
            "settings": {"api_key": "sk-test", "selected_model": "gpt-4.1-mini"},
        }
    )

    planner_output = result["planner_output"].model_dump()
    bundle = planner_output["contextBundle"]
    assert bundle["target"]["id"] == "task-1"
    assert bundle["ancestorGroup"]["id"] == "group-1"
    assert any(node["id"] == "task-2" for node in bundle["surroundingNodes"])
    assert any(node["id"] == "task-0" for node in bundle["blockingNodes"])
    assert "Project root: Main Graph." in bundle["scopeSummary"]


def test_planner_prompt_uses_uploaded_documents(monkeypatch: pytest.MonkeyPatch) -> None:
    request = AIChatRequest.model_validate(
        {
            **chat_payload("use the uploaded brief to improve this task"),
            "documents": [
                {
                    "id": "doc-1",
                    "name": "brief.pdf",
                    "pageCount": 1,
                    "excerpt": "Release milestones and approvals",
                    "content": "Release milestones and approvals for the upcoming launch.",
                }
            ],
        }
    )

    bundle = graph_module._build_context_bundle(request)
    prompt = graph_module._planner_prompt(request, bundle)

    assert "brief.pdf" in prompt
    assert "Release milestones and approvals" in prompt


@pytest.mark.parametrize(
    ("message", "context", "expected_operations"),
    [
        ("describe this task", {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None}, ["update_node_fields"]),
        (
            "write completion criteria for this task",
            {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None},
            ["update_node_fields"],
        ),
        ("create new tasks here", {"targetType": "group", "targetId": "group-1", "targetTitle": "Release work", "scopeId": None}, ["create_tasks"]),
        (
            "split this task into subtasks",
            {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None},
            ["create_group", "create_tasks", "create_edges"],
        ),
    ],
)
def test_graph_workers_emit_expected_proposal_shapes(
    monkeypatch: pytest.MonkeyPatch,
    message: str,
    context: dict,
    expected_operations: list[str],
) -> None:
    monkeypatch.setattr(graph_module, "_get_model", lambda settings: (_ for _ in ()).throw(RuntimeError("offline")))

    compiled_graph = graph_module.build_graph()
    result = compiled_graph.invoke(
        {
            "request": AIChatRequest.model_validate(
                {
                    "message": message,
                    "context": context,
                    "project": sample_project(),
                    "conversation": [],
                }
            ),
            "settings": {"api_key": "sk-test", "selected_model": "gpt-4.1-mini"},
        }
    )

    proposal = result["proposal"].model_dump()
    assert [operation["type"] for operation in proposal["operations"]] == expected_operations
    assert proposal["context"] == context
    assert proposal["proposalId"].startswith("proposal-")
    assert proposal["summary"]
    assert proposal["intentSummary"]
    assert proposal["contextSummary"]
    assert proposal["changePlan"]
    assert proposal["affectedTargets"]

    if expected_operations == ["update_node_fields"]:
        operation = proposal["operations"][0]
        assert operation["targetId"] == "task-1"
        assert operation["fields"]

    if "create_group" in expected_operations:
        group_operation = proposal["operations"][0]
        task_operation = proposal["operations"][1]
        edge_operation = proposal["operations"][2]
        assert group_operation["group"]["title"]
        assert task_operation["tasks"]
        assert edge_operation["edges"][0]["source"] == group_operation["group"]["id"]


def test_split_fallback_creates_internal_dependency_edges(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(graph_module, "_get_model", lambda settings: (_ for _ in ()).throw(RuntimeError("offline")))

    compiled_graph = graph_module.build_graph()
    result = compiled_graph.invoke(
        {
            "request": AIChatRequest.model_validate(chat_payload("split this task into subtasks")),
            "settings": {"api_key": "sk-test", "selected_model": "gpt-4.1-mini"},
        }
    )

    proposal = result["proposal"].model_dump()
    task_operation = next(operation for operation in proposal["operations"] if operation["type"] == "create_tasks")
    edge_operation = next(operation for operation in proposal["operations"] if operation["type"] == "create_edges")

    created_task_ids = {task["id"] for task in task_operation["tasks"]}
    internal_edges = [
        edge for edge in edge_operation["edges"] if edge["source"] in created_task_ids and edge["target"] in created_task_ids
    ]

    assert len(internal_edges) == 2
    assert any("depends on" in step or "comes before" in step for step in proposal["changePlan"])


def test_notion_progress_sync_rejects_empty_journal(client: TestClient) -> None:
    main.store.update(
        notion_token="secret_test",
        notion_progress_database_id="progress-db",
        notion_enable_progress_sync=True,
    )

    response = client.post(
        "/api/notion/progress-sync",
        json={"project": sample_project(), "context": chat_payload("x")["context"], "entries": []},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "There are no tracked planner changes to sync."


def test_notion_progress_sync_creates_single_entry(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    main.store.update(
        notion_token="secret_test",
        notion_progress_database_id="progress-db",
        notion_enable_progress_sync=True,
        notion_progress_field_map={
            "titleField": "Task Name",
            "projectNameField": "Project",
            "syncedAtField": "Synced",
            "changedCountField": "Changed",
            "completedCountField": "Completed",
            "scopeField": "Team Scope",
        },
    )

    calls: list[dict] = []

    class FakeClient:
        def __init__(self, token: str) -> None:
            self.token = token

        def create_page(self, *, parent_database_id: str, properties: dict, children: list[dict]) -> dict:
            calls.append(
                {
                    "parent_database_id": parent_database_id,
                    "properties": properties,
                    "children": children,
                }
            )
            return {"id": "page-1"}

    monkeypatch.setattr(main, "NotionClient", FakeClient)
    monkeypatch.setattr(
        main,
        "validate_progress_database",
        lambda client, database_id, progress_field_map=None: (
            progress_field_map,
            {"databaseId": database_id, "dataSourceId": "ds-progress", "title": "Progress DB", "properties": []},
        ),
    )

    response = client.post(
        "/api/notion/progress-sync",
        json={
            "project": sample_project(),
            "context": chat_payload("x")["context"],
            "entries": [
                {
                    "type": "status_change",
                    "title": "Completed Plan release",
                    "detail": "Task is now marked done.",
                    "scopeTitle": "Release work",
                    "completed": True,
                }
            ],
        },
    )

    assert response.status_code == 200
    assert response.json()["syncedEntries"] == 1
    assert len(calls) == 1
    assert calls[0]["parent_database_id"] == "ds-progress"
    assert "Task Name" in calls[0]["properties"]
