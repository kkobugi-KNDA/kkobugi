"""검토 근거와 사람의 판단을 보관하고 완료·재검토 과정을 이력으로 남긴다."""

from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Review, ReviewHistory, User, utc_timestamp
from app.schemas.auth import PublicUser
from app.schemas.observations import Judgment, parse_iso_datetime
from app.schemas.reviews import (
    ModelResultReference,
    ObservationReference,
    ReviewCreate,
    ReviewEvidence,
    ReviewHistoryItem,
    ReviewHistoryList,
    ReviewList,
    ReviewPatch,
    ReviewReopen,
    ReviewResponse,
    ReviewRevision,
    ReviewStatus,
)
from app.services import datasets as dataset_service
from app.services import review_evidence as evidence_service
from app.services import runs as run_service
from app.services import series as series_service


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    # SQL 인자나 파일 위치를 응답에 넣지 않고 저장 실패만 알려준다.
    return _error(503, "REVIEW_UNAVAILABLE", "검토 기록을 처리하지 못했습니다.")


def _conflict() -> HTTPException:
    return _error(
        409,
        "REVIEW_CONFLICT",
        "다른 수정이 먼저 저장됐습니다. 최신 검토 기록을 읽고 다시 요청하세요.",
    )


def get_review(database_session: Session, review_id: str, owner_id: int) -> Review:
    try:
        review = database_session.scalar(
            select(Review)
            .where(Review.id == review_id, Review.owner_id == owner_id)
            .execution_options(populate_existing=True)
        )

    except SQLAlchemyError:
        raise _unavailable() from None
    if review is None:
        # 다른 계정의 기록인지 없는 ID인지 구분해서 알리지 않는다.
        raise _error(404, "REVIEW_NOT_FOUND", "검토 기록을 찾을 수 없습니다.")
    return review


def review_detail(database_session: Session, review: Review) -> ReviewResponse:
    try:
        author = database_session.get(User, review.owner_id)

        last_editor = database_session.get(User, review.last_editor_id)

        completed_by = (
            database_session.get(User, review.completed_by_id)
            if review.completed_by_id is not None
            else None
        )

        if author is None or last_editor is None:
            raise _unavailable()
        if review.completed_by_id is not None and completed_by is None:
            raise _unavailable()
        # 조회는 저장된 근거만 읽는다. CSV나 모델 파일이 없어도 과거 검토는 보존된다.
        return ReviewResponse(
            id=review.id,
            dataset_id=review.dataset_id,
            channel=review.channel,
            start_time=review.start_time,
            end_time=review.end_time,
            conclusion=review.conclusion,
            judgment=review.judgment,
            status=review.status,
            revision=review.revision,
            created_at=review.created_at,
            updated_at=review.updated_at,
            author=PublicUser.model_validate(author),
            last_editor=PublicUser.model_validate(last_editor),
            completed_at=review.completed_at,
            completed_by=PublicUser.model_validate(completed_by) if completed_by else None,
            evidence=ReviewEvidence.model_validate(review.evidence),
        )
    except (SQLAlchemyError, ValidationError, TypeError):
        raise _unavailable() from None


def _add_history(
    database_session: Session,
    review: Review,
    snapshot: ReviewResponse,
    action: str,
    reason: str = "",
) -> None:
    # 현재 기록과 당시의 전체 내용을 같은 트랜잭션에서 저장한다.
    database_session.add(
        ReviewHistory(
            review_id=review.id,
            revision=review.revision,
            action=action,
            reason=reason,
            changed_by_id=review.last_editor_id,
            changed_at=review.updated_at,
            snapshot=snapshot.model_dump(mode="json"),
        )
    )


def _check_revision(review: Review, expected_revision: int) -> None:
    if review.revision != expected_revision:
        raise _conflict()


def _require_in_progress(review: Review) -> None:
    if review.status != "in_progress":
        raise _error(
            409,
            "REVIEW_ALREADY_COMPLETED",
            "완료한 검토는 먼저 재검토로 전환한 뒤 수정하세요.",
        )


def _save_update(
    database_session: Session,
    current_user: User,
    review: Review,
    expected_revision: int,
    changes: dict,
    action: str,
    reason: str = "",
) -> ReviewResponse:
    changes = {
        **changes,
        "revision": expected_revision + 1,
        "last_editor_id": current_user.id,
        "updated_at": utc_timestamp(),
    }

    try:
        # 읽은 직후 다른 요청이 저장했더라도 버전·상태 조건으로 덮어쓰기를 막는다.
        update_result = database_session.execute(
            update(Review)
            .where(
                Review.id == review.id,
                Review.owner_id == current_user.id,
                Review.revision == expected_revision,
                Review.status == review.status,
            )
            .values(**changes)
            .execution_options(synchronize_session=False)
        )

        if update_result.rowcount != 1:
            database_session.rollback()
            raise _conflict()
        database_session.refresh(review)
        snapshot = review_detail(database_session, review)

        _add_history(database_session, review, snapshot, action, reason)
        database_session.commit()
        return snapshot
    except SQLAlchemyError:
        database_session.rollback()
        raise _unavailable() from None
    except HTTPException:
        database_session.rollback()
        raise


def create_review(
    database_session: Session, current_user: User, settings: Settings, body: ReviewCreate
) -> ReviewResponse:
    dataset = dataset_service.get_dataset(database_session, body.dataset_id, current_user.id)

    start_time, end_time = series_service.validate_observation_interval(
        dataset, settings, body.channel, body.start_time, body.end_time
    )

    evidence = evidence_service.capture_evidence(
        database_session,
        current_user.id,
        dataset,
        body.channel,
        start_time,
        end_time,
        body.model_result,
        body.observations,
    )

    timestamp = utc_timestamp()

    review = Review(
        id=uuid4().hex,
        owner_id=current_user.id,
        dataset_id=body.dataset_id,
        run_id=evidence.model_result.run_id if evidence.model_result else None,
        channel=body.channel,
        start_time=start_time,
        end_time=end_time,
        conclusion=body.conclusion,
        judgment=body.judgment,
        status="in_progress",
        revision=1,
        evidence=evidence.model_dump(mode="json"),
        last_editor_id=current_user.id,
        completed_at=None,
        completed_by_id=None,
        created_at=timestamp,
        updated_at=timestamp,
    )

    try:
        database_session.add(review)
        database_session.flush()
        snapshot = review_detail(database_session, review)

        _add_history(database_session, review, snapshot, "created")
        database_session.commit()
        return snapshot
    except SQLAlchemyError:
        database_session.rollback()
        raise _unavailable() from None
    except HTTPException:
        database_session.rollback()
        raise


def _saved_references(
    evidence: ReviewEvidence,
) -> tuple[ModelResultReference | None, list[ObservationReference]]:
    model_reference = (
        ModelResultReference(
            run_id=evidence.model_result.run_id,
            model_key=evidence.model_result.model_key,
            split=evidence.model_result.split,
        )
        if evidence.model_result is not None
        else None
    )

    observation_references = [
        ObservationReference(observation_id=observation.id, revision=observation.revision)
        for observation in evidence.observations
    ]

    return model_reference, observation_references


def patch_review(
    database_session: Session,
    current_user: User,
    settings: Settings,
    review_id: str,
    body: ReviewPatch,
) -> ReviewResponse:
    review = get_review(database_session, review_id, current_user.id)

    _check_revision(review, body.revision)
    _require_in_progress(review)
    saved_detail = review_detail(database_session, review)

    saved_model_reference, saved_observation_references = _saved_references(saved_detail.evidence)

    dataset = dataset_service.get_dataset(database_session, review.dataset_id, current_user.id)

    changes = body.model_dump(
        exclude_unset=True, exclude={"revision", "model_result", "observations"}
    )

    channel = changes.get("channel", review.channel)

    start_bound = changes.get("start_time", datetime.fromisoformat(review.start_time))

    end_bound = changes.get("end_time", datetime.fromisoformat(review.end_time))

    # 범위나 채널을 바꾸면 그대로 남길 근거도 새 범위와 맞는지 다시 확인한다.
    start_time, end_time = series_service.validate_observation_interval(
        dataset, settings, channel, start_bound, end_bound
    )

    model_reference = (
        body.model_result if "model_result" in body.model_fields_set else saved_model_reference
    )

    observation_references = (
        body.observations
        if "observations" in body.model_fields_set
        else saved_observation_references
    )

    evidence = evidence_service.capture_evidence(
        database_session,
        current_user.id,
        dataset,
        channel,
        start_time,
        end_time,
        model_reference,
        observation_references,
    )

    changes.update(
        channel=channel,
        start_time=start_time,
        end_time=end_time,
        run_id=evidence.model_result.run_id if evidence.model_result else None,
        evidence=evidence.model_dump(mode="json"),
    )
    return _save_update(database_session, current_user, review, body.revision, changes, "updated")


def complete_review(
    database_session: Session,
    current_user: User,
    settings: Settings,
    review_id: str,
    body: ReviewRevision,
) -> ReviewResponse:
    review = get_review(database_session, review_id, current_user.id)

    _check_revision(review, body.revision)
    detail = review_detail(database_session, review)

    # 완료한 현재 버전의 반복 요청은 이력과 버전을 늘리지 않는다.
    if review.status == "completed":
        return detail
    _require_in_progress(review)
    if not review.conclusion.strip():
        raise _error(422, "REVIEW_CONCLUSION_REQUIRED", "완료하기 전에 검토 내용을 입력하세요.")
    if detail.evidence.model_result is None and not detail.evidence.observations:
        raise _error(
            422,
            "REVIEW_EVIDENCE_REQUIRED",
            "모델 결과나 현장 관찰을 하나 이상 연결한 뒤 완료하세요.",
        )
    dataset = dataset_service.get_dataset(database_session, review.dataset_id, current_user.id)

    series_service.validate_observation_interval(
        dataset,
        settings,
        review.channel,
        datetime.fromisoformat(review.start_time),
        datetime.fromisoformat(review.end_time),
    )
    # 이미 확인한 근거의 버전을 고정한다. 최신 관찰이나 새 모델 결과로 바꾸지 않는다.
    changes = {
        "status": "completed",
        "completed_at": utc_timestamp(),
        "completed_by_id": current_user.id,
    }

    return _save_update(database_session, current_user, review, body.revision, changes, "completed")


def reopen_review(
    database_session: Session,
    current_user: User,
    review_id: str,
    body: ReviewReopen,
) -> ReviewResponse:
    review = get_review(database_session, review_id, current_user.id)

    _check_revision(review, body.revision)
    if review.status != "completed":
        raise _error(409, "REVIEW_NOT_COMPLETED", "완료한 검토만 재검토로 전환할 수 있습니다.")
    # 완료자와 시각은 현재 상태에서만 해제하고, 이전 완료 기록은 이력에 남긴다.
    changes = {"status": "in_progress", "completed_at": None, "completed_by_id": None}

    return _save_update(
        database_session, current_user, review, body.revision, changes, "reopened", body.reason
    )


def _list_bounds(
    database_session: Session,
    owner_id: int,
    dataset_id: str | None,
    run_id: str | None,
    channel: str | None,
    start_time: datetime | str | None,
    end_time: datetime | str | None,
) -> tuple[datetime | None, datetime | None]:
    if dataset_id is None and any(value is not None for value in (channel, start_time, end_time)):
        raise _error(422, "DATASET_REQUIRED", "채널·시각으로 찾을 때는 CSV ID도 지정하세요.")
    dataset = (
        dataset_service.get_dataset(database_session, dataset_id, owner_id)
        if dataset_id is not None
        else None
    )

    if run_id is not None:
        model_run = run_service.get_run(database_session, run_id, owner_id)

        if dataset is not None and model_run.dataset_id != dataset.id:
            raise _error(422, "REVIEW_CONTEXT_MISMATCH", "같은 CSV의 모델 실행을 지정하세요.")
    if dataset is None:
        return None, None
    inspection = dataset_service.dataset_detail(dataset).inspection

    if channel is not None and channel not in inspection.channels:
        raise _error(422, "UNKNOWN_CHANNEL", "CSV에 있는 채널을 지정하세요.")
    try:
        start_bound = parse_iso_datetime(start_time) if start_time is not None else None

        end_bound = parse_iso_datetime(end_time) if end_time is not None else None

    except ValueError:
        raise _error(422, "INVALID_TIME_RANGE", "구간은 ISO 날짜·시각으로 입력하세요.") from None
    return series_service.normalize_time_bounds(inspection.timezone_mode, start_bound, end_bound)


def list_reviews(
    database_session: Session,
    owner_id: int,
    *,
    dataset_id: str | None = None,
    run_id: str | None = None,
    channel: str | None = None,
    status: ReviewStatus | None = None,
    judgment: Judgment | None = None,
    start_time: datetime | str | None = None,
    end_time: datetime | str | None = None,
    limit: int = 20,
    offset: int = 0,
) -> ReviewList:
    start_bound, end_bound = _list_bounds(
        database_session, owner_id, dataset_id, run_id, channel, start_time, end_time
    )

    filters = [Review.owner_id == owner_id]

    if dataset_id is not None:
        filters.append(Review.dataset_id == dataset_id)
    if run_id is not None:
        filters.append(Review.run_id == run_id)
    if channel is not None:
        filters.append(Review.channel == channel)
    if status is not None:
        filters.append(Review.status == status)
    if judgment is not None:
        filters.append(Review.judgment == judgment)
    if start_bound is not None:
        filters.append(Review.end_time >= series_service.format_timestamp(start_bound))
    if end_bound is not None:
        filters.append(Review.start_time <= series_service.format_timestamp(end_bound))
    try:
        total = database_session.scalar(select(func.count()).select_from(Review).where(*filters))

        reviews = database_session.scalars(
            select(Review)
            .where(*filters)
            .order_by(Review.updated_at.desc(), Review.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        return ReviewList(
            items=[review_detail(database_session, review) for review in reviews],
            total=total or 0,
            limit=limit,
            offset=offset,
        )
    except SQLAlchemyError:
        raise _unavailable() from None


def get_history(
    database_session: Session,
    review_id: str,
    owner_id: int,
    limit: int = 20,
    offset: int = 0,
) -> ReviewHistoryList:
    get_review(database_session, review_id, owner_id)
    try:
        total = database_session.scalar(
            select(func.count())
            .select_from(ReviewHistory)
            .where(ReviewHistory.review_id == review_id)
        )

        history_rows = database_session.scalars(
            select(ReviewHistory)
            .where(ReviewHistory.review_id == review_id)
            .order_by(ReviewHistory.revision.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        history_items = []

        for history in history_rows:
            snapshot = ReviewResponse.model_validate(history.snapshot)

            history_items.append(
                ReviewHistoryItem(
                    revision=history.revision,
                    action=history.action,
                    reason=history.reason,
                    changed_at=history.changed_at,
                    changed_by=snapshot.last_editor,
                    snapshot=snapshot,
                )
            )
        return ReviewHistoryList(
            review_id=review_id,
            items=history_items,
            total=total or 0,
            limit=limit,
            offset=offset,
        )
    except (SQLAlchemyError, ValidationError, TypeError):
        raise _unavailable() from None
