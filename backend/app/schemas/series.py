"""원본 시계열·라벨 구간·저장된 모델 예측 조회에 사용하는 응답."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, Field

from app.schemas.runs import ModelKey


def parse_iso_datetime(value: object) -> datetime:
    # 숫자를 Unix 시각으로 추측하지 않고 사용자가 명시한 날짜·시각만 받는다.
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        raise ValueError("ISO 날짜·시각으로 입력하세요.")
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise ValueError("ISO 날짜·시각으로 입력하세요.") from None


IsoDateTime = Annotated[datetime, BeforeValidator(parse_iso_datetime)]

PredictionSplit = Literal["validation", "test"]

BinaryCode = Literal[0, 1]


class SeriesPoint(BaseModel):
    row_index: int = Field(ge=0)

    timestamp: str

    values: dict[str, float]

    actual_label: str

    actual_code: BinaryCode


class SeriesResponse(BaseModel):
    dataset_id: str

    channels: list[str]

    timestamp_column: str

    normal_label: str

    abnormal_label: str

    timezone_mode: Literal["naive", "aware"]

    start_time: str | None

    end_time: str | None

    matched_count: int

    returned_count: int

    downsampled: bool

    sampling_method: Literal["none", "min_max"]

    points: list[SeriesPoint]


class TimeInterval(BaseModel):
    """시각 양끝은 관측값을 포함하고, 행 범위는 [start_row, end_row)다."""

    start_time: str

    end_time: str

    start_row: int = Field(ge=0)

    end_row: int = Field(ge=1)

    row_count: int = Field(ge=1)


class LabelIntervals(BaseModel):
    dataset_id: str

    code: BinaryCode

    normal_label: str

    abnormal_label: str

    timezone_mode: Literal["naive", "aware"]

    cadence_seconds: float | None

    items: list[TimeInterval]

    total: int

    limit: int

    offset: int


class PredictionPoint(BaseModel):
    row_index: int = Field(ge=0)

    timestamp: str

    actual_label: str

    actual_code: BinaryCode

    predicted_label: str

    predicted_code: BinaryCode

    score: float


class PredictionContext(BaseModel):
    run_id: str

    dataset_id: str

    model_key: ModelKey

    split: PredictionSplit

    # 재구성 오차를 고장 확률이라고 표시하지 않도록 점수 종류를 함께 보낸다.
    score_type: Literal["probability", "reconstruction_error"]

    threshold: float | None

    input_sha256: str

    artifact_sha256: str


class PredictionResponse(PredictionContext):
    total: int

    limit: int

    offset: int

    items: list[PredictionPoint]


class PredictionIntervals(PredictionContext):
    predicted_code: BinaryCode

    cadence_seconds: float | None

    items: list[TimeInterval]

    total: int

    limit: int

    offset: int
