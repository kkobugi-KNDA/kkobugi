"""모델이나 견적을 지정하지 않아도 보낼 수 있는 점검 대화 형식."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.assistant import Citation, CostEstimate, CostInputs, ModelSnapshot
from app.schemas.runs import ModelKey


class ChatTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]

    content: str = Field(min_length=1, max_length=6000)


class SimulationChatContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filename: str | None = Field(default=None, max_length=255)

    status: Literal["waiting", "playing", "paused", "completed"]

    cursor: int = Field(ge=0, le=10_000_000)

    total_rows: int = Field(ge=0, le=10_000_000)

    timestamp: str | None = Field(default=None, max_length=80)

    signal_count: int = Field(default=0, ge=0, le=10_000_000)

    last_signal_time: str | None = Field(default=None, max_length=80)

    @model_validator(mode="after")
    def validate_counts(self) -> "SimulationChatContext":
        if self.cursor > self.total_rows or self.signal_count > self.cursor:
            raise ValueError("수신 행 수와 점검 신호 수를 확인하세요.")
        return self


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=3000)

    history: list[ChatTurn] = Field(default_factory=list, max_length=20)

    dataset_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    run_id: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    model_key: ModelKey | None = None

    split: Literal["validation", "test"] = "validation"

    observation: str = Field(default="", max_length=4000)

    cost_inputs: CostInputs | None = None

    expertise: Literal["pro", "pro-plus"] = "pro"

    simulation_context: SimulationChatContext | None = None

    @model_validator(mode="after")
    def validate_conversation(self) -> "ChatRequest":
        if not self.question.strip():
            raise ValueError("질문 내용을 입력하세요.")
        if bool(self.run_id) != bool(self.model_key):
            raise ValueError("학습 실행과 모델은 함께 지정하거나 모두 비워두세요.")
        if sum(len(turn.content) for turn in self.history) > 30_000:
            raise ValueError("이전 대화가 너무 깁니다. 최근 대화만 보내세요.")
        return self


class ChatResponse(BaseModel):
    message_id: str

    created_at: int

    answer: str

    source_mode: Literal["retrieval", "llm"]

    citations: list[Citation]

    limitations: list[str]

    cost: CostEstimate | None

    model_snapshot: ModelSnapshot | None

    # 모델 근거가 있을 때만 기존 Word·PDF API로 연결할 기록을 만든다.
    report_message_id: str | None
