from __future__ import annotations

from ..core.config import get_config
from ..integrations.openai_client import OpenAIModelClient, build_chat_model
from ..planner.graph import PlannerEngine
from ..planner_memory.provider import ProjectMemoryProvider
from ..planner_memory.repository import MemoryRepository
from ..repositories.settings_repository import SettingsRepository
from ..services.chat_service import ChatService
from ..services.document_service import DocumentService
from ..services.model_service import ModelService
from ..services.notion_service import NotionService
from ..services.settings_service import SettingsService

_config = get_config()
_settings_repository = SettingsRepository(_config.settings_path)
_memory_repository = MemoryRepository(_config.memory_path)
_memory_provider = ProjectMemoryProvider(_memory_repository)
_model_service = ModelService(OpenAIModelClient())
_notion_service = NotionService()
_document_service = DocumentService()
_planner_engine = PlannerEngine(build_chat_model, _memory_provider)
_settings_service = SettingsService(_settings_repository, _model_service, _notion_service)
_chat_service = ChatService(_settings_repository, _notion_service, _planner_engine)


def get_settings_repository() -> SettingsRepository:
    return _settings_repository


def get_model_service() -> ModelService:
    return _model_service


def get_document_service() -> DocumentService:
    return _document_service


def get_notion_service() -> NotionService:
    return _notion_service


def get_settings_service() -> SettingsService:
    return _settings_service


def get_chat_service() -> ChatService:
    return _chat_service


def get_planner_engine() -> PlannerEngine:
    return _planner_engine
