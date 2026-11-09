"""데이터를 고치지 않고 단일 모델의 학습 설정을 제안한다."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.runs import NewRunCreate


class TrainingPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str = Field(pattern=r"^[a-f0-9]{32}$")

    model_key: Literal["xgboost", "autoencoder"]

    train_ratio: float = Field(default=0.7, ge=0.1, le=0.9)

    validation_ratio: float = Field(default=0.15, ge=0.05, le=0.4)

    feature_columns: list[str] | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def reserve_test(self):
        if self.train_ratio + self.validation_ratio > 0.95:
            raise ValueError("최종 확인 데이터가 5% 이상 남도록 비율을 지정하세요.")
        return self


class TrainingPlanResponse(BaseModel):
    configuration: NewRunCreate

    split: dict[str, int]

    notes: list[str]

    warnings: list[str] = Field(default_factory=list)

    label_counts: dict[str, dict[str, int]] = Field(default_factory=dict)
