"""사용자, 로그인 세션 및 로그인 시도 저장 모델."""

import time

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, UniqueConstraint
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


class Dataset(Base):
    """업로드한 CSV의 소유자, 원본 식별값과 검사 결과를 보관한다."""

    __tablename__ = "datasets"

    # 같은 계정이 같은 파일과 컬럼 설정으로 재등록해도 기존 자료를 재사용한다.
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "sha256",
            "timestamp_column",
            "label_column",
            "normal_label",
            "abnormal_label",
            name="uq_dataset_owner_content_mapping",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)

    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    # 파일 이름은 표시할 때만 쓰며, 실제 저장 경로는 서버가 만든 ID로 정한다.
    filename: Mapped[str] = mapped_column(String(255), nullable=False)

    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)

    sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    timestamp_column: Mapped[str] = mapped_column(String(128), nullable=False)

    label_column: Mapped[str] = mapped_column(String(128), nullable=False)

    normal_label: Mapped[str] = mapped_column(String(128), nullable=False)

    abnormal_label: Mapped[str] = mapped_column(String(128), nullable=False)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    # 검사 결과를 함께 저장해 서버를 다시 켜도 동일한 내용을 보여준다.
    inspection: Mapped[dict] = mapped_column(JSON, nullable=False)


class ModelRun(Base):
    """학습과 최종 평가 상태를 분리해 저장한다. Test 결과로 모델을 다시 고르지 않는다."""

    __tablename__ = "model_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)

    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)

    status: Mapped[str] = mapped_column(String(24), default="queued", nullable=False)

    configuration: Mapped[dict] = mapped_column(JSON, nullable=False)

    input_sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    training_report: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    selected_model: Mapped[str | None] = mapped_column(String(40), nullable=True)

    evaluation_status: Mapped[str] = mapped_column(
        String(24), default="not_started", nullable=False
    )

    evaluation_report: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)

    evaluation_error: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    updated_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)
