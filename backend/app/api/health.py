"""API 프로세스의 응답 상태를 확인한다."""

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__

router = APIRouter(prefix="/api/v1", tags=["상태 확인"])


class HealthResponse(BaseModel):
    """서버 식별 정보만 반환하며 DB 계정이나 세션 정보는 포함하지 않는다."""

    status: Literal["ok"]

    service: Literal["kkobugi-backend"]

    version: str


@router.get("/health", response_model=HealthResponse, summary="서버 응답 확인")
def health() -> HealthResponse:
    # 서버 프로세스가 요청에 응답하는지 확인하는 용도다.
    return HealthResponse(status="ok", service="kkobugi-backend", version=__version__)
