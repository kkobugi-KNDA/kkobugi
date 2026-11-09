"""단일 모델의 자동 학습 설정 제안 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.training import TrainingPlanRequest, TrainingPlanResponse
from app.services import datasets as dataset_service
from app.services.training import make_training_plan

router = APIRouter(prefix="/api/v1/training", tags=["학습 설정"])


@router.post("/plan", response_model=TrainingPlanResponse, dependencies=[Depends(memory_guard)])
def training_plan(
    body: TrainingPlanRequest,
    request: Request,
    database_session: Annotated[Session, Depends(get_db)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> TrainingPlanResponse:
    dataset = dataset_service.get_dataset(database_session, body.dataset_id, current_user.id)

    return make_training_plan(dataset, request.app.state.settings, body)
