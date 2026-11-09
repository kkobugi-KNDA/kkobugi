"""학습 자료와 분리해 업로드한 시뮬레이션 CSV와 도착한 예측값."""

from typing import Literal

from pydantic import BaseModel


class SimulationManifest(BaseModel):
    id: str

    run_id: str

    model_key: Literal["xgboost", "autoencoder"]

    filename: str

    total_rows: int

    feature_columns: list[str]

    start_time: str

    end_time: str

    synthetic: Literal[True] = True

    provenance: str

    created_at: int


class SimulationList(BaseModel):
    items: list[SimulationManifest]

    total: int


class SimulationPoint(BaseModel):
    row_index: int

    timestamp: str

    value: float

    predicted_code: Literal[0, 1]

    score: float


class SimulationBatch(BaseModel):
    simulation_id: str

    channel: str

    points: list[SimulationPoint]

    next_cursor: int

    total_rows: int

    done: bool

    synthetic: Literal[True] = True

    score_type: Literal["probability", "reconstruction_error"]

    threshold: float | None
