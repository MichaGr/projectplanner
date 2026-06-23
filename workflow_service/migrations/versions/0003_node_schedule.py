"""Add node scheduling dates."""

from alembic import op
import sqlalchemy as sa


revision = "0003_node_schedule"
down_revision = "0002_workspaces"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("nodes", sa.Column("due_date", sa.Date(), nullable=True))
    op.add_column("nodes", sa.Column("do_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("nodes", "do_date")
    op.drop_column("nodes", "due_date")
