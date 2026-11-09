"""검토 기록·상태 전환·버전 충돌·근거 보존·원자적 수정 이력을 확인한다."""

from datetime import datetime
from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.db import Database
from app.models import Dataset, ObservationHistory, Review, ReviewHistory, User
from app.schemas.observations import ObservationCreate, ObservationPatch
from app.schemas.reviews import ReviewCreate, ReviewPatch, ReviewReopen, ReviewRevision
from app.services import datasets as dataset_service
from app.services import observations as observation_service
from app.services import reviews as review_service

CSV_BYTES = (
    b"timestamp,sensor_00,sensor_01,label\n"
    b"2026-11-09T00:00:00,1,11,normal\n"
    b"2026-11-09T00:01:00,2,12,abnormal\n"
    b"2026-11-09T00:02:00,3,13,normal\n"
    b"2026-11-09T00:03:00,4,14,normal\n"
    b"2026-11-09T00:04:00,5,15,abnormal\n"
    b"2026-11-09T00:08:00,6,16,normal\n"
)


@pytest.fixture
def review_storage(tmp_path):
    settings = Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "reviews.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
    )

    database = Database(settings.database_path)

    database.create_tables()
    with database.session_factory() as session:
        owner = User(
            username="owner", display_name="검토 작성자", password_hash="not-login-fixture"
        )

        other = User(
            username="other", display_name="다른 사용자", password_hash="not-login-fixture"
        )

        session.add_all([owner, other])
        session.commit()
        dataset, _ = dataset_service.upload_dataset(
            session, UploadFile(file=BytesIO(CSV_BYTES), filename="review.csv"), owner, settings
        )

        observation = observation_service.create_observation(
            session,
            owner,
            settings,
            ObservationCreate(
                dataset_id=dataset.id,
                channel="sensor_00",
                start_time=datetime(2026, 11, 9, 0, 1),
                end_time=datetime(2026, 11, 9, 0, 3),
                content="관찰 첫 버전: 누수 확인 필요",
            ),
        )

        yield {
            "database": database,
            "settings": settings,
            "owner_id": owner.id,
            "other_id": other.id,
            "dataset_id": dataset.id,
            "observation": observation,
        }
    database.dispose()


def create_body(context, **changes):
    body = {
        "dataset_id": context["dataset_id"],
        "channel": "sensor_00",
        "start_time": "2026-11-09T00:01:00",
        "end_time": "2026-11-09T00:03:00",
        "conclusion": "  누수 위치를 재확인함.\n판단은 보류.  ",
        "observations": [{"observation_id": context["observation"].id, "revision": 1}],
    }

    body.update(changes)
    return ReviewCreate.model_validate(body)


def make_review(context, **changes):
    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        return review_service.create_review(
            session, owner, context["settings"], create_body(context, **changes)
        )


def read_review(context, review_id):
    with context["database"].session_factory() as session:
        review = review_service.get_review(session, review_id, context["owner_id"])

        return review_service.review_detail(session, review)


def history(context, review_id):
    with context["database"].session_factory() as session:
        return review_service.get_history(session, review_id, context["owner_id"])


def test_create_complete_reopen_and_update_keep_each_full_snapshot(review_storage):
    context = review_storage

    created = make_review(context)

    assert created.status == "in_progress"
    assert created.revision == 1
    assert created.conclusion == create_body(context).conclusion
    assert created.completed_at is None
    assert created.completed_by is None
    assert created.evidence.observations == [context["observation"]]
    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        completed = review_service.complete_review(
            session, owner, context["settings"], created.id, ReviewRevision(revision=1)
        )

        assert completed.status == "completed"
        assert completed.revision == 2
        # 검토 완료와 정상·고장 확정은 별개의 값이다.
        assert completed.judgment == "needs_check"
        assert completed.completed_by == created.author
        assert completed.completed_at is not None
        repeated = review_service.complete_review(
            session, owner, context["settings"], created.id, ReviewRevision(revision=2)
        )

        assert repeated == completed
        with pytest.raises(HTTPException) as error:
            review_service.patch_review(
                session,
                owner,
                context["settings"],
                created.id,
                ReviewPatch(revision=2, conclusion="완료 내용 덮어쓰기"),
            )
        assert error.value.status_code == 409
        reopened = review_service.reopen_review(
            session, owner, created.id, ReviewReopen(revision=2, reason="추가 현장 확인")
        )

        assert reopened.status == "in_progress"
        assert reopened.revision == 3
        assert reopened.completed_at is None
        assert reopened.completed_by is None
        changed = review_service.patch_review(
            session,
            owner,
            context["settings"],
            created.id,
            ReviewPatch(revision=3, conclusion="현장 재확인 완료", judgment="anomaly_candidate"),
        )

        assert changed.revision == 4
        assert changed.created_at == created.created_at
        assert changed.author == created.author
        assert changed.evidence == created.evidence
    saved_history = history(context, created.id)

    assert saved_history.total == 4
    assert [item.action for item in saved_history.items] == [
        "updated",
        "reopened",
        "completed",
        "created",
    ]
    assert saved_history.items[0].snapshot == changed
    assert saved_history.items[1].reason == "추가 현장 확인"
    assert saved_history.items[2].snapshot == completed
    assert saved_history.items[3].snapshot == created
    assert (
        context["settings"].dataset_storage_path / f"{context['dataset_id']}.csv"
    ).read_bytes() == CSV_BYTES


@pytest.mark.parametrize("changes", [{"conclusion": "  "}, {"observations": []}])
def test_completion_needs_conclusion_and_evidence_without_changing_record(review_storage, changes):
    context = review_storage

    created = make_review(context, **changes)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        with pytest.raises(HTTPException) as error:
            review_service.complete_review(
                session, owner, context["settings"], created.id, ReviewRevision(revision=1)
            )
        assert error.value.status_code == 422
    assert read_review(context, created.id) == created
    assert history(context, created.id).total == 1


@pytest.mark.parametrize("operation", ["patch", "complete", "reopen"])
def test_stale_revision_is_rejected_for_every_state_write(review_storage, operation):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        current = review_service.patch_review(
            session,
            owner,
            context["settings"],
            created.id,
            ReviewPatch(revision=1, conclusion="먼저 저장"),
        )

        with pytest.raises(HTTPException) as error:
            if operation == "patch":
                review_service.patch_review(
                    session,
                    owner,
                    context["settings"],
                    created.id,
                    ReviewPatch(revision=1, conclusion="늦은 수정"),
                )
            elif operation == "complete":
                review_service.complete_review(
                    session, owner, context["settings"], created.id, ReviewRevision(revision=1)
                )
            else:
                review_service.reopen_review(
                    session, owner, created.id, ReviewReopen(revision=1, reason="늦은 재검토")
                )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "REVIEW_CONFLICT"
    assert read_review(context, created.id) == current
    assert history(context, created.id).total == 2


def test_database_cas_catches_update_after_initial_read(review_storage, monkeypatch):
    context = review_storage

    created = make_review(context)

    with (
        context["database"].session_factory() as first,
        context["database"].session_factory() as second,
    ):
        first_user = first.get(User, context["owner_id"])

        second_user = second.get(User, context["owner_id"])

        stale = review_service.get_review(first, created.id, first_user.id)

        winner = review_service.patch_review(
            second,
            second_user,
            context["settings"],
            created.id,
            ReviewPatch(revision=1, conclusion="먼저 저장한 내용"),
        )

        original_get = review_service.get_review

        monkeypatch.setattr(review_service, "get_review", lambda *args: stale)
        with pytest.raises(HTTPException) as error:
            review_service.patch_review(
                first,
                first_user,
                context["settings"],
                created.id,
                ReviewPatch(revision=1, conclusion="뒤늦게 덮어쓰기"),
            )
        assert error.value.status_code == 409
        assert error.value.detail["code"] == "REVIEW_CONFLICT"
        monkeypatch.setattr(review_service, "get_review", original_get)
    assert read_review(context, created.id) == winner
    assert history(context, created.id).total == 2


@pytest.mark.parametrize("operation", ["create", "patch", "complete", "reopen"])
def test_history_failure_rolls_back_record_and_transition(review_storage, monkeypatch, operation):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        before = created

        if operation == "reopen":
            before = review_service.complete_review(
                session, owner, context["settings"], created.id, ReviewRevision(revision=1)
            )

        def fail_history(*args):
            raise SQLAlchemyError("private test SQL error")

        monkeypatch.setattr(review_service, "_add_history", fail_history)
        with pytest.raises(HTTPException) as error:
            if operation == "create":
                review_service.create_review(
                    session, owner, context["settings"], create_body(context)
                )
            elif operation == "patch":
                review_service.patch_review(
                    session,
                    owner,
                    context["settings"],
                    created.id,
                    ReviewPatch(revision=1, conclusion="저장 실패할 수정"),
                )
            elif operation == "complete":
                review_service.complete_review(
                    session, owner, context["settings"], created.id, ReviewRevision(revision=1)
                )
            else:
                review_service.reopen_review(
                    session, owner, created.id, ReviewReopen(revision=2, reason="실패할 재검토")
                )
        assert error.value.status_code == 503
        assert "private" not in str(error.value.detail)
    assert read_review(context, created.id) == before
    assert history(context, created.id).total == before.revision
    with context["database"].session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Review)) == 1


def test_commit_failure_also_rolls_back_update(review_storage, monkeypatch):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        def fail_commit():
            raise SQLAlchemyError("test-only commit error")

        monkeypatch.setattr(session, "commit", fail_commit)
        with pytest.raises(HTTPException) as error:
            review_service.patch_review(
                session,
                owner,
                context["settings"],
                created.id,
                ReviewPatch(revision=1, conclusion="커밋이 실패할 내용"),
            )
        assert error.value.status_code == 503
    assert read_review(context, created.id) == created
    assert history(context, created.id).total == 1


def test_observation_changes_never_silently_replace_captured_revision(review_storage):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        latest_observation = observation_service.patch_observation(
            session,
            owner,
            context["settings"],
            context["observation"].id,
            ObservationPatch(revision=1, content="관찰 두 번째 버전", judgment="normal"),
        )

        edited = review_service.patch_review(
            session,
            owner,
            context["settings"],
            created.id,
            ReviewPatch(revision=1, conclusion="기존 관찰 버전을 근거로 한 설명 보완"),
        )

        assert edited.evidence == created.evidence
        linked = review_service.patch_review(
            session,
            owner,
            context["settings"],
            created.id,
            ReviewPatch(
                revision=2,
                observations=[{"observation_id": latest_observation.id, "revision": 2}],
            ),
        )

        assert linked.evidence.observations == [latest_observation]
        completed = review_service.complete_review(
            session, owner, context["settings"], created.id, ReviewRevision(revision=3)
        )

        observation_service.patch_observation(
            session,
            owner,
            context["settings"],
            latest_observation.id,
            ObservationPatch(revision=2, content="관찰 세 번째 버전"),
        )
    assert read_review(context, created.id) == completed
    assert history(context, created.id).items[-1].snapshot.evidence == created.evidence


def test_unlinking_evidence_is_explicit_and_prevents_empty_completion(review_storage):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        unlinked = review_service.patch_review(
            session,
            owner,
            context["settings"],
            created.id,
            ReviewPatch(revision=1, model_result=None, observations=[]),
        )

        assert unlinked.evidence.model_result is None
        assert unlinked.evidence.observations == []
        with pytest.raises(HTTPException) as error:
            review_service.complete_review(
                session, owner, context["settings"], created.id, ReviewRevision(revision=2)
            )
        assert error.value.status_code == 422
    assert history(context, created.id).items[-1].snapshot == created


@pytest.mark.parametrize(
    "changes",
    [
        {"channel": "sensor_01"},
        {"start_time": "2026-11-09T00:04:00", "end_time": "2026-11-09T00:04:00"},
        {"start_time": "2026-11-09T00:09:00"},
        {"end_time": "2026-11-09T00:00:00"},
    ],
)
def test_merged_context_is_revalidated_without_partial_write(review_storage, changes):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        with pytest.raises(HTTPException) as error:
            review_service.patch_review(
                session,
                owner,
                context["settings"],
                created.id,
                ReviewPatch.model_validate({"revision": 1, **changes}),
            )
        assert error.value.status_code == 422
    assert read_review(context, created.id) == created
    assert history(context, created.id).total == 1


def test_saved_reviews_and_history_are_readable_without_source_file(review_storage):
    context = review_storage

    created = make_review(context)

    source_path = context["settings"].dataset_storage_path / f"{context['dataset_id']}.csv"

    source_path.unlink()
    # 조회가 CSV를 읽거나 모델을 다시 실행하면 과거 검토 기록까지 사라지는 문제가 생긴다.
    assert read_review(context, created.id) == created
    assert history(context, created.id).items[0].snapshot == created
    with context["database"].session_factory() as session:
        listed = review_service.list_reviews(
            session, context["owner_id"], dataset_id=context["dataset_id"]
        )

        assert listed.items == [created]


def test_source_tamper_blocks_new_writes_but_keeps_saved_history(review_storage):
    context = review_storage

    created = make_review(context)

    source_path = context["settings"].dataset_storage_path / f"{context['dataset_id']}.csv"

    source_path.write_bytes(CSV_BYTES.replace(b",1,11,", b",9,11,"))
    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        with pytest.raises(HTTPException) as error:
            review_service.complete_review(
                session, owner, context["settings"], created.id, ReviewRevision(revision=1)
            )
        assert error.value.status_code == 409
    assert read_review(context, created.id) == created
    assert history(context, created.id).total == 1


def test_other_owner_cannot_get_history_update_complete_reopen_or_filter(review_storage):
    context = review_storage

    created = make_review(context)

    with context["database"].session_factory() as session:
        other = session.get(User, context["other_id"])

        operations = [
            lambda: review_service.get_review(session, created.id, other.id),
            lambda: review_service.get_history(session, created.id, other.id),
            lambda: review_service.patch_review(
                session,
                other,
                context["settings"],
                created.id,
                ReviewPatch(revision=1, conclusion="수정"),
            ),
            lambda: review_service.complete_review(
                session, other, context["settings"], created.id, ReviewRevision(revision=1)
            ),
            lambda: review_service.reopen_review(
                session, other, created.id, ReviewReopen(revision=1, reason="수정")
            ),
            lambda: review_service.list_reviews(
                session, other.id, dataset_id=context["dataset_id"]
            ),
        ]

        for operation in operations:
            with pytest.raises(HTTPException) as error:
                operation()
            assert error.value.status_code == 404
        assert review_service.list_reviews(session, other.id).total == 0


def test_state_and_overlap_filters_and_history_pagination(review_storage):
    context = review_storage

    first = make_review(context)

    second = make_review(
        context, observations=[], start_time="2026-11-09T00:04:00", end_time="2026-11-09T00:04:00"
    )

    with context["database"].session_factory() as session:
        owner = session.get(User, context["owner_id"])

        review_service.complete_review(
            session, owner, context["settings"], first.id, ReviewRevision(revision=1)
        )
        assert review_service.list_reviews(session, owner.id, status="completed").total == 1
        assert (
            review_service.list_reviews(session, owner.id, status="in_progress").items[0].id
            == second.id
        )
        assert review_service.list_reviews(session, owner.id, judgment="normal").total == 0
        matched = review_service.list_reviews(
            session,
            owner.id,
            dataset_id=context["dataset_id"],
            channel="sensor_00",
            start_time=datetime(2026, 11, 9, 0, 3),
            end_time=datetime(2026, 11, 9, 0, 3),
        )

        assert [item.id for item in matched.items] == [first.id]
        assert review_service.list_reviews(session, owner.id, limit=1).total == 2
        assert len(review_service.list_reviews(session, owner.id, offset=1).items) == 1
        paged = review_service.get_history(session, first.id, owner.id, limit=1, offset=1)

        assert paged.total == 2
        assert [item.revision for item in paged.items] == [1]


@pytest.mark.parametrize(
    "query",
    [
        {"channel": "sensor_00"},
        {"start_time": datetime(2026, 11, 9)},
        {"channel": "does-not-exist", "dataset_id": "self"},
        {"start_time": "bad-time", "dataset_id": "self"},
        {"start_time": "2026-11-09T00:02:00Z", "dataset_id": "self"},
        {
            "start_time": "2026-11-09T00:03:00",
            "end_time": "2026-11-09T00:01:00",
            "dataset_id": "self",
        },
    ],
)
def test_invalid_list_context_is_explicit_error(review_storage, query):
    context = review_storage

    query = {
        key: context["dataset_id"] if value == "self" else value for key, value in query.items()
    }

    with context["database"].session_factory() as session:
        with pytest.raises(HTTPException) as error:
            review_service.list_reviews(session, context["owner_id"], **query)
        assert error.value.status_code == 422


def test_restart_preserves_review_evidence_history_and_existing_tables(review_storage):
    context = review_storage

    created = make_review(context)

    context["database"].dispose()
    restarted = Database(context["settings"].database_path)

    try:
        restarted.create_tables()
        with restarted.session_factory() as session:
            restored = review_service.review_detail(
                session, review_service.get_review(session, created.id, context["owner_id"])
            )

            assert restored == created
            assert review_service.get_history(session, created.id, context["owner_id"]).total == 1
            assert session.scalar(select(func.count()).select_from(User)) == 2
            assert session.scalar(select(func.count()).select_from(Dataset)) == 1
            assert session.scalar(select(func.count()).select_from(ObservationHistory)) == 1
            assert session.scalar(select(func.count()).select_from(ReviewHistory)) == 1
    finally:
        restarted.dispose()
