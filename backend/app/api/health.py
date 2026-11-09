"""API 프로세스의 응답 상태를 확인한다."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__

router = APIRouter(prefix="/api/v1", tags=["상태 확인"])


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["kkobugi-backend"]
    version: str


@router.get("/health", response_model=HealthResponse, summary="서버 응답 확인")
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="kkobugi-backend", version=__version__)
