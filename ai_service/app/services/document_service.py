from __future__ import annotations

import uuid
from io import BytesIO

from fastapi import UploadFile
from pypdf import PdfReader

from ..core.errors import ServiceError
from ..schemas.planner import AIDocument


class DocumentService:
    def extract_pdf_document(self, upload: UploadFile, content: bytes) -> AIDocument:
        try:
            reader = PdfReader(BytesIO(content))
            pages = [page.extract_text() or "" for page in reader.pages]
        except Exception as error:
            raise ServiceError(400, f"Could not read PDF '{upload.filename}': {error}") from error

        text = "\n\n".join(part.strip() for part in pages if part.strip()).strip()
        if not text:
            raise ServiceError(400, f"PDF '{upload.filename}' does not contain extractable text.")

        normalized = " ".join(text.split())
        return AIDocument(
            id=f"doc-{uuid.uuid4().hex[:8]}",
            name=upload.filename or "document.pdf",
            pageCount=len(reader.pages),
            excerpt=normalized[:500],
            content=normalized[:12000],
        )

    async def upload_documents(self, files: list[UploadFile]) -> list[AIDocument]:
        if not files:
            raise ServiceError(400, "Upload at least one PDF file.")

        documents: list[AIDocument] = []
        for upload in files:
            if not upload.filename or not upload.filename.lower().endswith(".pdf"):
                raise ServiceError(400, "Only PDF uploads are supported.")
            content = await upload.read()
            if not content:
                raise ServiceError(400, f"PDF '{upload.filename}' is empty.")
            documents.append(self.extract_pdf_document(upload, content))
        return documents
