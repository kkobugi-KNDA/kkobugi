"""실제 학습 호출 전후의 단계, 실패 지점과 서버 재시작 뒤 기록을 확인한다."""

from threading import Event

from fastapi.testclient import TestClient
from test_runs import (
    create_run,
    login_user,
    upload_dataset,
    wait_for_training,
)
from xgboost import XGBClassifier

from app.main import create_app
from app.models import ModelRun

pytest_plugins = ["test_runs"]


def test_real_training_progress_is_visible_during_fit_and_survives_reload(run_client, monkeypatch):
    entered_fit = Event()

    release_fit = Event()

    original_fit = XGBClassifier.fit

    def blocked_fit(estimator, *args, **kwargs):
        entered_fit.set()
        if not release_fit.wait(10):
            raise ValueError("테스트 학습 대기 시간 초과")
        return original_fit(estimator, *args, **kwargs)

    monkeypatch.setattr(XGBClassifier, "fit", blocked_fit)
    dataset_id = upload_dataset(run_client)

    try:
        run_id = create_run(run_client, dataset_id, models=["xgboost"])

        assert entered_fit.wait(5)
        during_fit = run_client.get(f"/api/v1/runs/{run_id}").json()

        assert during_fit["run"]["status"] == "running"
        progress = during_fit["training_progress"]

        assert progress[-1]["stage"] == "training"
        assert progress[-1]["status"] == "running"
        assert progress[-1]["model_key"] == "xgboost"
        assert not any(
            event["stage"] in {"validation", "saving", "completed"} for event in progress
        )
        split_event = next(
            event
            for event in progress
            if event["stage"] == "split" and event["status"] == "completed"
        )

        assert "Train 30행" in split_event["message"]
        assert "Valid 15행" in split_event["message"]
        assert "Test 15행" in split_event["message"]
        assert "채널 2개" in split_event["message"]
    finally:
        release_fit.set()
    completed = wait_for_training(run_client, run_id)

    assert completed["run"]["status"] == "completed", completed
    progress = completed["training_progress"]

    completed_stages = [event["stage"] for event in progress if event["status"] == "completed"]

    assert completed_stages == [
        "data_check",
        "split",
        "input_preparation",
        "training",
        "validation",
        "saving",
        "saving",
        "completed",
    ]
    assert [event["timestamp"] for event in progress] == sorted(
        event["timestamp"] for event in progress
    )
    assert completed["run"]["evaluation_status"] == "not_started"
    # 같은 파일 DB를 새 앱에서 읽어도 당시 기록을 보며, 단계를 다시 실행하지 않는다.
    with TestClient(create_app(run_client.app.state.settings)) as restarted_client:
        login_user(restarted_client)
        reloaded = restarted_client.get(f"/api/v1/runs/{run_id}").json()

        assert reloaded["training_progress"] == progress


def test_failed_fit_reports_real_stage_without_later_completion(run_client, monkeypatch):
    def fail_fit(*args, **kwargs):
        raise ValueError("학습 입력을 확인하는 테스트 오류")

    monkeypatch.setattr(XGBClassifier, "fit", fail_fit)
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["xgboost"])

    failed = wait_for_training(run_client, run_id)

    assert failed["run"]["status"] == "failed"
    progress = failed["training_progress"]

    assert progress[-1]["stage"] == "training"
    assert progress[-1]["status"] == "failed"
    assert "테스트 오류" in progress[-1]["message"]
    assert not any(event["stage"] in {"validation", "saving", "completed"} for event in progress)


def test_legacy_run_without_progress_stays_empty_instead_of_inventing_history(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["xgboost"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    with run_client.app.state.database.session_factory() as database_session:
        model_run = database_session.get(ModelRun, run_id)

        report = dict(model_run.training_report)

        report.pop("training_progress")
        model_run.training_report = report

        database_session.commit()
    assert run_client.get(f"/api/v1/runs/{run_id}").json()["training_progress"] == []


def test_server_recovery_marks_only_the_recorded_active_stage_failed(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["xgboost"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    saved_event = {
        "stage": "training",
        "status": "running",
        "timestamp": 1,
        "message": "학습 중",
        "model_key": "xgboost",
    }

    with run_client.app.state.database.session_factory() as database_session:
        model_run = database_session.get(ModelRun, run_id)

        model_run.status = "running"

        model_run.training_report = {"training_progress": [saved_event]}

        database_session.commit()
    run_client.app.state.run_manager.recover_interrupted()
    recovered = run_client.get(f"/api/v1/runs/{run_id}").json()

    assert recovered["run"]["status"] == "failed"
    assert recovered["training_progress"][0] == saved_event
    assert recovered["training_progress"][-1]["stage"] == "training"
    assert recovered["training_progress"][-1]["status"] == "failed"
    assert len(recovered["training_progress"]) == 2
