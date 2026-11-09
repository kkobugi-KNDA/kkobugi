"""계정별 시뮬레이션 CSV 업로드와 요청한 배치만 예측하는 API."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.simulations import SimulationBatch, SimulationList, SimulationManifest
from app.services import simulations as simulation_service

router = APIRouter(prefix="/api/v1/simulations", tags=["업로드 시뮬레이션"])

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post(
    "", response_model=SimulationManifest, status_code=201, dependencies=[Depends(memory_guard)]
)
def upload_simulation(
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    file: Annotated[UploadFile, File()],
    run_id: Annotated[str, Form(pattern=r"^[a-f0-9]{32}$")],
    model_key: Annotated[Literal["xgboost", "autoencoder"], Form()],
    timestamp_column: Annotated[str, Form(min_length=1, max_length=128)] = "timestamp",
) -> SimulationManifest:
    return simulation_service.upload_simulation(
        database_session,
        request.app.state.settings,
        current_user.id,
        file,
        run_id,
        model_key,
        timestamp_column,
    )


@router.get("", response_model=SimulationList)
def list_simulations(request: Request, current_user: CurrentUser) -> SimulationList:
    return simulation_service.list_simulations(request.app.state.settings, current_user.id)


@router.get("/{simulation_id}", response_model=SimulationManifest)
def get_simulation(
    simulation_id: str, request: Request, current_user: CurrentUser
) -> SimulationManifest:
    return SimulationManifest.model_validate(
        simulation_service.get_manifest(request.app.state.settings, simulation_id, current_user.id)
    )


@router.get(
    "/{simulation_id}/batch",
    response_model=SimulationBatch,
    dependencies=[Depends(memory_guard)],
)
def simulation_batch(
    simulation_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    channel: str,
    cursor: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> SimulationBatch:
    return simulation_service.simulation_batch(
        database_session,
        request.app.state.settings,
        current_user.id,
        simulation_id,
        cursor,
        limit,
        channel,
    )
