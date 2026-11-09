"""모델 학습 요청, 검증 비교, 사용자 선택과 별도 시험 평가 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.models import User
from app.schemas.errors import ErrorResponse
from app.schemas.runs import (
    EvaluationResponse,
    NewRunCreate,
    RankingMetric,
    RunDetail,
    RunList,
    RunResults,
    SelectionRequest,
)
from app.services import runs as run_service

router = APIRouter(
    prefix="/api/v1/runs",
    tags=["모델 실행"],
    responses={
        status_code: {"model": ErrorResponse}
        for status_code in (401, 403, 404, 409, 413, 422, 429, 503)
    },
)

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("", response_model=RunDetail, status_code=202, summary="선택한 모델 학습 요청")
def create_run(
    body: NewRunCreate,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> RunDetail:
    # 학습은 대기열에서 처리하므로 다른 사용자의 조회 요청을 막지 않는다.
    return request.app.state.run_manager.create_run(database_session, current_user, body)


@router.get("", response_model=RunList, summary="내 모델 실행 기록")
def list_runs(
    database_session: DatabaseSession,
    current_user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> RunList:
    return run_service.list_runs(database_session, current_user.id, limit, offset)


@router.get("/{run_id}", response_model=RunDetail, summary="실행 상태·설정·분할 정보")
def get_run(run_id: str, database_session: DatabaseSession, current_user: CurrentUser) -> RunDetail:
    model_run = run_service.get_run(database_session, run_id, current_user.id)

    return run_service.run_detail(model_run)


@router.get("/{run_id}/results", response_model=RunResults, summary="Valid 지표로 모델 비교")
def get_results(
    run_id: str,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    sort_by: RankingMetric | None = None,
) -> RunResults:
    model_run = run_service.get_run(database_session, run_id, current_user.id)

    return run_service.get_results(model_run, sort_by)


@router.post("/{run_id}/selection", response_model=RunDetail, summary="사용자가 모델 선택")
def select_model(
    run_id: str,
    body: SelectionRequest,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> RunDetail:
    return request.app.state.run_manager.select_model(
        database_session, run_id, current_user.id, body.model_key
    )


@router.post(
    "/{run_id}/evaluation",
    response_model=EvaluationResponse,
    status_code=202,
    summary="선택한 모델의 Test 평가 요청",
    responses={200: {"model": EvaluationResponse, "description": "이미 완료한 평가 결과 재사용"}},
)
def start_evaluation(
    run_id: str,
    request: Request,
    response: Response,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> EvaluationResponse:
    evaluation, is_pending = request.app.state.run_manager.start_evaluation(
        database_session, current_user, run_id
    )

    response.status_code = 202 if is_pending else 200

    return evaluation


@router.get(
    "/{run_id}/evaluation", response_model=EvaluationResponse, summary="Test 평가 상태·결과"
)
def get_evaluation(
    run_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> EvaluationResponse:
    model_run = run_service.get_run(database_session, run_id, current_user.id)

    return run_service.get_evaluation(model_run)
