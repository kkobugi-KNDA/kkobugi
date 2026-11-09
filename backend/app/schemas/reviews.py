"""검토 상태, 모델 결과·관찰 버전 연결, 수정 이력의 요청과 응답."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.auth import PublicUser
from app.schemas.observations import Judgment, ObservationResponse, parse_iso_datetime
from app.schemas.runs import EvaluationMetrics, ModelKey, SplitPart
from app.schemas.series import PredictionSplit

ReviewStatus = Literal["in_progress", "completed"]

ReviewAction = Literal["created", "updated", "completed", "reopened"]


class ModelResultReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    model_key: ModelKey

    split: PredictionSplit = "validation"


class ObservationReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    observation_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    # 관찰이 이후 수정되어도 사용자가 실제로 본 버전을 특정한다.
    revision: int = Field(ge=1, strict=True)


def unique_observations(references: list[ObservationReference]) -> list[ObservationReference]:
    if len({reference.observation_id for reference in references}) != len(references):
        raise ValueError("같은 관찰은 한 번만 연결하세요.")
    return references


class ReviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    channel: str = Field(min_length=1, max_length=128)

    start_time: datetime

    end_time: datetime

    conclusion: str = Field(default="", max_length=5000)

    judgment: Judgment = "needs_check"

    model_result: ModelResultReference | None = None

    observations: list[ObservationReference] = Field(default_factory=list, max_length=50)

    @field_validator("channel")
    @classmethod
    def require_channel(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("채널을 지정하세요.")
        return value

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def validate_iso_times(cls, value: object) -> datetime:
        return parse_iso_datetime(value)

    @field_validator("observations")
    @classmethod
    def validate_observations(cls, value: list[ObservationReference]) -> list[ObservationReference]:
        return unique_observations(value)

    @model_validator(mode="after")
    def validate_interval(self) -> "ReviewCreate":
        if (self.start_time.tzinfo is None) != (self.end_time.tzinfo is None):
            raise ValueError("구간 시작과 끝의 시간대 표기를 같게 지정하세요.")
        if self.start_time > self.end_time:
            raise ValueError("구간 시작은 끝보다 늦을 수 없습니다.")
        return self


class ReviewRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1, strict=True)


class ReviewPatch(ReviewRevision):
    channel: str | None = Field(default=None, min_length=1, max_length=128)

    start_time: datetime | None = None

    end_time: datetime | None = None

    conclusion: str | None = Field(default=None, max_length=5000)

    judgment: Judgment | None = None

    model_result: ModelResultReference | None = None

    observations: list[ObservationReference] | None = Field(default=None, max_length=50)

    @field_validator(
        "channel",
        "start_time",
        "end_time",
        "conclusion",
        "judgment",
        "observations",
        mode="before",
    )
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        # 모델 연결 해제만 null을 허용한다. 누락한 필드는 기존 값을 유지한다.
        if value is None:
            raise ValueError("수정할 항목에는 null 대신 값을 입력하세요.")
        return value

    @field_validator("channel")
    @classmethod
    def require_channel(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("채널을 지정하세요.")
        return value

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def validate_iso_times(cls, value: object) -> datetime:
        return parse_iso_datetime(value)

    @field_validator("observations")
    @classmethod
    def validate_observations(cls, value: list[ObservationReference]) -> list[ObservationReference]:
        return unique_observations(value)

    @model_validator(mode="after")
    def require_change(self) -> "ReviewPatch":
        if not self.model_fields_set - {"revision"}:
            raise ValueError("수정할 항목을 하나 이상 입력하세요.")
        return self


class ReviewReopen(ReviewRevision):
    reason: str = Field(min_length=1, max_length=1000)

    @field_validator("reason")
    @classmethod
    def require_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("재검토 이유를 입력하세요.")
        return value


class CapturedModelResult(BaseModel):
    run_id: str

    model_key: ModelKey

    split: PredictionSplit

    display_name: str

    input_sha256: str

    artifact_sha256: str

    feature_columns: list[str]

    train_end: str

    validation_end: str

    partition: SplitPart

    partition_metrics: EvaluationMetrics

    # 전체 Valid/Test의 지표이며, 검토한 짧은 구간만의 지표가 아니다.
    metrics_scope: Literal["full_partition"] = "full_partition"

    parameters: dict[str, object]

    environment: dict[str, str]


class ReviewEvidence(BaseModel):
    model_result: CapturedModelResult | None = None

    observations: list[ObservationResponse] = Field(default_factory=list)


class ReviewResponse(BaseModel):
    id: str

    dataset_id: str

    channel: str

    start_time: str

    end_time: str

    conclusion: str

    judgment: Judgment

    status: ReviewStatus

    revision: int

    created_at: int

    updated_at: int

    author: PublicUser

    last_editor: PublicUser

    completed_at: int | None

    completed_by: PublicUser | None

    evidence: ReviewEvidence


class ReviewList(BaseModel):
    items: list[ReviewResponse]

    total: int

    limit: int

    offset: int


class ReviewHistoryItem(BaseModel):
    revision: int

    action: ReviewAction

    reason: str

    changed_at: int

    changed_by: PublicUser

    snapshot: ReviewResponse


class ReviewHistoryList(BaseModel):
    review_id: str

    items: list[ReviewHistoryItem]

    total: int

    limit: int

    offset: int
