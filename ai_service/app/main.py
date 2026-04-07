from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import ai_router, notion_router, settings_router
from .core.errors import ServiceError


def create_app() -> FastAPI:
    app = FastAPI(title="Project Planner AI Service", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ServiceError)
    async def handle_service_error(_: Request, error: ServiceError) -> JSONResponse:
        return JSONResponse(status_code=error.status_code, content={"detail": error.detail})

    app.include_router(settings_router)
    app.include_router(ai_router)
    app.include_router(notion_router)
    return app


app = create_app()
