from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, UploadFile

from ..planner.graph import PlannerEngine
from ..schemas.planner import AIDocument, AIChatRequest, AIChatResponse
from ..services.chat_service import ChatService
from ..services.document_service import DocumentService
from .dependencies import get_chat_service, get_document_service, get_planner_engine

router = APIRouter()


@router.post("/api/ai/documents", response_model=list[AIDocument])
async def upload_ai_documents(
    files: list[UploadFile] = File(...),
    document_service: DocumentService = Depends(get_document_service),
) -> list[AIDocument]:
    return await document_service.upload_documents(files)


@router.post("/api/ai/chat", response_model=AIChatResponse)
def chat(payload: AIChatRequest, chat_service: ChatService = Depends(get_chat_service)) -> AIChatResponse:
    return chat_service.chat(payload)


@router.get("/api/ai/graph")
def get_ai_graph(planner_engine: PlannerEngine = Depends(get_planner_engine)) -> dict[str, Any]:
    return planner_engine.get_visualization()
