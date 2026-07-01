from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
import uvicorn

from app.main import engine, validate_runtime_auth_config


def migrate_database() -> None:
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    with engine.connect() as connection:
        tables = set(inspect(connection).get_table_names())

    if "projects" in tables and "alembic_version" not in tables:
        command.stamp(config, "0001_legacy_schema")

    command.upgrade(config, "head")


if __name__ == "__main__":
    validate_runtime_auth_config()
    migrate_database()
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
