"""현장 관찰을 소유자별로 보관하고 버전 충돌 없이 수정 이력을 남긴다."""

from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Dataset, Observation, ObservationHistory, User, utc_timestamp
from app.schemas.auth import PublicUser
from app.schemas.observations import (
    ObservationCreate,
    ObservationHistoryItem,
    ObservationHistoryList,
    ObservationList,
    ObservationPatch,
    ObservationResponse,
    parse_iso_datetime,
)
from app.services import datasets as dataset_service
from app.services import runs as run_service
from app.services import series as series_service


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    # SQL 인자와 내부 경로를 공개하지 않고, 실패한 쓰기는 호출한 곳에서 되돌린다.
    return _error(503, "OBSERVATION_UNAVAILABLE", "현장 관찰 기록을 처리하지 못했습니다.")


def _conflict() -> HTTPException:
    return _error(
        409,
        "OBSERVATION_CONFLICT",
        "다른 수정이 먼저 저장됐습니다. 최신 기록을 확인한 뒤 다시 수정하세요.",
    )


def get_observation(database_session: Session, observation_id: str, owner_id: int) -> Observation:
    try:
        observation = database_session.scalar(
            select(Observation)
            .where(Observation.id == observation_id, Observation.owner_id == owner_id)
            .execution_options(populate_existing=True)
        )

    except SQLAlchemyError:
        raise _unavailable() from None
    if observation is None:
        # 다른 계정의 기록과 존재하지 않는 기록은 같은 응답으로 처리한다.
        raise _error(404, "OBSERVATION_NOT_FOUND", "현장 관찰 기록을 찾을 수 없습니다.")
    return observation


def observation_detail(database_session: Session, observation: Observation) -> ObservationResponse:
    try:
        author = database_session.get(User, observation.owner_id)

        last_editor = database_session.get(User, observation.last_editor_id)

        if author is None or last_editor is None:
            raise _unavailable()
        return ObservationResponse(
            id=observation.id,
            dataset_id=observation.dataset_id,
            run_id=observation.run_id,
            model_key=observation.model_key,
            channel=observation.channel,
            start_time=observation.start_time,
            end_time=observation.end_time,
            location=observation.location,
            content=observation.content,
            judgment=observation.judgment,
            revision=observation.revision,
            created_at=observation.created_at,
            updated_at=observation.updated_at,
            author=PublicUser.model_validate(author),
            last_editor=PublicUser.model_validate(last_editor),
        )
    except (SQLAlchemyError, ValidationError):
        raise _unavailable() from None


def _validate_run_context(
    database_session: Session, owner_id: int, body: ObservationCreate
) -> None:
    if body.run_id is None:
        return

    model_run = run_service.get_run(database_session, body.run_id, owner_id)

    if model_run.dataset_id != body.dataset_id:
        raise _error(422, "OBSERVATION_CONTEXT_MISMATCH", "같은 CSV의 모델 실행을 지정하세요.")
    if model_run.status != "completed":
        raise _error(409, "RUN_NOT_READY", "학습을 완료한 모델 실행에 관찰을 연결하세요.")
    if body.model_key is not None:
        completed_models = {
            item["model_key"] for item in (model_run.training_report or {}).get("models", [])
        }

        if body.model_key not in completed_models:
            raise _error(422, "MODEL_NOT_TRAINED", "이 실행에서 학습한 모델을 지정하세요.")


def _add_history(
    database_session: Session, observation: Observation, snapshot: ObservationResponse
) -> None:
    # 현장 기록과 이력은 같은 트랜잭션에서 저장한다. 둘 중 하나만 남지 않게 한다.
    database_session.add(
        ObservationHistory(
            observation_id=observation.id,
            revision=observation.revision,
            changed_by_id=observation.last_editor_id,
            changed_at=observation.updated_at,
            snapshot=snapshot.model_dump(mode="json"),
        )
    )


def create_observation(
    database_session: Session, current_user: User, settings: Settings, body: ObservationCreate
) -> ObservationResponse:
    dataset = dataset_service.get_dataset(database_session, body.dataset_id, current_user.id)

    _validate_run_context(database_session, current_user.id, body)
    start_time, end_time = series_service.validate_observation_interval(
        dataset, settings, body.channel, body.start_time, body.end_time
    )

    timestamp = utc_timestamp()

    observation = Observation(
        id=uuid4().hex,
        owner_id=current_user.id,
        dataset_id=body.dataset_id,
        run_id=body.run_id,
        model_key=body.model_key,
        channel=body.channel,
        start_time=start_time,
        end_time=end_time,
        location=body.location,
        content=body.content,
        judgment=body.judgment,
        revision=1,
        last_editor_id=current_user.id,
        created_at=timestamp,
        updated_at=timestamp,
    )

    try:
        database_session.add(observation)
        database_session.flush()
        snapshot = observation_detail(database_session, observation)

        _add_history(database_session, observation, snapshot)
        database_session.commit()
        return snapshot
    except (SQLAlchemyError, HTTPException):
        database_session.rollback()
        raise _unavailable() from None


def patch_observation(
    database_session: Session,
    current_user: User,
    settings: Settings,
    observation_id: str,
    body: ObservationPatch,
) -> ObservationResponse:
    observation = get_observation(database_session, observation_id, current_user.id)

    if observation.revision != body.revision:
        raise _conflict()

    dataset = dataset_service.get_dataset(database_session, observation.dataset_id, current_user.id)

    changes = body.model_dump(exclude_unset=True, exclude={"revision"})

    channel = changes.get("channel", observation.channel)

    start_bound = changes.get("start_time", datetime.fromisoformat(observation.start_time))

    end_bound = changes.get("end_time", datetime.fromisoformat(observation.end_time))

    # 한쪽 시각만 바뀌어도 저장된 다른 시각과 함께 구간 전체를 다시 확인한다.
    start_time, end_time = series_service.validate_observation_interval(
        dataset, settings, channel, start_bound, end_bound
    )

    changes.update(
        channel=channel,
        start_time=start_time,
        end_time=end_time,
        revision=body.revision + 1,
        last_editor_id=current_user.id,
        updated_at=utc_timestamp(),
    )
    try:
        # 읽은 뒤 다른 요청이 저장했더라도 DB 조건식으로 덮어쓰기를 막는다.
        update_result = database_session.execute(
            update(Observation)
            .where(
                Observation.id == observation_id,
                Observation.owner_id == current_user.id,
                Observation.revision == body.revision,
            )
            .values(**changes)
            .execution_options(synchronize_session=False)
        )

        if update_result.rowcount != 1:
            database_session.rollback()
            raise _conflict()
        database_session.refresh(observation)
        snapshot = observation_detail(database_session, observation)

        _add_history(database_session, observation, snapshot)
        database_session.commit()
        return snapshot
    except SQLAlchemyError:
        database_session.rollback()
        raise _unavailable() from None
    except HTTPException:
        database_session.rollback()
        raise


def _list_context(
    database_session: Session,
    owner_id: int,
    dataset_id: str | None,
    run_id: str | None,
    channel: str | None,
    start_time: str | None,
    end_time: str | None,
) -> tuple[Dataset | None, datetime | None, datetime | None]:
    if dataset_id is None and any(value is not None for value in (channel, start_time, end_time)):
        raise _error(422, "DATASET_REQUIRED", "채널·시각으로 찾을 때는 CSV ID도 지정하세요.")

    dataset = (
        dataset_service.get_dataset(database_session, dataset_id, owner_id)
        if dataset_id is not None
        else None
    )

    if run_id is not None:
        model_run = run_service.get_run(database_session, run_id, owner_id)

        if dataset_id is not None and model_run.dataset_id != dataset_id:
            raise _error(422, "OBSERVATION_CONTEXT_MISMATCH", "같은 CSV의 모델 실행을 지정하세요.")
    if dataset is None:
        return None, None, None

    inspection = dataset_service.dataset_detail(dataset).inspection

    if channel is not None and channel not in inspection.channels:
        raise _error(422, "UNKNOWN_CHANNEL", "CSV에 있는 채널을 지정하세요.")
    try:
        start_bound = parse_iso_datetime(start_time) if start_time is not None else None

        end_bound = parse_iso_datetime(end_time) if end_time is not None else None

    except ValueError:
        raise _error(422, "INVALID_TIME_RANGE", "구간은 ISO 날짜·시각으로 입력하세요.") from None

    normalized_start, normalized_end = series_service.normalize_time_bounds(
        inspection.timezone_mode, start_bound, end_bound
    )

    return dataset, normalized_start, normalized_end


def list_observations(
    database_session: Session,
    owner_id: int,
    *,
    dataset_id: str | None = None,
    run_id: str | None = None,
    channel: str | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> ObservationList:
    _, start_bound, end_bound = _list_context(
        database_session, owner_id, dataset_id, run_id, channel, start_time, end_time
    )

    filters = [Observation.owner_id == owner_id]

    if dataset_id is not None:
        filters.append(Observation.dataset_id == dataset_id)
    if run_id is not None:
        filters.append(Observation.run_id == run_id)
    if channel is not None:
        filters.append(Observation.channel == channel)
    if start_bound is not None:
        filters.append(Observation.end_time >= series_service.format_timestamp(start_bound))
    if end_bound is not None:
        filters.append(Observation.start_time <= series_service.format_timestamp(end_bound))
    try:
        total = database_session.scalar(
            select(func.count()).select_from(Observation).where(*filters)
        )

        observations = database_session.scalars(
            select(Observation)
            .where(*filters)
            .order_by(Observation.updated_at.desc(), Observation.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        return ObservationList(
            items=[
                observation_detail(database_session, observation) for observation in observations
            ],
            total=total or 0,
            limit=limit,
            offset=offset,
        )
    except SQLAlchemyError:
        raise _unavailable() from None


def get_history(
    database_session: Session,
    observation_id: str,
    owner_id: int,
    limit: int = 20,
    offset: int = 0,
) -> ObservationHistoryList:
    # 건수를 세기 전에 소유자를 확인해 다른 사람의 기록 존재 여부를 알리지 않는다.
    get_observation(database_session, observation_id, owner_id)
    try:
        total = database_session.scalar(
            select(func.count())
            .select_from(ObservationHistory)
            .where(ObservationHistory.observation_id == observation_id)
        )

        history_rows = database_session.scalars(
            select(ObservationHistory)
            .where(ObservationHistory.observation_id == observation_id)
            .order_by(ObservationHistory.revision.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        history_items = []

        for history in history_rows:
            snapshot = ObservationResponse.model_validate(history.snapshot)

            history_items.append(
                ObservationHistoryItem(
                    revision=history.revision,
                    changed_at=history.changed_at,
                    changed_by=snapshot.last_editor,
                    snapshot=snapshot,
                )
            )
        return ObservationHistoryList(
            observation_id=observation_id,
            items=history_items,
            total=total or 0,
            limit=limit,
            offset=offset,
        )
    except (SQLAlchemyError, ValidationError):
        raise _unavailable() from None
