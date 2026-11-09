"""모델 선택·학습·검증 비교·시험 평가에 사용하는 요청과 응답."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ModelKey = Literal["dummy", "xgboost", "autoencoder"]

RankingMetric = Literal[
    "f1", "precision", "recall", "accuracy", "balanced_accuracy", "roc_auc", "average_precision"
]

RunStatus = Literal["queued", "running", "completed", "failed"]

EvaluationStatus = Literal["not_started", "queued", "running", "completed", "failed"]


class RunCreate(BaseModel):
    """특징·모델·시간 경계는 사용자가 정하고 서버가 임의로 바꾸지 않는다."""

    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    feature_columns: list[str] = Field(min_length=1, max_length=128)

    models: list[ModelKey] = Field(min_length=1, max_length=3)

    train_end: datetime

    validation_end: datetime

    ranking_metric: RankingMetric = "f1"

    random_seed: int = Field(default=42, ge=0, le=2_147_483_647)

    @field_validator("feature_columns")
    @classmethod
    def validate_feature_columns(cls, feature_columns: list[str]) -> list[str]:
        if any(not column.strip() for column in feature_columns):
            raise ValueError("비어 있지 않은 특징 컬럼을 지정하세요.")
        if len(feature_columns) != len(set(feature_columns)):
            raise ValueError("특징 컬럼은 중복해서 지정할 수 없습니다.")
        return feature_columns

    @field_validator("models")
    @classmethod
    def validate_models(cls, models: list[ModelKey]) -> list[ModelKey]:
        if len(models) != len(set(models)):
            raise ValueError("학습할 모델은 중복해서 지정할 수 없습니다.")
        return models

    @field_validator("train_end", "validation_end", mode="before")
    @classmethod
    def require_iso_boundary(cls, boundary: object) -> datetime:
        # 숫자를 Unix 시각으로 추측하지 않고, 명시한 ISO 시각만 받는다.
        if isinstance(boundary, datetime):
            return boundary
        if not isinstance(boundary, str):
            raise ValueError("분할 경계는 ISO 날짜·시각으로 입력하세요.")
        try:
            return datetime.fromisoformat(boundary)
        except ValueError:
            raise ValueError("분할 경계는 ISO 날짜·시각으로 입력하세요.") from None

    @model_validator(mode="after")
    def validate_boundaries(self) -> "RunCreate":
        if (self.train_end.tzinfo is None) != (self.validation_end.tzinfo is None):
            raise ValueError("두 분할 경계의 시간대 표기를 같게 지정하세요.")
        if self.train_end >= self.validation_end:
            raise ValueError("Train 종료 시각은 Valid 종료 시각보다 빨라야 합니다.")
        return self


class SelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model_key: ModelKey


class ClassMetrics(BaseModel):
    precision: float | None

    recall: float | None

    f1: float | None

    support: int = Field(ge=0)


class EvaluationMetrics(BaseModel):
    """양성은 등록 시 지정한 abnormal_label이며, 계산 불가능한 지표는 null이다."""

    accuracy: float

    precision: float | None

    recall: float | None

    f1: float | None

    balanced_accuracy: float | None

    roc_auc: float | None

    average_precision: float | None

    # 행과 열의 순서는 모두 [normal, abnormal]이다.
    confusion_matrix: list[list[int]]

    class_metrics: dict[str, ClassMetrics]

    sample_count: int = Field(ge=1)

    warnings: list[str]


class ModelResult(BaseModel):
    model_key: ModelKey

    display_name: str

    parameters: dict[str, object]

    validation_metrics: EvaluationMetrics

    training_seconds: float = Field(ge=0)

    artifact_sha256: str

    warnings: list[str] = Field(default_factory=list)

    rank: int | None = None

    sort_value: float | None = None


class SplitPart(BaseModel):
    """start_row부터 end_row 직전까지의 원본 행 범위다."""

    start_row: int = Field(ge=0)

    end_row: int = Field(ge=0)

    row_count: int = Field(ge=1)


class SplitInfo(BaseModel):
    train: SplitPart

    validation: SplitPart

    test: SplitPart


class RunSummary(BaseModel):
    id: str

    dataset_id: str

    owner_id: int

    status: RunStatus

    created_at: int

    updated_at: int

    selected_model: ModelKey | None

    evaluation_status: EvaluationStatus

    completed_models: int

    total_models: int

    error_message: str | None


class RunDetail(BaseModel):
    run: RunSummary

    configuration: RunCreate

    input_sha256: str

    split: SplitInfo | None

    environment: dict[str, str]

    warnings: list[str]


class RunList(BaseModel):
    items: list[RunSummary]

    total: int

    limit: int

    offset: int


class RunResults(BaseModel):
    run_id: str

    status: RunStatus

    metric: RankingMetric

    items: list[ModelResult]

    selected_model: ModelKey | None


class EvaluationResponse(BaseModel):
    run_id: str

    status: EvaluationStatus

    model_key: ModelKey | None

    metrics: EvaluationMetrics | None

    error_message: str | None


class ModelDefinition(BaseModel):
    key: ModelKey

    display_name: str

    kind: Literal["baseline", "classifier", "anomaly_detector"]

    description: str

    parameters: dict[str, object]


class ModelCatalog(BaseModel):
    items: list[ModelDefinition]
