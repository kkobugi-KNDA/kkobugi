"""SQLite 연결과 요청별 데이터베이스 세션."""

from collections.abc import Iterator
from pathlib import Path
from sqlite3 import Connection

from fastapi import Request
from sqlalchemy import URL, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import ConnectionPoolEntry, StaticPool


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, path: Path):
        in_memory = str(path) == ":memory:"
        if not in_memory:
            path = Path(path).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(
            URL.create("sqlite+pysqlite", database=":memory:" if in_memory else str(path)),
            connect_args={"check_same_thread": False, "timeout": 5},
            **({"poolclass": StaticPool} if in_memory else {}),
        )

        @event.listens_for(self.engine, "connect")
        def configure_connection(connection: Connection, _: ConnectionPoolEntry) -> None:
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            if not in_memory:
                cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()

        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False)

    def create_tables(self) -> None:
        # 모델 등록 뒤 create_all을 실행하며 기존 테이블과 데이터는 보존한다.
        from app import models  # noqa: F401

        Base.metadata.create_all(self.engine)

    def dispose(self) -> None:
        self.engine.dispose()


def get_db(request: Request) -> Iterator[Session]:
    with request.app.state.database.session_factory() as session:
        yield session
