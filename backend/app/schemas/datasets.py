"""CSV 등록 화면에서 사용하는 파일 정보와 검사 결과의 형식."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class InspectionIssue(BaseModel):
    """프런트엔드는 code로 구분하고 message를 사용자에게 표시한다."""

    code: str

    message: str

    column: str | None = None

    count: int = Field(default=1, ge=0)

    severity: Literal["error", "warning"] = "error"


class CsvInspection(BaseModel):
    """파일을 수정하지 않고 전체 행을 읽어 확인한 결과."""

    row_count: int = Field(ge=0)

    column_count: int = Field(ge=0)

    columns: list[str]

    channels: list[str]

    # 조업 상태·결측 표시 같은 부가 열은 보존하되 모델 입력에서 제외한다.
    ignored_columns: list[str] = Field(default_factory=list)

    timestamp_column: str

    label_column: str

    # 원본에 시간대가 없으면 임의로 UTC나 한국 시간으로 해석하지 않는다.
    time_start: str | None

    time_end: str | None

    timezone_mode: Literal["naive", "aware", "mixed"] | None

    invalid_timestamp_count: int = Field(ge=0)

    duplicate_timestamp_count: int = Field(ge=0)

    out_of_order_count: int = Field(ge=0)

    missing_counts: dict[str, int]

    invalid_numeric_counts: dict[str, int]

    label_counts: dict[str, int]

    invalid_label_count: int = Field(ge=0)

    issues: list[InspectionIssue]

    # 미리보기만 제한한다. 저장하는 원본 CSV의 셀 값은 줄이거나 고치지 않는다.
    preview: list[dict[str, str]]

    preview_truncated: bool

    is_valid: bool


class DatasetSummary(BaseModel):
    """목록과 선택창에 필요한 데이터셋 정보. 서버 파일 경로는 공개하지 않는다."""

    model_config = ConfigDict(from_attributes=True)

    id: str

    filename: str

    size_bytes: int = Field(ge=0)

    sha256: str

    status: Literal["valid", "needs_review"]

    created_at: int

    owner_id: int

    row_count: int = Field(ge=0)

    column_count: int = Field(ge=0)

    timestamp_column: str

    label_column: str

    normal_label: str

    abnormal_label: str

    channels: list[str]


class DatasetDetail(BaseModel):
    dataset: DatasetSummary

    inspection: CsvInspection


class DatasetList(BaseModel):
    items: list[DatasetSummary]

    total: int = Field(ge=0)

    limit: int = Field(ge=1)

    offset: int = Field(ge=0)
