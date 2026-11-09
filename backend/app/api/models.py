"""Figma의 모델 선택창이 실제 실행 가능한 목록을 조회한다."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app.api.auth import get_current_user
from app.model_catalog import get_model_catalog
from app.models import User
from app.schemas.errors import ErrorResponse
from app.schemas.runs import ModelCatalog

router = APIRouter(
    prefix="/api/v1/models",
    tags=["모델"],
    responses={401: {"model": ErrorResponse}},
)


@router.get("", response_model=ModelCatalog, summary="선택 가능한 모델과 학습 설정")
def list_models(_current_user: Annotated[User, Depends(get_current_user)]) -> ModelCatalog:
    # 화면 문구가 달라져도 모델 key로 같은 알고리즘을 선택한다.
    return get_model_catalog()
