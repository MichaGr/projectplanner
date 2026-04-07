from __future__ import annotations

from fastapi import APIRouter, Depends

from ..schemas.settings import AppSettingsResponse, ModelOption, NotionSettingsUpdate, OpenAISettingsUpdate
from ..services.model_service import ModelService
from ..services.settings_service import SettingsService
from .dependencies import get_model_service, get_settings_repository, get_settings_service

router = APIRouter()


@router.get("/api/settings", response_model=AppSettingsResponse)
def get_settings(settings_service: SettingsService = Depends(get_settings_service)) -> AppSettingsResponse:
    return settings_service.get_settings()


@router.post("/api/settings/openai", response_model=AppSettingsResponse)
def update_openai_settings(
    payload: OpenAISettingsUpdate,
    settings_service: SettingsService = Depends(get_settings_service),
) -> AppSettingsResponse:
    return settings_service.update_openai_settings(payload)


@router.post("/api/settings/notion", response_model=AppSettingsResponse)
def update_notion_settings(
    payload: NotionSettingsUpdate,
    settings_service: SettingsService = Depends(get_settings_service),
) -> AppSettingsResponse:
    return settings_service.update_notion_settings(payload)


@router.get("/api/models", response_model=list[ModelOption])
def get_models(
    repository=Depends(get_settings_repository),
    model_service: ModelService = Depends(get_model_service),
) -> list[ModelOption]:
    settings = repository.load()
    if not settings.api_key:
        from ..core.errors import ServiceError

        raise ServiceError(400, "Configure an OpenAI API key first.")
    return model_service.list_supported_models(settings.api_key)
