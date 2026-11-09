"""검토 기록과 연결 근거, 완료·재검토 상태 및 수정 이력 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.errors import ErrorResponse
from app.schemas.observations import Judgment
from app.schemas.reviews import (
    ReviewCreate,
    ReviewHistoryList,
    ReviewList,
    ReviewPatch,
    ReviewReopen,
    ReviewResponse,
    ReviewRevision,
    ReviewStatus,
)
from app.schemas.series import IsoDateTime
from app.services import reviews as review_service

router = APIRouter(
    prefix="/api/v1/reviews",
    tags=["검토 기록"],
    responses={status: {"model": ErrorResponse} for status in (401, 403, 404, 409, 422, 503)},
)

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post(
    "",
    response_model=ReviewResponse,
    status_code=201,
    summary="검토 기록 생성",
    dependencies=[Depends(memory_guard)],
)
def create_review(
    body: ReviewCreate,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ReviewResponse:
    return review_service.create_review(
        database_session, current_user, request.app.state.settings, body
    )


@router.get("", response_model=ReviewList, summary="내 검토 목록·상태·구간 검색")
def list_reviews(
    database_session: DatabaseSession,
    current_user: CurrentUser,
    dataset_id: str | None = None,
    run_id: str | None = None,
    channel: str | None = None,
    status: ReviewStatus | None = None,
    judgment: Judgment | None = None,
    start_time: Annotated[IsoDateTime | None, Query()] = None,
    end_time: Annotated[IsoDateTime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReviewList:
    return review_service.list_reviews(
        database_session,
        current_user.id,
        dataset_id=dataset_id,
        run_id=run_id,
        channel=channel,
        status=status,
        judgment=judgment,
        start_time=start_time,
        end_time=end_time,
        limit=limit,
        offset=offset,
    )


@router.get("/{review_id}", response_model=ReviewResponse, summary="내 검토 내용·연결 근거")
def get_review(
    review_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> ReviewResponse:
    review = review_service.get_review(database_session, review_id, current_user.id)

    return review_service.review_detail(database_session, review)


@router.patch(
    "/{review_id}",
    response_model=ReviewResponse,
    summary="진행 중인 검토 수정",
    dependencies=[Depends(memory_guard)],
)
def patch_review(
    review_id: str,
    body: ReviewPatch,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ReviewResponse:
    # 완료한 기록은 먼저 재검토로 열고, 현재 revision을 확인한 뒤 수정한다.
    return review_service.patch_review(
        database_session, current_user, request.app.state.settings, review_id, body
    )


@router.post(
    "/{review_id}/complete",
    response_model=ReviewResponse,
    summary="검토 완료 처리",
    dependencies=[Depends(memory_guard)],
)
def complete_review(
    review_id: str,
    body: ReviewRevision,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ReviewResponse:
    return review_service.complete_review(
        database_session, current_user, request.app.state.settings, review_id, body
    )


@router.post("/{review_id}/reopen", response_model=ReviewResponse, summary="완료 기록 재검토")
def reopen_review(
    review_id: str,
    body: ReviewReopen,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ReviewResponse:
    return review_service.reopen_review(database_session, current_user, review_id, body)


@router.get("/{review_id}/history", response_model=ReviewHistoryList, summary="검토 수정·완료 이력")
def get_history(
    review_id: str,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReviewHistoryList:
    return review_service.get_history(database_session, review_id, current_user.id, limit, offset)
