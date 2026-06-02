"""Declarative base + project-wide MetaData naming convention.

Stable constraint/index names matter for two reasons: Alembic autogen
diffs are deterministic, and DBAs can find the index by name from the
SQL we ship. Without this, SQLAlchemy generates names like `ix_…` that
collide across tables.
"""

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
