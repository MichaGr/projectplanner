from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import graph as graph_module
from app import main
from app import notion as notion_module
from app.api import dependencies
from app.repositories.settings_repository import SettingsRepository
from app.schemas.notion import NotionDatabaseSchemaResponse
from app.schemas.planner import AIDocument, AIChatRequest
from app.schemas.settings import ModelOption
from app.services.chat_service import ChatService
from app.services.document_service import DocumentService
from app.services.model_service import ModelService
from app.services.notion_service import NotionService
from app.services.settings_service import SettingsService
from app.integrations.openai_client import OpenAIModelClient
from app.planner.graph import PlannerEngine


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


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    repository = SettingsRepository(str(tmp_path / "settings.json"))
    notion_service = NotionService()
    model_service = ModelService(OpenAIModelClient())
    settings_service = SettingsService(repository, model_service, notion_service)
    engine = PlannerEngine(lambda settings: graph_module._get_model(settings))
    chat_service = ChatService(repository, notion_service, engine)
    document_service = DocumentService()

    monkeypatch.setattr(dependencies, "_settings_repository", repository, raising=False)
    monkeypatch.setattr(dependencies, "_model_service", model_service, raising=False)
    monkeypatch.setattr(dependencies, "_notion_service", notion_service, raising=False)
    monkeypatch.setattr(dependencies, "_document_service", document_service, raising=False)
    monkeypatch.setattr(dependencies, "_planner_engine", engine, raising=False)
    monkeypatch.setattr(dependencies, "_settings_service", settings_service, raising=False)
    monkeypatch.setattr(dependencies, "_chat_service", chat_service, raising=False)
    client = TestClient(main.app)
    client.repository = repository  # type: ignore[attr-defined]
    client.model_service = model_service  # type: ignore[attr-defined]
    client.notion_service = notion_service  # type: ignore[attr-defined]
    client.planner_engine = engine  # type: ignore[attr-defined]
    return client


@pytest.fixture(autouse=True)
def clear_overrides() -> None:
    main.app.dependency_overrides = {}
    yield
    main.app.dependency_overrides = {}


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
    model_service = client.model_service  # type: ignore[attr-defined]
    monkeypatch.setattr(
        model_service,
        "list_supported_models",
        lambda api_key: [ModelOption(id="gpt-4.1-mini", label="gpt-4.1-mini", owned_by="openai")],
    )

    response = client.post("/api/settings/openai", json={"apiKey": "sk-test", "selectedModel": "gpt-4.1"})

    assert response.status_code == 400
    assert response.json()["detail"] == "The selected model is not available for this backend configuration."


def test_update_openai_settings_saves_valid_configuration(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    model_service = client.model_service  # type: ignore[attr-defined]
    monkeypatch.setattr(
        model_service,
        "list_supported_models",
        lambda api_key: [ModelOption(id="gpt-4.1-mini", label="gpt-4.1-mini", owned_by="openai")],
    )

    response = client.post("/api/settings/openai", json={"apiKey": "sk-test", "selectedModel": "gpt-4.1-mini"})

    assert response.status_code == 200
    assert response.json()["openai"] == {"hasApiKey": True, "selectedModel": "gpt-4.1-mini"}


def test_update_notion_settings_rejects_missing_database_for_enabled_feature(client: TestClient) -> None:
    response = client.post(
        "/api/settings/notion",
        json={"token": "secret_test", "useNotesForAiContext": True, "enableProgressSync": False},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Provide a notes database ID before enabling Notion AI context."


def test_update_notion_settings_saves_valid_configuration(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    notion_service = client.notion_service  # type: ignore[attr-defined]
    monkeypatch.setattr(
        notion_service,
        "validate_notes_settings",
        lambda token, database_id, notes_field_map: (
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
        notion_service,
        "validate_progress_settings",
        lambda token, database_id, progress_field_map: (
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
    assert response.json()["notion"]["tokenConfigured"] is True
    assert response.json()["notion"]["notesDatabaseId"] == "notes_db"
    assert response.json()["notion"]["progressDatabaseId"] == "progress_db"


def test_notion_database_schema_returns_properties(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    notion_service = client.notion_service  # type: ignore[attr-defined]
    monkeypatch.setattr(
        notion_service,
        "get_database_schema",
        lambda token, database_id: NotionDatabaseSchemaResponse(
            database_id=database_id,
            data_source_id="ds-123",
            title="Progress Logs",
            properties=[
                {"id": "title", "name": "Task Name", "type": "title"},
                {"id": "scope", "name": "Team Scope", "type": "rich_text"},
            ],
        ),
    )

    response = client.post("/api/notion/database-schema", json={"token": "secret_test", "databaseId": "db-123"})

    assert response.status_code == 200
    assert response.json()["databaseId"] == "db-123"
    assert response.json()["dataSourceId"] == "ds-123"


def test_get_models_requires_api_key(client: TestClient) -> None:
    response = client.get("/api/models")

    assert response.status_code == 400
    assert response.json()["detail"] == "Configure an OpenAI API key first."


def test_ai_chat_requires_api_key(client: TestClient) -> None:
    response = client.post("/api/ai/chat", json=chat_payload("describe this task"))

    assert response.status_code == 400
    assert response.json()["detail"] == "Configure the OpenAI API key in Settings before using AI assistance."


def test_ai_chat_uses_fallback_routing_when_model_is_unavailable(client: TestClient) -> None:
    repository = client.repository  # type: ignore[attr-defined]
    repository.update(api_key="sk-test")
    graph_module._get_model = lambda settings: (_ for _ in ()).throw(RuntimeError("offline"))

    response = client.post("/api/ai/chat", json=chat_payload("create 3 tasks for this work"))

    assert response.status_code == 200
    payload = response.json()
    assert payload["proposal"]["operations"][0]["type"] == "create_tasks"
    assert payload["proposal"]["changePlan"]


def test_ai_chat_appends_notion_context_documents_when_enabled(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = client.repository  # type: ignore[attr-defined]
    repository.update(
        api_key="sk-test",
        notion_token="secret_test",
        notion_notes_database_id="notes-db",
        notion_use_notes_for_ai_context=True,
    )
    notion_service = client.notion_service  # type: ignore[attr-defined]
    captured_documents: list[str] = []

    def fake_run_chat(request, settings):
        captured_documents.extend(document.name for document in request.documents)
        return {"response_message": "Prepared a proposal.", "proposal": None}

    monkeypatch.setattr(
        notion_service,
        "fetch_context_documents",
        lambda **kwargs: [
            AIDocument(
                id="notion-1",
                name="Notion: Release notes",
                pageCount=1,
                excerpt="Recent release notes",
                content="Recent release notes and decisions.",
            )
        ],
    )
    monkeypatch.setattr(client.planner_engine, "run_chat", fake_run_chat)  # type: ignore[attr-defined]

    response = client.post("/api/ai/chat", json=chat_payload("describe this task"))

    assert response.status_code == 200
    assert captured_documents == ["Notion: Release notes"]


def test_get_ai_graph_returns_expected_nodes_and_edges(client: TestClient) -> None:
    response = client.get("/api/ai/graph")

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "langgraph"
    assert payload["version"] == "v1"
    assert {node["id"] for node in payload["nodes"]} == {
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


def test_notion_fetch_context_documents_ranks_and_limits_database_results() -> None:
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
    assert {document.name for document in documents} == {
        "Notion: Plan release architecture",
        "Notion: Plan release checklist",
    }


def test_ai_chat_split_requires_selected_task(client: TestClient) -> None:
    repository = client.repository  # type: ignore[attr-defined]
    repository.update(api_key="sk-test")
    graph_module._get_model = lambda settings: (_ for _ in ()).throw(RuntimeError("offline"))

    response = client.post("/api/ai/chat", json=chat_payload("split this", target_type="root", target_id=None))

    assert response.status_code == 400
    assert response.json()["detail"] == "Split requires a selected task node."


def test_upload_ai_documents_rejects_non_pdf(client: TestClient) -> None:
    response = client.post("/api/ai/documents", files={"files": ("brief.txt", b"not a pdf", "text/plain")})

    assert response.status_code == 400
    assert response.json()["detail"] == "Only PDF uploads are supported."


def test_planner_includes_ancestor_surrounding_and_blocker_context() -> None:
    graph_module._get_model = lambda settings: (_ for _ in ()).throw(RuntimeError("offline"))
    compiled_graph = graph_module.build_graph()
    result = compiled_graph.invoke(
        {
            "request": AIChatRequest.model_validate(chat_payload("improve this task description")),
            "settings": {"api_key": "sk-test", "selected_model": "gpt-4.1-mini"},
        }
    )
    bundle = result["planner_output"].model_dump()["contextBundle"]
    assert bundle["target"]["id"] == "task-1"
    assert bundle["ancestorGroup"]["id"] == "group-1"
    assert any(node["id"] == "task-2" for node in bundle["surroundingNodes"])
    assert any(node["id"] == "task-0" for node in bundle["blockingNodes"])


@pytest.mark.parametrize(
    ("message", "context", "expected_operations"),
    [
        ("describe this task", {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None}, ["update_node_fields"]),
        ("write completion criteria for this task", {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None}, ["update_node_fields"]),
        ("create new tasks here", {"targetType": "group", "targetId": "group-1", "targetTitle": "Release work", "scopeId": None}, ["create_tasks"]),
        ("split this task into subtasks", {"targetType": "node", "targetId": "task-1", "targetTitle": "Plan release", "scopeId": None}, ["create_group", "create_tasks", "create_edges"]),
    ],
)
def test_graph_workers_emit_expected_proposal_shapes(message: str, context: dict, expected_operations: list[str]) -> None:
    graph_module._get_model = lambda settings: (_ for _ in ()).throw(RuntimeError("offline"))
    compiled_graph = graph_module.build_graph()
    result = compiled_graph.invoke(
        {
            "request": AIChatRequest.model_validate({"message": message, "context": context, "project": sample_project(), "conversation": []}),
            "settings": {"api_key": "sk-test", "selected_model": "gpt-4.1-mini"},
        }
    )
    proposal = result["proposal"].model_dump()
    assert [operation["type"] for operation in proposal["operations"]] == expected_operations


def test_notion_progress_sync_rejects_empty_journal(client: TestClient) -> None:
    repository = client.repository  # type: ignore[attr-defined]
    repository.update(
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
    repository = client.repository  # type: ignore[attr-defined]
    repository.update(
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
    notion_service = client.notion_service  # type: ignore[attr-defined]
    calls: list[dict] = []

    def fake_sync_progress(**kwargs):
        calls.append(kwargs)
        return {"title": "Sync title", "syncedEntries": 1}

    monkeypatch.setattr(notion_service, "sync_progress", fake_sync_progress)

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
