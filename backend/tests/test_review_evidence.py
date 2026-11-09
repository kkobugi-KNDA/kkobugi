"""검토 근거가 지정한 모델·관찰 버전을 유지하고 다른 계정의 정보를 읽지 않는지 확인한다."""

from copy import deepcopy
from types import SimpleNamespace

import joblib
import numpy as np
import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.db import Database
from app.models import Dataset, ModelRun, Observation, ObservationHistory, User
from app.schemas.reviews import ModelResultReference, ObservationReference
from app.services import modeling
from app.services.review_evidence import capture_evidence


def metrics(*, all_normal=False):
    return modeling.calculate_metrics(
        np.array([0, 1, 0, 1]),
        np.array([0, 0, 0, 0] if all_normal else [0, 1, 0, 1]),
        np.array([0.1, 0.2, 0.1, 0.2] if all_normal else [0.1, 0.9, 0.1, 0.9]),
    ).model_dump(mode="json")


def dataset_record(dataset_id, owner_id):
    return Dataset(
        id=dataset_id,
        owner_id=owner_id,
        filename="prepared.csv",
        size_bytes=123,
        sha256=dataset_id[0] * 64,
        timestamp_column="timestamp",
        label_column="label",
        normal_label="normal",
        abnormal_label="abnormal",
        inspection={"row_count": 12},
    )


def observation_snapshot(observation_id, owner, dataset_id, revision, content):
    return {
        "id": observation_id,
        "dataset_id": dataset_id,
        "run_id": None,
        "model_key": None,
        "channel": "sensor_00",
        "start_time": "2026-01-01T00:05:00.000000",
        "end_time": "2026-01-01T00:06:00.000000",
        "location": "펌프 주변",
        "content": content,
        "judgment": "needs_check",
        "revision": revision,
        "created_at": 100,
        "updated_at": 100 + revision,
        "author": {"id": owner.id, "username": owner.username, "display_name": owner.display_name},
        "last_editor": {
            "id": owner.id,
            "username": owner.username,
            "display_name": owner.display_name,
        },
    }


@pytest.fixture
def evidence_setup(tmp_path):
    # 모델 파일이나 원본 CSV를 만들지 않는다. 근거 연결은 저장된 결과만 읽어야 한다.
    database = Database(tmp_path / "evidence.sqlite3")

    database.create_tables()
    with database.session_factory() as session:
        owner = User(username="alice", display_name="검토 작성자", password_hash="test-only")

        other_owner = User(username="bob", display_name="다른 사용자", password_hash="test-only")

        session.add_all([owner, other_owner])
        session.flush()
        dataset = dataset_record("a" * 32, owner.id)

        foreign_dataset = dataset_record("b" * 32, other_owner.id)

        second_dataset = dataset_record("c" * 32, owner.id)

        session.add_all([dataset, foreign_dataset, second_dataset])
        session.flush()
        configuration = {
            "dataset_id": dataset.id,
            "feature_columns": ["sensor_01", "sensor_00"],
            "models": ["xgboost", "lightgbm", "autoencoder"],
            "train_end": "2026-01-01T00:03:00",
            "validation_end": "2026-01-01T00:07:00",
            "ranking_metric": "f1",
            "random_seed": 42,
        }

        report = {
            "models": [
                {
                    "model_key": key,
                    "display_name": name,
                    "parameters": {"random_state": 42, "nested": {"fixed": True}},
                    "validation_metrics": metrics(),
                    "training_seconds": 0.1,
                    "artifact_sha256": str(index + 2) * 64,
                    "warnings": [],
                }
                for index, (key, name) in enumerate(
                    [
                        ("xgboost", "XGBoost"),
                        ("lightgbm", "LightGBM"),
                        ("autoencoder", "AutoEncoder"),
                    ]
                )
            ],
            "split": {
                "train": {"start_row": 0, "end_row": 4, "row_count": 4},
                "validation": {"start_row": 4, "end_row": 8, "row_count": 4},
                "test": {"start_row": 8, "end_row": 12, "row_count": 4},
            },
            "environment": {"python": "test-version", "scikit_learn": "test-version"},
            "warnings": [],
        }

        model_run = ModelRun(
            id="d" * 32,
            owner_id=owner.id,
            dataset_id=dataset.id,
            status="completed",
            configuration=configuration,
            input_sha256=dataset.sha256,
            training_report=report,
            evaluation_status="not_started",
        )

        foreign_run = ModelRun(
            id="9" * 32,
            owner_id=other_owner.id,
            dataset_id=foreign_dataset.id,
            status="completed",
            configuration={**configuration, "dataset_id": foreign_dataset.id},
            input_sha256=foreign_dataset.sha256,
            training_report=deepcopy(report),
            evaluation_status="not_started",
        )

        session.add_all([model_run, foreign_run])
        session.flush()
        snapshot = observation_snapshot("e" * 32, owner, dataset.id, 2, "수정된 관찰")

        foreign_snapshot = observation_snapshot(
            "f" * 32, other_owner, foreign_dataset.id, 1, "비공개"
        )

        for item in (snapshot, foreign_snapshot):
            session.add(
                Observation(
                    id=item["id"],
                    owner_id=item["author"]["id"],
                    dataset_id=item["dataset_id"],
                    channel=item["channel"],
                    start_time=item["start_time"],
                    end_time=item["end_time"],
                    location=item["location"],
                    content=item["content"],
                    judgment=item["judgment"],
                    revision=item["revision"],
                    last_editor_id=item["last_editor"]["id"],
                    created_at=item["created_at"],
                    updated_at=item["updated_at"],
                )
            )
        session.flush()
        old_snapshot = observation_snapshot("e" * 32, owner, dataset.id, 1, "처음 본 관찰")

        for item in (old_snapshot, snapshot, foreign_snapshot):
            session.add(
                ObservationHistory(
                    observation_id=item["id"],
                    revision=item["revision"],
                    changed_by_id=item["last_editor"]["id"],
                    changed_at=item["updated_at"],
                    snapshot=deepcopy(item),
                )
            )
        session.commit()
        yield SimpleNamespace(
            session=session,
            owner=owner,
            other_owner=other_owner,
            dataset=dataset,
            second_dataset=second_dataset,
            foreign_dataset=foreign_dataset,
            model_run=model_run,
            foreign_run=foreign_run,
        )
    database.dispose()


def capture(setup, **changes):
    arguments = {
        "database_session": setup.session,
        "owner_id": setup.owner.id,
        "dataset": setup.dataset,
        "channel": "sensor_00",
        "start_time": "2026-01-01T00:05:00.000000",
        "end_time": "2026-01-01T00:06:00.000000",
        "model_reference": ModelResultReference(run_id=setup.model_run.id, model_key="xgboost"),
        "observation_references": [ObservationReference(observation_id="e" * 32, revision=1)],
    }

    arguments.update(changes)
    return capture_evidence(**arguments)


def assert_error(status_code, operation, code=None):
    with pytest.raises(HTTPException) as captured:
        operation()
    assert captured.value.status_code == status_code
    if code is not None:
        assert captured.value.detail["code"] == code


def test_capture_preserves_feature_order_full_partition_metrics_and_exact_observation(
    evidence_setup,
):
    setup = evidence_setup

    original_report = deepcopy(setup.model_run.training_report)

    evidence = capture(setup)

    assert evidence.model_result.model_key == "xgboost"
    assert evidence.model_result.feature_columns == ["sensor_01", "sensor_00"]
    assert evidence.model_result.metrics_scope == "full_partition"
    assert evidence.model_result.partition.row_count == 4
    assert evidence.model_result.partition_metrics.sample_count == 4
    assert evidence.model_result.partition_metrics.f1 == 1
    assert evidence.observations[0].revision == 1
    assert evidence.observations[0].content == "처음 본 관찰"
    assert setup.model_run.training_report == original_report
    assert setup.model_run.selected_model is None
    assert setup.model_run.evaluation_status == "not_started"


def test_capture_does_not_train_load_predict_or_start_evaluation(evidence_setup, monkeypatch):
    def reject_model_side_effect(*args, **kwargs):
        pytest.fail("검토 근거를 연결할 때 모델을 실행하면 안 됩니다.")

    monkeypatch.setattr(modeling, "train_models", reject_model_side_effect)
    monkeypatch.setattr(modeling, "evaluate_model", reject_model_side_effect)
    monkeypatch.setattr(modeling, "load_trained_model", reject_model_side_effect)
    monkeypatch.setattr(joblib, "load", reject_model_side_effect)
    assert capture(evidence_setup).model_result is not None


def test_capture_is_detached_from_later_nested_model_report_mutations(evidence_setup):
    evidence = capture(evidence_setup)

    evidence_setup.model_run.training_report["models"][0]["parameters"]["nested"]["fixed"] = False

    assert evidence.model_result.parameters["nested"]["fixed"] is True


def test_empty_in_progress_evidence_is_allowed(evidence_setup):
    evidence = capture(evidence_setup, model_reference=None, observation_references=[])

    assert evidence.model_result is None
    assert evidence.observations == []


def test_explicit_current_observation_revision_is_also_available(evidence_setup):
    evidence = capture(
        evidence_setup,
        model_reference=None,
        observation_references=[ObservationReference(observation_id="e" * 32, revision=2)],
    )

    assert evidence.observations[0].content == "수정된 관찰"
    assert evidence.observations[0].revision == 2


@pytest.mark.parametrize("run_id", ["9" * 32, "0" * 32])
def test_foreign_and_missing_runs_are_same_404(evidence_setup, run_id):
    assert_error(
        404,
        lambda: capture(
            evidence_setup,
            model_reference=ModelResultReference(run_id=run_id, model_key="xgboost"),
        ),
        "RUN_NOT_FOUND",
    )


def test_foreign_dataset_cannot_be_supplied_directly(evidence_setup):
    assert_error(404, lambda: capture(evidence_setup, dataset=evidence_setup.foreign_dataset))


@pytest.mark.parametrize("state", ["queued", "running", "failed"])
def test_unfinished_run_is_not_linked(evidence_setup, state):
    evidence_setup.model_run.status = state

    evidence_setup.session.commit()
    assert_error(409, lambda: capture(evidence_setup), "RUN_NOT_READY")


def test_run_must_use_same_dataset_and_input_hash(evidence_setup):
    evidence_setup.model_run.dataset_id = evidence_setup.second_dataset.id

    evidence_setup.session.commit()
    assert_error(422, lambda: capture(evidence_setup), "REVIEW_CONTEXT_MISMATCH")
    evidence_setup.model_run.dataset_id = evidence_setup.dataset.id

    evidence_setup.model_run.input_sha256 = "0" * 64

    evidence_setup.session.commit()
    assert_error(422, lambda: capture(evidence_setup), "REVIEW_SOURCE_MISMATCH")


def test_requested_model_must_have_been_trained(evidence_setup):
    assert_error(
        422,
        lambda: capture(
            evidence_setup,
            model_reference=ModelResultReference(
                run_id=evidence_setup.model_run.id, model_key="dummy"
            ),
        ),
        "MODEL_NOT_TRAINED",
    )


@pytest.mark.parametrize("model_key", ["xgboost", "lightgbm", "autoencoder", "dummy"])
def test_saved_model_variants_including_legacy_dummy_remain_readable(evidence_setup, model_key):
    if model_key == "dummy":
        configuration = deepcopy(evidence_setup.model_run.configuration)

        configuration["models"] = ["dummy"]

        report = deepcopy(evidence_setup.model_run.training_report)

        report["models"] = [{**report["models"][0], "model_key": "dummy", "display_name": "Dummy"}]

        evidence_setup.model_run.configuration = configuration

        evidence_setup.model_run.training_report = report

        evidence_setup.session.commit()
    evidence = capture(
        evidence_setup,
        model_reference=ModelResultReference(
            run_id=evidence_setup.model_run.id, model_key=model_key
        ),
    )

    assert evidence.model_result.model_key == model_key
    assert evidence.model_result.partition_metrics.f1 == 1


@pytest.mark.parametrize(
    ("start_time", "end_time"),
    [
        ("2026-01-01T00:03:00", "2026-01-01T00:05:00"),
        ("2026-01-01T00:05:00", "2026-01-01T00:08:00"),
    ],
)
def test_validation_review_must_stay_within_validation_period(evidence_setup, start_time, end_time):
    assert_error(
        422,
        lambda: capture(
            evidence_setup,
            start_time=start_time,
            end_time=end_time,
        ),
        "REVIEW_OUTSIDE_SPLIT",
    )


@pytest.mark.parametrize(
    ("evaluation_status", "selected_model"),
    [
        ("not_started", "xgboost"),
        ("queued", "xgboost"),
        ("running", "xgboost"),
        ("failed", "xgboost"),
        ("completed", "lightgbm"),
        ("completed", None),
    ],
)
def test_test_evidence_requires_completed_selected_model(
    evidence_setup, evaluation_status, selected_model
):
    evidence_setup.model_run.evaluation_status = evaluation_status

    evidence_setup.model_run.selected_model = selected_model

    evidence_setup.model_run.evaluation_report = metrics(all_normal=True)

    evidence_setup.session.commit()
    assert_error(
        409,
        lambda: capture(
            evidence_setup,
            model_reference=ModelResultReference(
                run_id=evidence_setup.model_run.id,
                model_key="xgboost",
                split="test",
            ),
            start_time="2026-01-01T00:08:00",
            end_time="2026-01-01T00:10:00",
            observation_references=[],
        ),
        "TEST_NOT_EVALUATED",
    )


def test_completed_test_captures_test_metrics_without_reusing_validation_metrics(evidence_setup):
    evidence_setup.model_run.evaluation_status = "completed"

    evidence_setup.model_run.selected_model = "xgboost"

    evidence_setup.model_run.evaluation_report = metrics(all_normal=True)

    evidence_setup.session.commit()
    reference = ModelResultReference(
        run_id=evidence_setup.model_run.id,
        model_key="xgboost",
        split="test",
    )

    evidence = capture(
        evidence_setup,
        model_reference=reference,
        start_time="2026-01-01T00:08:00",
        end_time="2026-01-01T00:10:00",
        observation_references=[],
    )

    assert evidence.model_result.partition.start_row == 8
    assert evidence.model_result.partition_metrics.f1 == 0
    assert evidence.model_result.split == "test"
    assert_error(
        422,
        lambda: capture(
            evidence_setup,
            model_reference=reference,
            start_time="2026-01-01T00:07:00",
            end_time="2026-01-01T00:10:00",
            observation_references=[],
        ),
        "REVIEW_OUTSIDE_SPLIT",
    )


def test_aware_model_boundaries_are_normalized_without_changing_the_period(evidence_setup):
    configuration = deepcopy(evidence_setup.model_run.configuration)

    configuration.update(
        train_end="2026-01-01T09:03:00+09:00",
        validation_end="2026-01-01T09:07:00+09:00",
    )
    evidence_setup.model_run.configuration = configuration

    evidence_setup.session.commit()
    evidence = capture(
        evidence_setup,
        start_time="2026-01-01T00:05:00+00:00",
        end_time="2026-01-01T00:06:00+00:00",
        observation_references=[],
    )

    assert evidence.model_result.train_end == "2026-01-01T00:03:00.000000+00:00"
    assert evidence.model_result.validation_end == "2026-01-01T00:07:00.000000+00:00"


@pytest.mark.parametrize(
    "damage",
    [
        "no_report",
        "bad_models",
        "bad_split",
        "count_mismatch",
        "bad_hash",
        "bad_environment",
        "duplicate_model",
        "nan_metric",
    ],
)
def test_malformed_stored_model_result_is_sanitized(evidence_setup, damage):
    report = deepcopy(evidence_setup.model_run.training_report)

    if damage == "no_report":
        report = None

    elif damage == "bad_models":
        report["models"] = {"private_path": "C:/private/model.joblib"}

    elif damage == "bad_split":
        report["split"]["test"]["start_row"] = 9

    elif damage == "count_mismatch":
        report["models"][0]["validation_metrics"]["sample_count"] = 3

    elif damage == "bad_hash":
        report["models"][0]["artifact_sha256"] = "C:/private/model.joblib"

    elif damage == "bad_environment":
        report["environment"] = ["C:/private/model.joblib"]

    elif damage == "duplicate_model":
        report["models"].append(deepcopy(report["models"][0]))
    else:
        report["models"][0]["validation_metrics"]["accuracy"] = float("nan")

    evidence_setup.model_run.training_report = report

    evidence_setup.session.commit()
    with pytest.raises(HTTPException) as captured:
        capture(evidence_setup)
    assert captured.value.status_code == 503
    assert "private" not in str(captured.value.detail)
    assert "model.joblib" not in str(captured.value.detail)


@pytest.mark.parametrize("observation_id", ["f" * 32, "0" * 32])
def test_foreign_and_missing_observations_are_same_404(evidence_setup, observation_id):
    assert_error(
        404,
        lambda: capture(
            evidence_setup,
            model_reference=None,
            observation_references=[
                ObservationReference(observation_id=observation_id, revision=1)
            ],
        ),
        "OBSERVATION_NOT_FOUND",
    )


def test_unknown_observation_revision_is_not_replaced_with_latest(evidence_setup):
    assert_error(
        422,
        lambda: capture(
            evidence_setup,
            model_reference=None,
            observation_references=[ObservationReference(observation_id="e" * 32, revision=99)],
        ),
        "OBSERVATION_REVISION_NOT_FOUND",
    )


def test_duplicate_observation_ids_are_rejected_even_when_revisions_differ(evidence_setup):
    assert_error(
        422,
        lambda: capture(
            evidence_setup,
            model_reference=None,
            observation_references=[
                ObservationReference(observation_id="e" * 32, revision=1),
                ObservationReference(observation_id="e" * 32, revision=2),
            ],
        ),
        "INVALID_REVIEW_EVIDENCE",
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"channel": "sensor_01"},
        {"dataset_id": "c" * 32},
        {"start_time": "2026-01-01T00:00:00", "end_time": "2026-01-01T00:01:00"},
    ],
)
def test_observation_context_must_match_and_overlap(evidence_setup, changes):
    history = evidence_setup.session.scalar(
        select(ObservationHistory).where(
            ObservationHistory.observation_id == "e" * 32,
            ObservationHistory.revision == 1,
        )
    )

    history.snapshot = {**history.snapshot, **changes}

    evidence_setup.session.commit()
    assert_error(
        422, lambda: capture(evidence_setup, model_reference=None), "REVIEW_CONTEXT_MISMATCH"
    )


def test_touching_observation_endpoint_counts_as_overlap(evidence_setup):
    evidence = capture(
        evidence_setup,
        model_reference=None,
        start_time="2026-01-01T00:06:00",
        end_time="2026-01-01T00:07:00",
    )

    assert len(evidence.observations) == 1


@pytest.mark.parametrize(
    "changes",
    [
        {"id": "0" * 32},
        {"revision": 99},
        {"start_time": "not-an-ISO-date"},
        {"author": {"id": 999, "username": "forged", "display_name": "위조"}},
    ],
)
def test_malformed_observation_snapshot_is_sanitized(evidence_setup, changes):
    history = evidence_setup.session.scalar(
        select(ObservationHistory).where(
            ObservationHistory.observation_id == "e" * 32,
            ObservationHistory.revision == 1,
        )
    )

    history.snapshot = {**history.snapshot, **changes}

    evidence_setup.session.commit()
    assert_error(503, lambda: capture(evidence_setup, model_reference=None))
