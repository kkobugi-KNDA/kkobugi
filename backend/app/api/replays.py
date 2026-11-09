"""합성 CSV 생성과 배치별 실시간 수집 재현 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.replays import ReplayBatch, ReplayCreate, ReplayList, ReplayManifest
from app.services import datasets as dataset_service
from app.services import replays as replay_service

router = APIRouter(prefix="/api/v1/replays", tags=["합성 데이터 재생"])

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post(
    "", response_model=ReplayManifest, status_code=201, dependencies=[Depends(memory_guard)]
)
def create_replay(
    body: ReplayCreate,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> ReplayManifest:
    return replay_service.create_replay(
        database_session, request.app.state.settings, current_user, body
    )


@router.get("", response_model=ReplayList)
def list_replays(request: Request, current_user: CurrentUser) -> ReplayList:
    return replay_service.list_replays(request.app.state.settings, current_user.id)


@router.get("/{replay_id}", response_model=ReplayManifest)
def get_replay(replay_id: str, request: Request, current_user: CurrentUser) -> dict:
    return replay_service.get_manifest(request.app.state.settings, replay_id, current_user.id)


@router.get("/{replay_id}/batch", response_model=ReplayBatch, dependencies=[Depends(memory_guard)])
def replay_batch(
    replay_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    channel: str,
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> ReplayBatch:
    return replay_service.replay_batch(
        database_session,
        request.app.state.settings,
        current_user.id,
        replay_id,
        cursor,
        limit,
        channel,
    )


@router.get("/{replay_id}/file", response_class=FileResponse)
def download_replay(
    replay_id: str, request: Request, database_session: DatabaseSession, current_user: CurrentUser
) -> FileResponse:
    manifest = replay_service.get_manifest(request.app.state.settings, replay_id, current_user.id)

    dataset = dataset_service.get_dataset(database_session, manifest["dataset_id"], current_user.id)

    return FileResponse(
        dataset_service.dataset_file_path(dataset, request.app.state.settings),
        media_type="text/csv",
        filename=dataset.filename,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
