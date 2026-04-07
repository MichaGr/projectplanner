from __future__ import annotations

from fastapi import APIRouter, Depends

from ..core.errors import ServiceError
from ..schemas.notion import NotionDatabaseSchemaRequest, NotionDatabaseSchemaResponse, NotionProgressSyncRequest
from ..services.notion_service import NotionService
from .dependencies import get_notion_service, get_settings_repository

router = APIRouter()


@router.post("/api/notion/database-schema", response_model=NotionDatabaseSchemaResponse)
def notion_database_schema(
    payload: NotionDatabaseSchemaRequest,
    repository=Depends(get_settings_repository),
    notion_service: NotionService = Depends(get_notion_service),
) -> NotionDatabaseSchemaResponse:
    settings = repository.load()
    token = payload.token.strip() if payload.token and payload.token.strip() else settings.notion_token
    if not token:
        raise ServiceError(400, "Provide a Notion integration token before loading the schema.")
    return notion_service.get_database_schema(token, payload.database_id)


@router.post("/api/notion/progress-sync")
def sync_notion_progress(
    payload: NotionProgressSyncRequest,
    repository=Depends(get_settings_repository),
    notion_service: NotionService = Depends(get_notion_service),
) -> dict[str, str | int]:
    settings = repository.load()
    if not settings.notion_enable_progress_sync:
        raise ServiceError(400, "Enable Notion progress sync in Settings before syncing.")
    if not settings.notion_token or not settings.notion_progress_database_id:
        raise ServiceError(400, "Configure a Notion token and progress database before syncing.")
    if not payload.entries:
        raise ServiceError(400, "There are no tracked planner changes to sync.")

    return notion_service.sync_progress(
        token=settings.notion_token,
        database_id=settings.notion_progress_database_id,
        progress_field_map=settings.notion_progress_field_map,
        entries=payload.entries,
        context=payload.context,
        project=payload.project,
    )
