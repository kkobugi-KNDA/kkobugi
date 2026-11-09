"""실행 상태·대기열·선택 잠금·실패 정리와 기존 자료 보존을 확인한다."""

import hashlib
import threading
import time
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database
from app.models import Dataset, ModelRun, User
from app.schemas.runs import EvaluationMetrics, RunCreate
from app.services import datasets as dataset_service
from app.services import runs as run_service

CSV_BYTES = (
    b"timestamp,sensor_00,label\n"
    b"2018-01-01 00:00:00,0,normal\n"
    b"2018-01-01 00:01:00,1,abnormal\n"
    b"2018-01-01 00:02:00,0,normal\n"
    b"2018-01-01 00:03:00,1,abnormal\n"
    b"2018-01-01 00:04:00,0,normal\n"
    b"2018-01-01 00:05:00,1,abnormal\n"
    b"2018-01-01 00:06:00,0,normal\n"
    b"2018-01-01 00:07:00,1,abnormal\n"
)


def sample_metrics():
    return EvaluationMetrics(
        accuracy=1.0,
        precision=1.0,
        recall=1.0,
        f1=1.0,
        balanced_accuracy=1.0,
        roc_auc=1.0,
        average_precision=1.0,
        confusion_matrix=[[1, 0], [0, 1]],
        class_metrics={
            "normal": {"precision": 1.0, "recall": 1.0, "f1": 1.0, "support": 1},
            "abnormal": {"precision": 1.0, "recall": 1.0, "f1": 1.0, "support": 1},
        },
        sample_count=2,
        warnings=[],
    )


def fake_training(file_path, configuration, *, artifact_directory, **_):
    # 저장 계층 테스트에서는 짧은 가짜 결과로 작업 순서와 원본 보존만 확인한다.
    assert file_path.read_bytes() == CSV_BYTES
    model_results = []

    for model_key in configuration.models:
        artifact_path = artifact_directory / f"{model_key}.joblib"

        artifact_path.write_bytes(b"test-only-model-artifact")
        model_results.append(
            {
                "model_key": model_key,
                "display_name": model_key,
                "parameters": {},
                "validation_metrics": sample_metrics().model_dump(),
                "training_seconds": 0.01,
                "artifact_sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
                "warnings": [],
            }
        )
    (artifact_directory / "metadata.json").write_text("{}", encoding="utf-8")
    return {
        "split": {
            "train": {"start_row": 0, "end_row": 4, "row_count": 4},
            "validation": {"start_row": 4, "end_row": 6, "row_count": 2},
            "test": {"start_row": 6, "end_row": 8, "row_count": 2},
        },
        "models": model_results,
        "environment": {"test": "storage-only"},
        "warnings": [],
    }


@pytest.fixture
def run_setup(tmp_path, monkeypatch):
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
        max_pending_runs=1,
    )

    database = Database(settings.database_path)

    database.create_tables()
    with database.session_factory() as database_session:
        current_user = User(
            username="alice", display_name="테스트 사용자", password_hash="test-hash"
        )

        database_session.add(current_user)
        database_session.commit()
        stored_dataset, _ = dataset_service.upload_dataset(
            database_session,
            UploadFile(file=BytesIO(CSV_BYTES), filename="prepared.csv"),
            current_user,
            settings,
        )

    configuration = RunCreate(
        dataset_id=stored_dataset.id,
        feature_columns=["sensor_00"],
        models=["dummy", "xgboost"],
        train_end="2018-01-01T00:03:00",
        validation_end="2018-01-01T00:05:00",
    )

    manager = run_service.RunManager(database, settings)

    monkeypatch.setattr(run_service.modeling, "train_models", fake_training)
    monkeypatch.setattr(
        run_service.modeling, "evaluate_model", lambda *args, **kwargs: sample_metrics()
    )
    yield database, settings, current_user, stored_dataset, configuration, manager
    manager.shutdown()
    database.dispose()


def create_run(run_setup):
    database, _, current_user, _, configuration, manager = run_setup

    with database.session_factory() as database_session:
        return manager.create_run(database_session, current_user, configuration).run.id


def wait_for_status(database, run_id, expected_status, *, evaluation=False):
    for _ in range(500):
        with database.session_factory() as database_session:
            model_run = database_session.get(ModelRun, run_id)

            status = model_run.evaluation_status if evaluation else model_run.status

            if status == expected_status:
                return model_run
            if status == "failed" and expected_status != "failed":
                pytest.fail(model_run.evaluation_error if evaluation else model_run.error_message)
        time.sleep(0.01)
    pytest.fail("작업이 제한 시간 안에 예상 상태가 되지 않았습니다.")


def assert_original_dataset(run_setup):
    database, settings, current_user, stored_dataset, _, _ = run_setup

    assert (settings.dataset_storage_path / f"{stored_dataset.id}.csv").read_bytes() == CSV_BYTES
    with database.session_factory() as database_session:
        assert database_session.get(User, current_user.id).username == "alice"
        assert (
            database_session.get(Dataset, stored_dataset.id).sha256
            == hashlib.sha256(CSV_BYTES).hexdigest()
        )


def test_completed_run_and_artifacts_survive_reopen(run_setup):
    database, settings, current_user, _, _, manager = run_setup

    run_id = create_run(run_setup)

    wait_for_status(database, run_id, "completed")
    manager.shutdown()
    reopened_database = Database(settings.database_path)

    restarted_manager = run_service.RunManager(reopened_database, settings)

    try:
        restarted_manager.recover_interrupted()
        with reopened_database.session_factory() as database_session:
            restored_run = run_service.get_run(database_session, run_id, current_user.id)

            assert restored_run.status == "completed"
            assert run_service.run_detail(restored_run).split.train.row_count == 4
            assert len(run_service.get_results(restored_run).items) == 2
        assert (settings.model_storage_path / run_id / "dummy.joblib").is_file()
        assert_original_dataset(run_setup)
    finally:
        restarted_manager.shutdown()
        reopened_database.dispose()


def test_closed_manager_does_not_create_queued_record(run_setup):
    database, _, _, _, _, manager = run_setup

    manager.shutdown()
    with pytest.raises(HTTPException) as error:
        create_run(run_setup)
    assert error.value.status_code == 503
    with database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(ModelRun)) == 0


def test_submit_failure_records_failed_run_and_keeps_source(run_setup, monkeypatch):
    database, _, _, _, _, manager = run_setup

    def reject_submission(*args, **kwargs):
        raise RuntimeError("test-only-shutdown")

    monkeypatch.setattr(manager._executor, "submit", reject_submission)
    with pytest.raises(HTTPException) as error:
        create_run(run_setup)
    assert error.value.status_code == 503
    with database.session_factory() as database_session:
        model_run = database_session.scalar(select(ModelRun))

        assert model_run.status == "failed"
        assert "test-only-shutdown" not in model_run.error_message
    assert_original_dataset(run_setup)


@pytest.mark.parametrize(
    "exception", [ValueError("분할 설정을 확인하세요."), RuntimeError("private-path")]
)
def test_training_failure_cleans_only_new_artifacts(run_setup, monkeypatch, exception):
    database, settings, _, _, _, _ = run_setup

    def fail_after_partial_write(*args, artifact_directory, **kwargs):
        (artifact_directory / "dummy.joblib").write_bytes(b"partial")
        (artifact_directory / "metadata.json").write_text("{}", encoding="utf-8")
        raise exception

    monkeypatch.setattr(run_service.modeling, "train_models", fail_after_partial_write)
    run_id = create_run(run_setup)

    failed_run = wait_for_status(database, run_id, "failed")

    # 상태 저장과 finally 파일 정리가 순서대로 끝날 때까지 짧게 기다린다.
    for _ in range(100):
        if not (settings.model_storage_path / run_id).exists():
            break
        time.sleep(0.01)
    assert not (settings.model_storage_path / run_id).exists()
    assert "private-path" not in failed_run.error_message
    assert_original_dataset(run_setup)


def test_training_report_commit_failure_removes_uncommitted_artifacts(run_setup, monkeypatch):
    database, settings, _, _, _, _ = run_setup

    real_commit = Session.commit

    def fail_completed_report(database_session):
        if any(
            isinstance(item, ModelRun) and item.status == "completed"
            for item in database_session.dirty
        ):
            raise SQLAlchemyError("private-sql-parameters")
        return real_commit(database_session)

    monkeypatch.setattr(Session, "commit", fail_completed_report)
    run_id = create_run(run_setup)

    failed_run = wait_for_status(database, run_id, "failed")

    for _ in range(100):
        if not (settings.model_storage_path / run_id).exists():
            break
        time.sleep(0.01)
    assert not (settings.model_storage_path / run_id).exists()
    assert "private-sql-parameters" not in failed_run.error_message
    assert_original_dataset(run_setup)


def test_queue_limit_rejects_without_creating_another_run(run_setup, monkeypatch):
    database, _, _, _, _, _ = run_setup

    training_started = threading.Event()

    release_training = threading.Event()

    def blocked_training(*args, **kwargs):
        training_started.set()
        release_training.wait(timeout=5)
        return fake_training(*args, **kwargs)

    monkeypatch.setattr(run_service.modeling, "train_models", blocked_training)
    run_id = create_run(run_setup)

    try:
        assert training_started.wait(timeout=5)
        with pytest.raises(HTTPException) as error:
            create_run(run_setup)
        assert error.value.status_code == 429
        with database.session_factory() as database_session:
            assert database_session.scalar(select(func.count()).select_from(ModelRun)) == 1
    finally:
        release_training.set()
    wait_for_status(database, run_id, "completed")


def test_evaluation_is_single_job_and_locks_model_choice(run_setup, monkeypatch):
    database, _, current_user, _, _, manager = run_setup

    run_id = create_run(run_setup)

    wait_for_status(database, run_id, "completed")
    evaluation_started = threading.Event()

    release_evaluation = threading.Event()

    evaluation_calls = []

    def blocked_evaluation(*args, **kwargs):
        evaluation_calls.append(kwargs["model_key"])
        evaluation_started.set()
        release_evaluation.wait(timeout=5)
        return sample_metrics()

    monkeypatch.setattr(run_service.modeling, "evaluate_model", blocked_evaluation)
    try:
        with database.session_factory() as database_session:
            manager.select_model(database_session, run_id, current_user.id, "dummy")
            _, first_pending = manager.start_evaluation(database_session, current_user, run_id)

            assert first_pending
        assert evaluation_started.wait(timeout=5)
        with database.session_factory() as database_session:
            _, duplicate_pending = manager.start_evaluation(database_session, current_user, run_id)

            assert duplicate_pending
            with pytest.raises(HTTPException) as error:
                manager.select_model(database_session, run_id, current_user.id, "xgboost")
            assert error.value.status_code == 409
    finally:
        release_evaluation.set()
    wait_for_status(database, run_id, "completed", evaluation=True)
    with database.session_factory() as database_session:
        saved_result, is_pending = manager.start_evaluation(database_session, current_user, run_id)

        assert not is_pending
        assert saved_result.metrics.accuracy == 1.0
    assert evaluation_calls == ["dummy"]
    assert_original_dataset(run_setup)


def test_failed_evaluation_preserves_models_and_selection_lock(run_setup, monkeypatch):
    database, settings, current_user, _, _, manager = run_setup

    run_id = create_run(run_setup)

    wait_for_status(database, run_id, "completed")
    model_path = settings.model_storage_path / run_id / "dummy.joblib"

    original_model_bytes = model_path.read_bytes()

    def failed_evaluation(*args, **kwargs):
        raise ValueError("원본 식별값이 다릅니다.")

    monkeypatch.setattr(run_service.modeling, "evaluate_model", failed_evaluation)
    with database.session_factory() as database_session:
        manager.select_model(database_session, run_id, current_user.id, "dummy")
        manager.start_evaluation(database_session, current_user, run_id)
    failed_run = wait_for_status(database, run_id, "failed", evaluation=True)

    assert failed_run.status == "completed"
    assert model_path.read_bytes() == original_model_bytes
    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as error:
            manager.select_model(database_session, run_id, current_user.id, "xgboost")
        assert error.value.status_code == 409


def test_restart_marks_only_unfinished_states_failed(run_setup):
    database, _, current_user, stored_dataset, configuration, manager = run_setup

    with database.session_factory() as database_session:
        for run_id, training_status, evaluation_status in (
            ("a" * 32, "queued", "not_started"),
            ("b" * 32, "running", "not_started"),
            ("c" * 32, "completed", "running"),
            ("d" * 32, "completed", "completed"),
        ):
            database_session.add(
                ModelRun(
                    id=run_id,
                    owner_id=current_user.id,
                    dataset_id=stored_dataset.id,
                    status=training_status,
                    configuration=configuration.model_dump(mode="json"),
                    input_sha256=stored_dataset.sha256,
                    evaluation_status=evaluation_status,
                    evaluation_report=sample_metrics().model_dump()
                    if evaluation_status == "completed"
                    else None,
                )
            )
        database_session.commit()
    manager.recover_interrupted()
    with database.session_factory() as database_session:
        assert database_session.get(ModelRun, "a" * 32).status == "failed"
        assert database_session.get(ModelRun, "b" * 32).status == "failed"
        assert database_session.get(ModelRun, "c" * 32).evaluation_status == "failed"
        assert database_session.get(ModelRun, "d" * 32).evaluation_status == "completed"
        assert database_session.get(ModelRun, "d" * 32).evaluation_report["accuracy"] == 1.0


def test_existing_run_directory_is_never_removed_or_overwritten(run_setup, monkeypatch):
    database, settings, _, _, _, _ = run_setup

    fixed_run_id = "e" * 32

    existing_directory = settings.model_storage_path / fixed_run_id

    existing_directory.mkdir(parents=True)
    existing_file = existing_directory / "dummy.joblib"

    existing_file.write_bytes(b"previous-run-model")
    monkeypatch.setattr(run_service, "uuid4", lambda: SimpleNamespace(hex=fixed_run_id))
    run_id = create_run(run_setup)

    wait_for_status(database, run_id, "failed")
    assert existing_file.read_bytes() == b"previous-run-model"
    assert_original_dataset(run_setup)


def test_foreign_run_and_missing_run_have_the_same_error(run_setup):
    database, _, current_user, _, _, _ = run_setup

    run_id = create_run(run_setup)

    wait_for_status(database, run_id, "completed")
    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as foreign:
            run_service.get_run(database_session, run_id, current_user.id + 1)
        with pytest.raises(HTTPException) as missing:
            run_service.get_run(database_session, "f" * 32, current_user.id)
        assert foreign.value.status_code == missing.value.status_code == 404
        assert foreign.value.detail == missing.value.detail
