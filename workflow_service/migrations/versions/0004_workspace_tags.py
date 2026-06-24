"""Add workspace-global tags."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0004_workspace_tags"
down_revision = "0003_node_schedule"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "workspaces",
        sa.Column(
            "tags",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    connection = op.get_bind()
    workspace_ids = [row[0] for row in connection.execute(sa.text("SELECT id FROM workspaces"))]
    for workspace_id in workspace_ids:
        project_rows = connection.execute(
            sa.text("SELECT tags FROM projects WHERE workspace_id = :workspace_id"),
            {"workspace_id": workspace_id},
        )
        node_rows = connection.execute(
            sa.text(
                """
                SELECT nodes.tags
                FROM nodes
                JOIN projects ON projects.id = nodes.project_id
                WHERE projects.workspace_id = :workspace_id
                """
            ),
            {"workspace_id": workspace_id},
        )
        tags = sorted(
            {
                ".".join(segment.strip() for segment in str(tag).split(".") if segment.strip())
                for row in [*project_rows, *node_rows]
                for tag in (row[0] or [])
                if ".".join(segment.strip() for segment in str(tag).split(".") if segment.strip())
            }
        )
        connection.execute(
            sa.text("UPDATE workspaces SET tags = :tags WHERE id = :workspace_id"),
            {"workspace_id": workspace_id, "tags": tags},
        )

    op.alter_column("workspaces", "tags", server_default=None)


def downgrade() -> None:
    op.drop_column("workspaces", "tags")
