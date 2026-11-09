"""선택한 CSV·채널·구간에 남기는 현장 관찰과 수정 이력 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.models import User
from app.schemas.errors import ErrorResponse
from app.schemas.observations import (
    ObservationCreate,
    ObservationHistoryList,
    ObservationList,
    ObservationPatch,
    ObservationResponse,
)
from app.services import observations as observation_service

router = APIRouter(
    prefix="/api/v1/observations",
    tags=["현장 관찰"],
    responses={
        status_code: {"model": ErrorResponse} for status_code in (401, 403, 404, 409, 422, 503)
    },
)

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("", response_model=ObservationResponse, status_code=201, summary="현장 관찰 저장")
def create_observation(
    body: ObservationCreate,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ObservationResponse:
    return observation_service.create_observation(
        database_session, current_user, request.app.state.settings, body
    )


@router.get("", response_model=ObservationList, summary="내 현장 관찰 목록·구간 검색")
def list_observations(
    database_session: DatabaseSession,
    current_user: CurrentUser,
    dataset_id: str | None = None,
    run_id: str | None = None,
    channel: str | None = None,
    start_time: Annotated[str | None, Query(description="ISO 구간 시작 시각, 양끝 포함")] = None,
    end_time: Annotated[str | None, Query(description="ISO 구간 끝 시각, 양끝 포함")] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ObservationList:
    return observation_service.list_observations(
        database_session,
        current_user.id,
        dataset_id=dataset_id,
        run_id=run_id,
        channel=channel,
        start_time=start_time,
        end_time=end_time,
        limit=limit,
        offset=offset,
    )


@router.get("/{observation_id}", response_model=ObservationResponse, summary="내 현장 관찰 조회")
def get_observation(
    observation_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> ObservationResponse:
    observation = observation_service.get_observation(
        database_session, observation_id, current_user.id
    )

    return observation_service.observation_detail(database_session, observation)


@router.patch("/{observation_id}", response_model=ObservationResponse, summary="현장 관찰 수정")
def patch_observation(
    observation_id: str,
    body: ObservationPatch,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ObservationResponse:
    # 읽었던 revision을 함께 보내야 중간에 저장된 다른 수정을 덮어쓰지 않는다.
    return observation_service.patch_observation(
        database_session, current_user, request.app.state.settings, observation_id, body
    )


@router.get(
    "/{observation_id}/history",
    response_model=ObservationHistoryList,
    summary="현장 관찰 수정 이력",
)
def get_history(
    observation_id: str,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ObservationHistoryList:
    return observation_service.get_history(
        database_session, observation_id, current_user.id, limit, offset
    )
