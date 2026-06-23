"""Add workspaces and assign every project to one."""

from datetime import datetime, timezone
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision = "0002_workspaces"
down_revision = "0001_legacy_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.add_column("projects", sa.Column("workspace_id", sa.String(length=255), nullable=True))

    workspace_id = str(uuid4())
    now = datetime.now(timezone.utc)
    workspace_table = sa.table(
        "workspaces",
        sa.column("id", sa.String()),
        sa.column("name", sa.Text()),
        sa.column("description", sa.Text()),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(
        workspace_table,
        [{"id": workspace_id, "name": "Default Workspace", "description": "", "created_at": now, "updated_at": now}],
    )
    op.execute(sa.text("UPDATE projects SET workspace_id = :workspace_id").bindparams(workspace_id=workspace_id))

    op.alter_column("projects", "workspace_id", existing_type=sa.String(length=255), nullable=False)
    op.create_index("ix_projects_workspace_id", "projects", ["workspace_id"], unique=False)
    op.create_foreign_key(
        "projects_workspace_id_fkey",
        "projects",
        "workspaces",
        ["workspace_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint("projects_workspace_id_fkey", "projects", type_="foreignkey")
    op.drop_index("ix_projects_workspace_id", table_name="projects")
    op.drop_column("projects", "workspace_id")
    op.drop_table("workspaces")
