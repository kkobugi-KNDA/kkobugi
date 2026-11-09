"""모델 결과와 현장 관찰을 근거로 설명하는 요청 및 비용 계산 계약."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.runs import EvaluationMetrics, ModelKey, SplitInfo, TrainingProgressEvent


class CostInputs(BaseModel):
    """누락값은 0으로 추측하지 않는다. 금액은 모두 사용자가 확인한 원화다."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    component_name: str = Field(default="", max_length=120)

    quote_source: str = Field(default="", max_length=500)

    parts_cost: float | None = Field(default=None, ge=0, le=1_000_000_000_000)

    inspection_cost: float | None = Field(default=None, ge=0, le=1_000_000_000_000)

    labor_hours: float | None = Field(default=None, ge=0, le=100_000)

    labor_hourly_rate: float | None = Field(default=None, ge=0, le=10_000_000)

    downtime_hours: float | None = Field(default=None, ge=0, le=100_000)

    downtime_loss_per_hour: float | None = Field(default=None, ge=0, le=1_000_000_000_000)

    standby_available: bool | None = None


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=3000)

    run_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    model_key: ModelKey

    split: Literal["validation", "test"] = "validation"

    observation: str = Field(default="", max_length=4000)

    cost_inputs: CostInputs | None = None

    expertise: Literal["pro", "pro-plus"] = "pro"

    @model_validator(mode="after")
    def require_question(self) -> "AssistantRequest":
        if not self.question.strip():
            raise ValueError("질문 내용을 입력하세요.")
        return self


class Citation(BaseModel):
    id: str

    title: str

    url: str

    pages: str

    summary: str


class CostEstimate(BaseModel):
    currency: Literal["KRW"] = "KRW"

    parts_cost: float | None

    inspection_cost: float | None

    labor_cost: float | None

    downtime_cost: float | None

    known_subtotal: float

    total: float | None

    missing: list[str]

    assumptions: list[str]


class ModelSnapshot(BaseModel):
    run_id: str

    dataset_id: str

    dataset_name: str

    model_key: ModelKey

    model_name: str

    split: Literal["validation", "test"]

    metrics_scope: Literal["full_partition"] = "full_partition"

    metrics: EvaluationMetrics

    score_100: float | None

    score_formula: str = "UnNormal F1 × 100"

    feature_columns: list[str]

    input_sha256: str

    artifact_sha256: str

    # 과거 저장 답변에는 없던 항목이므로 기본값으로 계속 열 수 있게 한다.
    training_configuration: dict[str, object] = Field(default_factory=dict)

    training_progress: list[TrainingProgressEvent] = Field(default_factory=list)

    training_split: SplitInfo | None = None

    model_parameters: dict[str, object] = Field(default_factory=dict)


class AssistantResponse(BaseModel):
    message_id: str

    created_at: int

    answer: str

    source_mode: Literal["retrieval", "llm"]

    model_snapshot: ModelSnapshot

    citations: list[Citation]

    cost: CostEstimate

    suggested_checks: list[str]

    limitations: list[str]


class ReportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    title: str = Field(default="펌프 점검 검토 보고서", min_length=1, max_length=120)

    @model_validator(mode="after")
    def require_title(self) -> "ReportCreate":
        if not self.title.strip():
            raise ValueError("보고서 제목을 입력하세요.")
        return self


class ReportSection(BaseModel):
    heading: str

    paragraphs: list[str]


class ReportPreview(BaseModel):
    title: str

    sections: list[ReportSection]

    citations: list[Citation]

    model_snapshot: ModelSnapshot

    cost: CostEstimate


class ReportResponse(BaseModel):
    id: str

    message_id: str

    title: str

    status: Literal["queued", "generating", "completed", "failed"]

    created_at: int

    updated_at: int

    error_message: str | None = None

    preview: ReportPreview


class ReportList(BaseModel):
    items: list[ReportResponse]

    total: int

    limit: int

    offset: int
