"""실제 수집과 구분되는 합성 시계열 재생 형식."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ReplayCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    model_key: Literal["xgboost", "autoencoder"]

    row_count: int = Field(default=230_000, ge=3, le=230_000)

    source_split: Literal["full", "test"] = "full"

    start_time: datetime | None = None


class ReplayManifest(BaseModel):
    id: str

    run_id: str

    model_key: str

    dataset_id: str

    source_dataset_id: str

    source_sha256: str

    source_start_row: int

    source_end_row: int

    # 이전 버전에서 생성한 manifest에는 test 값이 저장되어 있다.
    source_split: Literal["full", "test"] = "test"

    total_rows: int

    feature_columns: list[str]

    start_time: str

    end_time: str

    synthetic: Literal[True] = True

    provenance: str

    created_at: int


class ReplayList(BaseModel):
    items: list[ReplayManifest]

    total: int


class ReplayPoint(BaseModel):
    row_index: int

    timestamp: str

    value: float

    predicted_code: Literal[0, 1]

    score: float

    source_row: int

    source_timestamp: str


class ReplayBatch(BaseModel):
    replay_id: str

    channel: str

    points: list[ReplayPoint]

    next_cursor: int

    total_rows: int

    done: bool

    synthetic: Literal[True] = True

    score_type: Literal["probability", "reconstruction_error"]

    threshold: float | None
