"""현장 관찰과 수정 이력의 입력·응답 형식. 사람의 판단과 모델 결과를 구분한다."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.auth import PublicUser
from app.schemas.runs import ModelKey

Judgment = Literal["needs_check", "anomaly_candidate", "normal"]


def parse_iso_datetime(value: object) -> datetime:
    # 숫자를 Unix 시각으로 해석하면 엉뚱한 구간에 기록될 수 있어 ISO 형식만 받는다.
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        raise ValueError("구간은 ISO 날짜·시각으로 입력하세요.")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("구간은 ISO 날짜·시각으로 입력하세요.") from None


class ObservationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    run_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    model_key: ModelKey | None = None

    channel: str = Field(min_length=1, max_length=128)

    start_time: datetime

    end_time: datetime

    location: str = Field(default="", max_length=200)

    content: str = Field(min_length=1, max_length=5000)

    judgment: Judgment = "needs_check"

    @field_validator("channel", "content")
    @classmethod
    def require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("채널과 관찰 내용은 비워둘 수 없습니다.")
        # 사용자가 작성한 줄바꿈과 공백은 그대로 저장한다.
        return value

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def validate_iso_times(cls, value: object) -> datetime:
        return parse_iso_datetime(value)

    @model_validator(mode="after")
    def validate_context(self) -> "ObservationCreate":
        if self.model_key is not None and self.run_id is None:
            raise ValueError("모델을 연결하려면 해당 실행 ID도 지정하세요.")
        if (self.start_time.tzinfo is None) != (self.end_time.tzinfo is None):
            raise ValueError("구간 시작과 끝의 시간대 표기를 같게 지정하세요.")
        if self.start_time > self.end_time:
            raise ValueError("구간 시작은 끝보다 늦을 수 없습니다.")
        return self


class ObservationPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1, strict=True)

    channel: str | None = Field(default=None, min_length=1, max_length=128)

    start_time: datetime | None = None

    end_time: datetime | None = None

    location: str | None = Field(default=None, max_length=200)

    content: str | None = Field(default=None, min_length=1, max_length=5000)

    judgment: Judgment | None = None

    @field_validator(
        "channel", "start_time", "end_time", "location", "content", "judgment", mode="before"
    )
    @classmethod
    def reject_explicit_null(cls, value: object) -> object:
        if value is None:
            raise ValueError("수정할 항목에는 null 대신 값을 입력하세요.")
        return value

    @field_validator("channel", "content")
    @classmethod
    def require_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("채널과 관찰 내용은 비워둘 수 없습니다.")
        return value

    @field_validator("start_time", "end_time", mode="before")
    @classmethod
    def validate_iso_times(cls, value: object) -> datetime:
        return parse_iso_datetime(value)

    @model_validator(mode="after")
    def require_change(self) -> "ObservationPatch":
        if not self.model_fields_set - {"revision"}:
            raise ValueError("수정할 항목을 하나 이상 입력하세요.")
        return self


class ObservationResponse(BaseModel):
    id: str

    dataset_id: str

    run_id: str | None

    model_key: ModelKey | None

    channel: str

    start_time: str

    end_time: str

    location: str

    content: str

    judgment: Judgment

    revision: int

    created_at: int

    updated_at: int

    author: PublicUser

    last_editor: PublicUser


class ObservationList(BaseModel):
    items: list[ObservationResponse]

    total: int

    limit: int

    offset: int


class ObservationHistoryItem(BaseModel):
    revision: int

    changed_at: int

    changed_by: PublicUser

    snapshot: ObservationResponse


class ObservationHistoryList(BaseModel):
    observation_id: str

    items: list[ObservationHistoryItem]

    total: int

    limit: int

    offset: int
