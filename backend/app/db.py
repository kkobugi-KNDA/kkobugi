"""SQLite 연결과 요청별 데이터베이스 세션."""

from collections.abc import Iterator
from pathlib import Path
from sqlite3 import Connection

from fastapi import Request
from sqlalchemy import URL, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import ConnectionPoolEntry, QueuePool, StaticPool


class Base(DeclarativeBase):
    pass


class Database:
    def __init__(self, path: Path):
        is_memory_database = str(path) == ":memory:"

        if not is_memory_database:
            path = Path(path).expanduser().resolve()

            path.parent.mkdir(parents=True, exist_ok=True)
        # 메모리 DB는 여러 요청 스레드가 같은 연결을 사용해야 내용이 유지된다.
        pool_class = StaticPool if is_memory_database else QueuePool

        self.engine = create_engine(
            URL.create("sqlite+pysqlite", database=str(path)),
            connect_args={"check_same_thread": False, "timeout": 5},
            poolclass=pool_class,
        )

        @event.listens_for(self.engine, "connect")
        def configure_connection(connection: Connection, _: ConnectionPoolEntry) -> None:
            cursor = connection.cursor()

            # 참조 무결성을 확인하고, 다른 요청의 쓰기 작업을 최대 5초 기다린다.
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA busy_timeout=5000")
            if not is_memory_database:
                # 파일 DB는 읽기와 쓰기가 서로 덜 막히도록 WAL을 사용한다.
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
    # 요청이 끝나면 연결을 반환한다. 로그인 세션과는 다른 DB 작업 단위다.
    with request.app.state.database.session_factory() as database_session:
        yield database_session
