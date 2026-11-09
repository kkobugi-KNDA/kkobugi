"""사용자, 로그인 세션 및 로그인 시도 저장 모델."""

import time

from sqlalchemy import Boolean, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.db import Base
from app.security import normalize_username


def utc_timestamp() -> int:
    return int(time.time())


class User(Base):
    """비밀번호는 해시로 저장하고, 비활성 계정은 로그인할 수 없게 한다."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)

    username: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    display_name: Mapped[str] = mapped_column(String(80), nullable=False)

    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    @validates("username")
    def validate_username(self, _: str, username: str) -> str:
        return normalize_username(username)


class LoginSession(Base):
    """브라우저별 인증 상태를 저장하며 원본 쿠키 토큰은 남기지 않는다."""

    __tablename__ = "login_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    expires_at: Mapped[int] = mapped_column(Integer, index=True, nullable=False)


class LoginAttempt(Base):
    """계정·접속 IP별 실패 횟수와 제한을 계산할 시작 시각을 저장한다."""

    __tablename__ = "login_attempts"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)

    failures: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    window_start: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)
