"""add sort order for workspaces and projects

Revision ID: 0005_sort_order
Revises: 0004_workspace_tags
Create Date: 2026-07-01 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "0005_sort_order"
down_revision = "0004_workspace_tags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("workspaces", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("projects", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_workspaces_sort_order", "workspaces", ["sort_order"], unique=False)
    op.create_index("ix_projects_sort_order", "projects", ["sort_order"], unique=False)

    op.execute(
        """
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS sort_order
          FROM workspaces
        )
        UPDATE workspaces
        SET sort_order = ordered.sort_order
        FROM ordered
        WHERE workspaces.id = ordered.id
        """
    )
    op.execute(
        """
        WITH ordered AS (
          SELECT id, workspace_id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at ASC, id ASC) - 1 AS sort_order
          FROM projects
        )
        UPDATE projects
        SET sort_order = ordered.sort_order
        FROM ordered
        WHERE projects.id = ordered.id AND projects.workspace_id = ordered.workspace_id
        """
    )

    op.alter_column("workspaces", "sort_order", server_default=None)
    op.alter_column("projects", "sort_order", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_projects_sort_order", table_name="projects")
    op.drop_index("ix_workspaces_sort_order", table_name="workspaces")
    op.drop_column("projects", "sort_order")
    op.drop_column("workspaces", "sort_order")
