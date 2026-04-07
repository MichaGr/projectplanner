from __future__ import annotations

import os
import uuid
from typing import Any
from io import BytesIO

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pypdf import PdfReader

from .graph import build_graph, get_graph_visualization
from .models import (
    AIDocument,
    AIChatRequest,
    AIChatResponse,
    ApplyProposalRequest,
    AppSettingsResponse,
    ModelOption,
    NotionDatabaseSchemaRequest,
    NotionDatabaseSchemaResponse,
    NotionProgressSyncRequest,
    NotionSettingsUpdate,
    OpenAISettingsUpdate,
)
from .notion import (
    NotionClient,
    build_progress_summary,
    fetch_context_documents,
    get_database_schema,
    validate_notes_database,
    validate_notes_database_schema,
    validate_progress_database,
)
from .settings_store import SettingsStore

app = FastAPI(title="Project Planner AI Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

store = SettingsStore(os.getenv("SETTINGS_PATH", "/app/data/settings.json"))
graph = build_graph()


def _settings_payload() -> AppSettingsResponse:
    settings = store.get()
    return AppSettingsResponse(
        backendStatus="online",
        openai={
            "hasApiKey": bool(settings.get("api_key")),
            "selectedModel": settings.get("selected_model"),
        },
        notion={
            "tokenConfigured": bool(settings.get("notion_token")),
            "notesDatabaseId": settings.get("notion_notes_database_id"),
            "progressDatabaseId": settings.get("notion_progress_database_id"),
            "useNotesForAiContext": bool(settings.get("notion_use_notes_for_ai_context")),
            "enableProgressSync": bool(settings.get("notion_enable_progress_sync")),
            "progressFieldMap": settings.get("notion_progress_field_map") or {},
            "notesFieldMap": settings.get("notion_notes_field_map") or {},
        },
    )


def _supported_model(model_id: str) -> bool:
    blocked_prefixes = ("omni-moderation", "text-embedding", "whisper", "tts", "dall-e", "babbage", "davinci")
    if model_id.startswith(blocked_prefixes):
        return False
    return model_id.startswith(("gpt-", "o1", "o3", "o4"))


def _load_supported_models(api_key: str) -> list[ModelOption]:
    try:
        client = OpenAI(api_key=api_key)
        models = client.models.list()
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Could not load models from OpenAI: {error}") from error

    filtered = [
        ModelOption(id=model.id, label=model.id, ownedBy=getattr(model, "owned_by", None))
        for model in models.data
        if _supported_model(model.id)
    ]
    filtered.sort(key=lambda model: model.id)
    return filtered


def _extract_pdf_document(upload: UploadFile, content: bytes) -> AIDocument:
    try:
        reader = PdfReader(BytesIO(content))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not read PDF '{upload.filename}': {error}") from error

    text = "\n\n".join(part.strip() for part in pages if part.strip()).strip()
    if not text:
        raise HTTPException(status_code=400, detail=f"PDF '{upload.filename}' does not contain extractable text.")

    normalized = " ".join(text.split())
    return AIDocument(
        id=f"doc-{uuid.uuid4().hex[:8]}",
        name=upload.filename or "document.pdf",
        pageCount=len(reader.pages),
        excerpt=normalized[:500],
        content=normalized[:12000],
    )


@app.get("/api/settings", response_model=AppSettingsResponse)
def get_settings() -> AppSettingsResponse:
    return _settings_payload()


@app.post("/api/settings/openai", response_model=AppSettingsResponse)
def update_openai_settings(payload: OpenAISettingsUpdate) -> AppSettingsResponse:
    if payload.apiKey is None and payload.selectedModel is None:
        raise HTTPException(status_code=400, detail="Provide an API key, a model, or both.")

    settings = store.get()
    api_key = payload.apiKey if payload.apiKey is not None else settings.get("api_key")
    selected_model = payload.selectedModel if payload.selectedModel is not None else settings.get("selected_model")

    if payload.selectedModel and not api_key:
        raise HTTPException(status_code=400, detail="Configure an API key before choosing a model.")

    if payload.selectedModel and api_key:
        available_models = _load_supported_models(api_key)
        if not any(model.id == payload.selectedModel for model in available_models):
            raise HTTPException(status_code=400, detail="The selected model is not available for this backend configuration.")

    store.update(
        api_key=payload.apiKey if payload.apiKey is not None else None,
        selected_model=selected_model,
    )

    return _settings_payload()


@app.post("/api/settings/notion", response_model=AppSettingsResponse)
def update_notion_settings(payload: NotionSettingsUpdate) -> AppSettingsResponse:
    current = store.get()
    token = payload.token.strip() if payload.token is not None and payload.token.strip() else current.get("notion_token")
    notes_database_id = payload.notesDatabaseId.strip() if payload.notesDatabaseId else None
    progress_database_id = payload.progressDatabaseId.strip() if payload.progressDatabaseId else None
    progress_field_map = {key: value for key, value in payload.progressFieldMap.items()}
    notes_field_map = {key: value for key, value in payload.notesFieldMap.items()}

    if payload.useNotesForAiContext and not notes_database_id:
        raise HTTPException(status_code=400, detail="Provide a notes database ID before enabling Notion AI context.")
    if payload.enableProgressSync and not progress_database_id:
        raise HTTPException(status_code=400, detail="Provide a progress database ID before enabling Notion progress sync.")
    if (notes_database_id or progress_database_id or payload.useNotesForAiContext or payload.enableProgressSync) and not token:
        raise HTTPException(status_code=400, detail="Provide a Notion integration token before saving Notion settings.")

    if token:
        client = NotionClient(token)
        try:
            if notes_database_id:
                notes_field_map, _ = validate_notes_database_schema(client, notes_database_id, notes_field_map)
            if progress_database_id:
                progress_field_map, _ = validate_progress_database(client, progress_database_id, progress_field_map)
        except RuntimeError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    store.update(
        notion_token=payload.token.strip() if payload.token is not None and payload.token.strip() else None,
        notion_notes_database_id=notes_database_id,
        notion_progress_database_id=progress_database_id,
        notion_use_notes_for_ai_context=payload.useNotesForAiContext,
        notion_enable_progress_sync=payload.enableProgressSync,
        notion_progress_field_map=progress_field_map,
        notion_notes_field_map=notes_field_map,
    )
    return _settings_payload()


@app.post("/api/notion/database-schema", response_model=NotionDatabaseSchemaResponse)
def notion_database_schema(payload: NotionDatabaseSchemaRequest) -> NotionDatabaseSchemaResponse:
    settings = store.get()
    token = payload.token.strip() if payload.token and payload.token.strip() else settings.get("notion_token")
    if not token:
        raise HTTPException(status_code=400, detail="Provide a Notion integration token before loading the schema.")

    try:
        schema = get_database_schema(NotionClient(str(token)), payload.databaseId)
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    return NotionDatabaseSchemaResponse.model_validate(schema)


@app.get("/api/models", response_model=list[ModelOption])
def get_models() -> list[ModelOption]:
    settings = store.get()
    api_key = settings.get("api_key")
    if not api_key:
        raise HTTPException(status_code=400, detail="Configure an OpenAI API key first.")
    return _load_supported_models(api_key)


@app.post("/api/ai/documents", response_model=list[AIDocument])
async def upload_ai_documents(files: list[UploadFile] = File(...)) -> list[AIDocument]:
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one PDF file.")

    documents: list[AIDocument] = []
    for upload in files:
        if not upload.filename or not upload.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF uploads are supported.")
        content = await upload.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"PDF '{upload.filename}' is empty.")
        documents.append(_extract_pdf_document(upload, content))

    return documents


@app.post("/api/ai/chat", response_model=AIChatResponse)
def chat(payload: AIChatRequest) -> AIChatResponse:
    settings = store.get()
    if not settings.get("api_key"):
        raise HTTPException(status_code=400, detail="Configure the OpenAI API key in Settings before using AI assistance.")

    request_payload = payload
    if settings.get("notion_use_notes_for_ai_context") and settings.get("notion_token") and settings.get("notion_notes_database_id"):
        try:
            client = NotionClient(str(settings["notion_token"]))
            notion_documents = fetch_context_documents(
                client,
                database_id=str(settings["notion_notes_database_id"]),
                message=payload.message,
                context=payload.context,
                snapshot=payload.project,
                notes_field_map=settings.get("notion_notes_field_map") if isinstance(settings.get("notion_notes_field_map"), dict) else {},
            )
        except RuntimeError as error:
            raise HTTPException(status_code=502, detail=f"Notion context lookup failed: {error}") from error

        if notion_documents:
            request_payload = payload.model_copy(update={"documents": [*payload.documents, *notion_documents]})

    try:
        result: dict[str, Any] = graph.invoke({"request": request_payload, "settings": settings})
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"AI orchestration failed: {error}") from error

    return AIChatResponse(
        message=result.get("response_message", "Prepared a proposal."),
        proposal=result.get("proposal"),
    )


@app.get("/api/ai/graph")
def get_ai_graph() -> dict[str, Any]:
    return get_graph_visualization()


@app.post("/api/ai/apply")
def apply_proposal(payload: ApplyProposalRequest) -> dict[str, bool]:
    if not payload.proposal.operations:
        raise HTTPException(status_code=400, detail="Proposal contains no operations to apply.")
    return {"accepted": True}


@app.post("/api/notion/progress-sync")
def sync_notion_progress(payload: NotionProgressSyncRequest) -> dict[str, str | int]:
    settings = store.get()
    if not settings.get("notion_enable_progress_sync"):
        raise HTTPException(status_code=400, detail="Enable Notion progress sync in Settings before syncing.")
    if not settings.get("notion_token") or not settings.get("notion_progress_database_id"):
        raise HTTPException(status_code=400, detail="Configure a Notion token and progress database before syncing.")
    if not payload.entries:
        raise HTTPException(status_code=400, detail="There are no tracked planner changes to sync.")

    try:
        client = NotionClient(str(settings["notion_token"]))
        progress_field_map, progress_schema = validate_progress_database(
            client,
            str(settings["notion_progress_database_id"]),
            settings.get("notion_progress_field_map") if isinstance(settings.get("notion_progress_field_map"), dict) else {},
        )
        title, children, properties = build_progress_summary(payload.entries, payload.context, payload.project, progress_field_map)
        client.create_page(
            parent_database_id=str(progress_schema["dataSourceId"]),
            properties=properties,
            children=children,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=502, detail=f"Notion progress sync failed: {error}") from error

    return {"title": title, "syncedEntries": len(payload.entries)}
