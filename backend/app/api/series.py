"""같은 시간축의 채널 그래프와 원본 라벨·모델 예측 구간 조회 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.errors import ErrorResponse
from app.schemas.runs import ModelKey
from app.schemas.series import (
    IsoDateTime,
    LabelIntervals,
    PredictionIntervals,
    PredictionResponse,
    PredictionSplit,
    SeriesResponse,
)
from app.services import datasets as dataset_service
from app.services import runs as run_service
from app.services import series as series_service

router = APIRouter(
    prefix="/api/v1",
    tags=["시계열·예측 조회"],
    responses={status: {"model": ErrorResponse} for status in (401, 403, 404, 409, 422, 503)},
)

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get(
    "/datasets/{dataset_id}/series",
    response_model=SeriesResponse,
    summary="구간별 채널 그래프",
    dependencies=[Depends(memory_guard)],
)
def get_series(
    dataset_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    channels: Annotated[list[str], Query(min_length=1, max_length=8)],
    start_time: Annotated[IsoDateTime | None, Query()] = None,
    end_time: Annotated[IsoDateTime | None, Query()] = None,
    max_points: Annotated[int, Query(ge=64, le=10_000)] = 2000,
) -> SeriesResponse:
    dataset = dataset_service.get_dataset(database_session, dataset_id, current_user.id)

    return series_service.get_series(
        dataset, request.app.state.settings, channels, start_time, end_time, max_points
    )


@router.get(
    "/datasets/{dataset_id}/label-intervals",
    response_model=LabelIntervals,
    summary="CSV 라벨별 연속 관측 구간",
    dependencies=[Depends(memory_guard)],
)
def get_label_intervals(
    dataset_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    start_time: Annotated[IsoDateTime | None, Query()] = None,
    end_time: Annotated[IsoDateTime | None, Query()] = None,
    code: Annotated[int, Query(ge=0, le=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> LabelIntervals:
    dataset = dataset_service.get_dataset(database_session, dataset_id, current_user.id)

    return series_service.get_label_intervals(
        dataset, request.app.state.settings, start_time, end_time, code, limit, offset
    )


@router.get(
    "/runs/{run_id}/predictions",
    response_model=PredictionResponse,
    summary="선택 구간의 행별 모델 예측",
    dependencies=[Depends(memory_guard)],
)
def get_predictions(
    run_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    split: PredictionSplit = "validation",
    model_key: ModelKey | None = None,
    start_time: Annotated[IsoDateTime | None, Query()] = None,
    end_time: Annotated[IsoDateTime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=10_000)] = 1000,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PredictionResponse:
    model_run = run_service.get_run(database_session, run_id, current_user.id)

    dataset = dataset_service.get_dataset(database_session, model_run.dataset_id, current_user.id)

    return series_service.get_predictions(
        model_run,
        dataset,
        request.app.state.settings,
        split,
        model_key,
        start_time,
        end_time,
        limit,
        offset,
    )


@router.get(
    "/runs/{run_id}/prediction-intervals",
    response_model=PredictionIntervals,
    summary="모델 예측별 연속 관측 구간",
    dependencies=[Depends(memory_guard)],
)
def get_prediction_intervals(
    run_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    split: PredictionSplit = "validation",
    model_key: ModelKey | None = None,
    start_time: Annotated[IsoDateTime | None, Query()] = None,
    end_time: Annotated[IsoDateTime | None, Query()] = None,
    predicted_code: Annotated[int, Query(ge=0, le=1)] = 1,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> PredictionIntervals:
    model_run = run_service.get_run(database_session, run_id, current_user.id)

    dataset = dataset_service.get_dataset(database_session, model_run.dataset_id, current_user.id)

    return series_service.get_prediction_intervals(
        model_run,
        dataset,
        request.app.state.settings,
        split,
        model_key,
        start_time,
        end_time,
        predicted_code,
        limit,
        offset,
    )
