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


class Observation(Base):
    """현장 관찰은 원본 라벨과 모델 예측을 바꾸지 않는 별도 기록으로 남긴다."""

    __tablename__ = "observations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)

    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)

    run_id: Mapped[str | None] = mapped_column(ForeignKey("model_runs.id"), index=True)

    model_key: Mapped[str | None] = mapped_column(String(40), nullable=True)

    channel: Mapped[str] = mapped_column(String(128), nullable=False)

    # 시간대가 있으면 UTC로 통일하고, 없으면 원본과 같이 시간대를 붙이지 않는다.
    start_time: Mapped[str] = mapped_column(String(40), nullable=False)

    end_time: Mapped[str] = mapped_column(String(40), nullable=False)

    location: Mapped[str] = mapped_column(String(200), default="", nullable=False)

    content: Mapped[str] = mapped_column(String(5000), nullable=False)

    judgment: Mapped[str] = mapped_column(String(32), default="needs_check", nullable=False)

    # 수정 요청이 읽었던 버전과 현재 버전을 비교해 다른 수정을 덮어쓰지 않는다.
    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    last_editor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    updated_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)


class ObservationHistory(Base):
    """작성 당시의 전체 내용을 저장해 현재 기록과 별도로 수정 이력을 보존한다."""

    __tablename__ = "observation_history"

    __table_args__ = (
        UniqueConstraint("observation_id", "revision", name="uq_observation_history_revision"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    observation_id: Mapped[str] = mapped_column(ForeignKey("observations.id"), index=True)

    revision: Mapped[int] = mapped_column(Integer, nullable=False)

    changed_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    changed_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)


class Review(Base):
    """검토 상태와 당시 확인한 근거를 원본·관찰 기록과 분리해 저장한다."""

    __tablename__ = "reviews"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)

    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)

    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)

    # 목록의 실행 필터에 사용하며, 저장한 모델 근거의 실행 ID와 함께 갱신한다.
    run_id: Mapped[str | None] = mapped_column(ForeignKey("model_runs.id"), index=True)

    channel: Mapped[str] = mapped_column(String(128), nullable=False)

    start_time: Mapped[str] = mapped_column(String(40), nullable=False)

    end_time: Mapped[str] = mapped_column(String(40), nullable=False)

    conclusion: Mapped[str] = mapped_column(String(5000), default="", nullable=False)

    judgment: Mapped[str] = mapped_column(String(32), default="needs_check", nullable=False)

    status: Mapped[str] = mapped_column(String(24), default="in_progress", nullable=False)

    revision: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    # 최신 관찰을 자동으로 읽지 않고 검토할 때 선택한 버전의 전체 내용을 보존한다.
    evidence: Mapped[dict] = mapped_column(JSON, nullable=False)

    last_editor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    completed_at: Mapped[int | None] = mapped_column(Integer, nullable=True)

    completed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    created_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    updated_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)


class ReviewHistory(Base):
    """작성·수정·완료·재검토 당시의 전체 기록을 같은 트랜잭션에서 남긴다."""

    __tablename__ = "review_history"

    __table_args__ = (UniqueConstraint("review_id", "revision", name="uq_review_history_revision"),)

    id: Mapped[int] = mapped_column(primary_key=True)

    review_id: Mapped[str] = mapped_column(ForeignKey("reviews.id"), index=True)

    revision: Mapped[int] = mapped_column(Integer, nullable=False)

    action: Mapped[str] = mapped_column(String(24), nullable=False)

    reason: Mapped[str] = mapped_column(String(1000), default="", nullable=False)

    changed_by_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    changed_at: Mapped[int] = mapped_column(Integer, default=utc_timestamp, nullable=False)

    snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
