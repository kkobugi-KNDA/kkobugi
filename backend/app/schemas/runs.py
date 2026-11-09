"""모델 선택·학습·검증 비교·시험 평가에 사용하는 요청과 응답."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# 과거 Dummy 실행도 읽을 수 있도록 저장된 기록의 키는 유지한다.
ModelKey = Literal["dummy", "xgboost", "lightgbm", "autoencoder"]

ActiveModelKey = Literal["xgboost", "lightgbm", "autoencoder"]

RankingMetric = Literal[
    "f1", "precision", "recall", "accuracy", "balanced_accuracy", "roc_auc", "average_precision"
]


class XGBoostOptions(BaseModel):
    """서버 메모리와 실행 시간을 제한한 사용자의 학습 옵션."""

    model_config = ConfigDict(extra="forbid", strict=True)

    n_estimators: int = Field(default=100, ge=20, le=300)

    max_depth: int = Field(default=4, ge=2, le=8)

    learning_rate: float = Field(default=0.1, ge=0.01, le=0.3)


class AutoencoderOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    max_iter: int = Field(default=100, ge=20, le=200)

    hidden_size: int = Field(default=32, ge=8, le=64)

    threshold_quantile: float = Field(default=0.99, ge=0.95, le=0.999)


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

    # 빈 옵션은 저장 결과에서 생략해 기존 모델 metadata와 정확히 호환한다.
    model_options: dict[str, dict[str, int | float]] = Field(
        default_factory=dict, exclude_if=lambda options: not options
    )

    @field_validator("model_options", mode="before")
    @classmethod
    def validate_model_options(cls, options: object) -> dict:
        if not isinstance(options, dict):
            raise ValueError("모델 옵션은 모델별 항목으로 지정하세요.")
        schemas = {"xgboost": XGBoostOptions, "autoencoder": AutoencoderOptions}

        validated = {}

        for model_key, values in options.items():
            if model_key not in schemas:
                raise ValueError("XGBoost와 AutoEncoder 옵션만 설정할 수 있습니다.")
            validated[model_key] = schemas[model_key].model_validate(values).model_dump()

        return validated

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
        if not set(self.model_options).issubset(self.models):
            raise ValueError("학습할 모델의 옵션만 지정하세요.")
        if (self.train_end.tzinfo is None) != (self.validation_end.tzinfo is None):
            raise ValueError("두 분할 경계의 시간대 표기를 같게 지정하세요.")
        if self.train_end >= self.validation_end:
            raise ValueError("Train 종료 시각은 Valid 종료 시각보다 빨라야 합니다.")
        return self


class NewRunCreate(RunCreate):
    """새 학습 요청에서는 현재 지원하는 모델만 선택한다."""

    # 과거 RunCreate를 바꾸지 않아 기존 Dummy 실행 설정의 조회가 깨지지 않는다.
    models: list[ActiveModelKey] = Field(min_length=1, max_length=3)


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


class TrainingProgressEvent(BaseModel):
    """실제로 시작·완료·실패한 학습 단계의 기록. 진행률을 추측하지 않는다."""

    stage: Literal[
        "data_check", "split", "input_preparation", "training", "validation", "saving", "completed"
    ]

    status: Literal["running", "completed", "failed"]

    timestamp: int = Field(ge=0)

    message: str

    model_key: ModelKey | None = None


class RunDetail(BaseModel):
    run: RunSummary

    configuration: RunCreate

    input_sha256: str

    split: SplitInfo | None

    environment: dict[str, str]

    warnings: list[str]

    # 이전 실행은 기록을 복원해 만들지 않고 빈 목록으로 보여준다.
    training_progress: list[TrainingProgressEvent] = Field(default_factory=list)


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
