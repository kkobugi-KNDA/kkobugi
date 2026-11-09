"""프런트엔드가 공통으로 처리할 오류 응답 형식."""

from pydantic import BaseModel


class InvalidField(BaseModel):
    field: list[str | int]

    message: str

    type: str


class ErrorDetail(BaseModel):
    code: str

    message: str

    fields: list[InvalidField] | None = None


class ErrorResponse(BaseModel):
    error: ErrorDetail
