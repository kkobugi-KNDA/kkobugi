"""임시 CSV로 모델 비교·사람 선택·시험 평가와 계정별 접근을 확인한다."""

import hashlib
import json
import time
from datetime import datetime, timedelta
from threading import Event

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.models import ModelRun, User
from app.security import hash_password

FRONTEND_ORIGIN = "http://localhost:5173"

WRITE_HEADERS = {"Origin": FRONTEND_ORIGIN, "X-Requested-With": "kkobugi-web"}

TEST_PASSWORD = "run-test-only-password!"


def prepared_csv(*, train_one_class=False, validation_one_class=False):
    """각 시간 구간에 두 라벨을 넣되 실패·미정의 지표 사례도 따로 만들 수 있다."""

    start_time = datetime(2026, 1, 1)

    csv_lines = ["timestamp,sensor_00,sensor_01,label"]

    for row_index in range(60):
        is_abnormal = row_index % 2 == 1

        if train_one_class and row_index < 30:
            is_abnormal = False

        if validation_one_class and 30 <= row_index < 45:
            is_abnormal = False

        timestamp = start_time + timedelta(minutes=row_index)

        label = "abnormal" if is_abnormal else "normal"

        sensor_value = 10.0 if is_abnormal else 0.0

        csv_lines.append(f"{timestamp.isoformat()},{sensor_value},{row_index / 10},{label}")
    return ("\n".join(csv_lines) + "\n").encode()


@pytest.fixture(scope="session")
def run_password_hash():
    return hash_password(TEST_PASSWORD)


@pytest.fixture
def run_settings(tmp_path):
    # 계정·업로드·모델 파일을 모두 테스트 전용 폴더로 분리한다.
    return Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
        cors_origins=[FRONTEND_ORIGIN],
    )


def seed_run_users(application, password_hash):
    with application.state.database.session_factory() as database_session:
        database_session.add_all(
            [
                User(
                    username="alice", display_name="테스트 사용자 하나", password_hash=password_hash
                ),
                User(username="bob", display_name="테스트 사용자 둘", password_hash=password_hash),
            ]
        )
        database_session.commit()


def login_user(test_client, username="alice"):
    response = test_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": TEST_PASSWORD},
        headers=WRITE_HEADERS,
    )

    assert response.status_code == 200
    return response.json()["user"]


@pytest.fixture
def run_client(run_settings, run_password_hash):
    application = create_app(run_settings)

    with TestClient(application) as test_client:
        seed_run_users(application, run_password_hash)
        login_user(test_client)
        yield test_client


def upload_dataset(test_client, csv_bytes=None, form_fields=None):
    response = test_client.post(
        "/api/v1/datasets",
        files={"file": ("prepared.csv", csv_bytes or prepared_csv(), "text/csv")},
        data=form_fields or {},
        headers=WRITE_HEADERS,
    )

    assert response.status_code == 201
    return response.json()["dataset"]["id"]


def run_request(dataset_id, **overrides):
    request = {
        "dataset_id": dataset_id,
        "feature_columns": ["sensor_00", "sensor_01"],
        "models": ["lightgbm", "xgboost", "autoencoder"],
        "train_end": "2026-01-01T00:29:00",
        "validation_end": "2026-01-01T00:44:00",
        "ranking_metric": "f1",
    }

    request.update(overrides)
    return request


def create_run(test_client, dataset_id, **overrides):
    response = test_client.post(
        "/api/v1/runs", json=run_request(dataset_id, **overrides), headers=WRITE_HEADERS
    )

    assert response.status_code == 202, response.text
    return response.json()["run"]["id"]


def wait_for_training(test_client, run_id):
    deadline = time.monotonic() + 20

    while time.monotonic() < deadline:
        response = test_client.get(f"/api/v1/runs/{run_id}")

        assert response.status_code == 200
        run_detail = response.json()

        if run_detail["run"]["status"] in {"completed", "failed"}:
            return run_detail
        time.sleep(0.02)
    pytest.fail("모델 실행이 제한 시간 안에 끝나지 않았습니다.")


def wait_for_evaluation(test_client, run_id):
    deadline = time.monotonic() + 20

    while time.monotonic() < deadline:
        response = test_client.get(f"/api/v1/runs/{run_id}/evaluation")

        assert response.status_code == 200
        evaluation = response.json()

        if evaluation["status"] in {"completed", "failed"}:
            return evaluation
        time.sleep(0.02)
    pytest.fail("시험 평가가 제한 시간 안에 끝나지 않았습니다.")


def assert_api_error(response, status_code):
    assert response.status_code == status_code, response.text
    assert response.json()["error"]["code"]
    assert response.json()["error"]["message"]


def assert_no_private_paths(response, settings):
    serialized_response = json.dumps(response.json(), ensure_ascii=False)

    for private_path in (
        settings.database_path,
        settings.dataset_storage_path,
        settings.model_storage_path,
    ):
        assert json.dumps(str(private_path))[1:-1] not in serialized_response
    assert TEST_PASSWORD not in serialized_response
    assert "password_hash" not in serialized_response
    assert "artifact_path" not in serialized_response


def test_every_model_and_run_endpoint_requires_login(run_client):
    run_client.cookies.clear()
    run_id = "a" * 32

    responses = [
        run_client.get("/api/v1/models"),
        run_client.post("/api/v1/runs", json=run_request(run_id), headers=WRITE_HEADERS),
        run_client.get("/api/v1/runs"),
        run_client.get(f"/api/v1/runs/{run_id}"),
        run_client.get(f"/api/v1/runs/{run_id}/results"),
        run_client.post(
            f"/api/v1/runs/{run_id}/selection",
            json={"model_key": "lightgbm"},
            headers=WRITE_HEADERS,
        ),
        run_client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS),
        run_client.get(f"/api/v1/runs/{run_id}/evaluation"),
    ]

    for response in responses:
        assert_api_error(response, 401)


def test_catalog_lists_available_models_without_starting_training(run_client):
    response = run_client.get("/api/v1/models")

    assert response.status_code == 200
    definitions = {model["key"]: model for model in response.json()["items"]}

    assert set(definitions) == {"lightgbm", "xgboost", "autoencoder"}
    assert definitions["lightgbm"]["kind"] == "classifier"
    assert all(model["display_name"] and model["parameters"] for model in definitions.values())
    assert run_client.get("/api/v1/runs").json()["total"] == 0


def test_comparison_uses_explicit_time_splits_and_never_auto_selects(run_client, run_settings):
    csv_bytes = prepared_csv()

    dataset_id = upload_dataset(run_client, csv_bytes)

    run_id = create_run(run_client, dataset_id)

    run_detail = wait_for_training(run_client, run_id)

    assert run_detail["run"]["status"] == "completed", run_detail
    assert run_detail["run"]["selected_model"] is None
    assert run_detail["run"]["evaluation_status"] == "not_started"
    assert run_detail["run"]["completed_models"] == 3
    assert run_detail["input_sha256"] == hashlib.sha256(csv_bytes).hexdigest()
    assert run_detail["split"] == {
        "train": {"start_row": 0, "end_row": 30, "row_count": 30},
        "validation": {"start_row": 30, "end_row": 45, "row_count": 15},
        "test": {"start_row": 45, "end_row": 60, "row_count": 15},
    }
    assert (
        "scikit_learn" in run_detail["environment"] or "scikit-learn" in run_detail["environment"]
    )
    results_response = run_client.get(f"/api/v1/runs/{run_id}/results")

    assert results_response.status_code == 200
    assert results_response.headers["cache-control"] == "no-store"
    results = results_response.json()

    assert results["metric"] == "f1"
    assert results["selected_model"] is None
    assert {item["model_key"] for item in results["items"]} == {
        "lightgbm",
        "xgboost",
        "autoencoder",
    }
    scores = [item["validation_metrics"]["f1"] for item in results["items"]]

    assert scores == sorted(scores, reverse=True)
    for model_result in results["items"]:
        metrics = model_result["validation_metrics"]

        assert metrics["sample_count"] == 15
        assert set(metrics["class_metrics"]) == {"normal", "abnormal"}
        assert sum(sum(row) for row in metrics["confusion_matrix"]) == 15
        assert len(model_result["artifact_sha256"]) == 64
        assert "test_metrics" not in model_result
    evaluation = run_client.get(f"/api/v1/runs/{run_id}/evaluation").json()

    assert evaluation["status"] == "not_started"
    assert evaluation["metrics"] is None
    assert run_client.get(f"/api/v1/datasets/{dataset_id}/file").content == csv_bytes
    assert_no_private_paths(results_response, run_settings)


def test_only_requested_models_and_features_are_trained(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["lightgbm"], feature_columns=["sensor_00"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    results = run_client.get(f"/api/v1/runs/{run_id}/results").json()

    assert [result["model_key"] for result in results["items"]] == ["lightgbm"]
    selection_response = run_client.post(
        f"/api/v1/runs/{run_id}/selection",
        json={"model_key": "autoencoder"},
        headers=WRITE_HEADERS,
    )

    assert_api_error(selection_response, 422)


def test_model_choice_and_test_evaluation_are_separate_actions(run_client, run_settings):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["lightgbm", "xgboost"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    assert_api_error(
        run_client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS), 409
    )
    selection_response = run_client.post(
        f"/api/v1/runs/{run_id}/selection",
        json={"model_key": "xgboost"},
        headers=WRITE_HEADERS,
    )

    assert selection_response.status_code == 200
    assert selection_response.json()["run"]["selected_model"] == "xgboost"
    assert selection_response.json()["run"]["evaluation_status"] == "not_started"
    evaluation_response = run_client.post(
        f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS
    )

    assert evaluation_response.status_code == 202
    assert evaluation_response.headers["cache-control"] == "no-store"
    evaluation = wait_for_evaluation(run_client, run_id)

    assert evaluation["status"] == "completed", evaluation
    assert evaluation["model_key"] == "xgboost"
    assert evaluation["metrics"]["sample_count"] == 15
    assert sum(sum(row) for row in evaluation["metrics"]["confusion_matrix"]) == 15
    repeated_response = run_client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS)

    assert repeated_response.status_code == 200
    assert repeated_response.json() == evaluation
    assert_api_error(
        run_client.post(
            f"/api/v1/runs/{run_id}/selection",
            json={"model_key": "lightgbm"},
            headers=WRITE_HEADERS,
        ),
        409,
    )
    # 시험 결과를 본 뒤에도 순위 응답에는 검증 지표만 남아 있어야 한다.
    results_response = run_client.get(f"/api/v1/runs/{run_id}/results")

    assert "test_metrics" not in results_response.text
    assert all(
        item["validation_metrics"]["sample_count"] == 15
        for item in results_response.json()["items"]
    )
    assert_no_private_paths(evaluation_response, run_settings)


@pytest.mark.parametrize(
    "overrides",
    [
        {"feature_columns": ["label"]},
        {"feature_columns": ["timestamp"]},
        {"feature_columns": ["not_a_channel"]},
        {"feature_columns": ["sensor_00", "sensor_00"]},
        {"feature_columns": []},
        {"models": []},
        {"models": ["lightgbm", "lightgbm"]},
        {"models": ["unknown_model"]},
        {"train_end": "2026-01-01T00:44:00", "validation_end": "2026-01-01T00:29:00"},
        {"validation_end": "2026-01-01T00:29:00"},
        {"train_end": "2026-01-01T00:29:00+09:00"},
        {"random_seed": -1},
        {"ranking_metric": "test_accuracy"},
        {"owner_id": 999},
    ],
)
def test_invalid_training_configuration_is_rejected(run_client, overrides):
    dataset_id = upload_dataset(run_client)

    response = run_client.post(
        "/api/v1/runs", json=run_request(dataset_id, **overrides), headers=WRITE_HEADERS
    )

    assert_api_error(response, 422)
    assert run_client.get("/api/v1/runs").json()["total"] == 0


@pytest.mark.parametrize(
    "missing_field", ["train_end", "validation_end", "feature_columns", "models"]
)
def test_split_boundaries_and_explicit_choices_have_no_automatic_default(run_client, missing_field):
    dataset_id = upload_dataset(run_client)

    request = run_request(dataset_id)

    request.pop(missing_field)
    response = run_client.post("/api/v1/runs", json=request, headers=WRITE_HEADERS)

    assert_api_error(response, 422)


def test_dataset_with_quality_errors_cannot_start_training(run_client):
    csv_bytes = prepared_csv().replace(b",10.0,", b",NaN,", 1)

    dataset_id = upload_dataset(run_client, csv_bytes)

    response = run_client.post("/api/v1/runs", json=run_request(dataset_id), headers=WRITE_HEADERS)

    assert_api_error(response, 422)
    assert run_client.get("/api/v1/runs").json()["total"] == 0


@pytest.mark.parametrize("model_key", ["xgboost", "lightgbm"])
def test_one_class_train_fails_without_publishing_comparison_or_test_metrics(run_client, model_key):
    dataset_id = upload_dataset(run_client, prepared_csv(train_one_class=True))

    run_id = create_run(run_client, dataset_id, models=[model_key])

    detail = wait_for_training(run_client, run_id)

    assert detail["run"]["status"] == "failed"
    assert detail["run"]["error_message"]
    assert detail["run"]["selected_model"] is None
    assert run_client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []
    assert run_client.get(f"/api/v1/runs/{run_id}/evaluation").json()["metrics"] is None


@pytest.mark.parametrize("model_key", ["autoencoder"])
def test_normal_only_train_is_allowed_for_normal_learning_model(run_client, model_key):
    # AE는 정상 학습, XGBoost는 정답 분류이므로 필요한 Train 라벨 조건이 다르다.
    dataset_id = upload_dataset(run_client, prepared_csv(train_one_class=True))

    run_id = create_run(run_client, dataset_id, models=[model_key])

    detail = wait_for_training(run_client, run_id)

    assert detail["run"]["status"] == "completed", detail
    assert [
        item["model_key"]
        for item in run_client.get(f"/api/v1/runs/{run_id}/results").json()["items"]
    ] == [model_key]


def test_custom_csv_column_names_and_label_mapping_are_used_in_training(run_client):
    csv_bytes = (
        prepared_csv()
        .replace(b"timestamp,sensor_00,sensor_01,label", b"event_time,sensor_00,sensor_01,state")
        .replace(b",abnormal\n", b",alert\n")
        .replace(b",normal\n", b",healthy\n")
    )

    dataset_id = upload_dataset(
        run_client,
        csv_bytes,
        {
            "timestamp_column": "event_time",
            "label_column": "state",
            "normal_label": "healthy",
            "abnormal_label": "alert",
        },
    )

    run_id = create_run(run_client, dataset_id, models=["lightgbm"])

    detail = wait_for_training(run_client, run_id)

    assert detail["run"]["status"] == "completed", detail
    metrics = run_client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0][
        "validation_metrics"
    ]

    assert metrics["class_metrics"]["normal"]["support"] == 8
    assert metrics["class_metrics"]["abnormal"]["support"] == 7
    assert run_client.get(f"/api/v1/datasets/{dataset_id}/file").content == csv_bytes


def test_one_class_validation_has_null_auc_and_no_fabricated_rank(run_client):
    dataset_id = upload_dataset(run_client, prepared_csv(validation_one_class=True))

    run_id = create_run(run_client, dataset_id, ranking_metric="roc_auc")

    detail = wait_for_training(run_client, run_id)

    assert detail["run"]["status"] == "completed", detail
    results = run_client.get(f"/api/v1/runs/{run_id}/results").json()

    assert all(result["validation_metrics"]["roc_auc"] is None for result in results["items"])
    assert all(
        result["rank"] is None and result["sort_value"] is None for result in results["items"]
    )
    assert all(result["validation_metrics"]["warnings"] for result in results["items"])


def test_foreign_account_cannot_read_select_or_evaluate_another_run(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["lightgbm"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    login_user(run_client, "bob")
    responses = [
        run_client.get(f"/api/v1/runs/{run_id}"),
        run_client.get(f"/api/v1/runs/{run_id}/results"),
        run_client.get(f"/api/v1/runs/{run_id}/evaluation"),
        run_client.post(
            f"/api/v1/runs/{run_id}/selection",
            json={"model_key": "lightgbm"},
            headers=WRITE_HEADERS,
        ),
        run_client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS),
    ]

    for response in responses:
        assert_api_error(response, 404)
    assert run_client.get("/api/v1/runs").json()["total"] == 0
    assert_api_error(
        run_client.post("/api/v1/runs", json=run_request(dataset_id), headers=WRITE_HEADERS), 404
    )


def test_history_pagination_and_validation_metric_sorting(run_client):
    dataset_id = upload_dataset(run_client)

    first_run_id = create_run(run_client, dataset_id)

    assert wait_for_training(run_client, first_run_id)["run"]["status"] == "completed"
    second_run_id = create_run(run_client, dataset_id, models=["lightgbm"])

    assert wait_for_training(run_client, second_run_id)["run"]["status"] == "completed"
    history = run_client.get("/api/v1/runs", params={"limit": 1}).json()

    next_page = run_client.get("/api/v1/runs", params={"limit": 1, "offset": 1}).json()

    assert history["total"] == 2
    assert history["limit"] == next_page["limit"] == 1
    assert len(history["items"]) == len(next_page["items"]) == 1
    assert {history["items"][0]["id"], next_page["items"][0]["id"]} == {first_run_id, second_run_id}
    sorted_results = run_client.get(
        f"/api/v1/runs/{first_run_id}/results", params={"sort_by": "precision"}
    ).json()

    sortable_scores = [
        item["sort_value"] for item in sorted_results["items"] if item["sort_value"] is not None
    ]

    assert sorted_results["metric"] == "precision"
    assert sortable_scores == sorted(sortable_scores, reverse=True)
    lightgbm_result = next(
        item for item in sorted_results["items"] if item["model_key"] == "lightgbm"
    )

    assert lightgbm_result["rank"] is None
    assert lightgbm_result["sort_value"] is None
    assert all(
        item["sort_value"] is None for item in sorted_results["items"][len(sortable_scores) :]
    )
    assert_api_error(run_client.get("/api/v1/runs?limit=101"), 422)
    assert_api_error(run_client.get("/api/v1/runs?offset=-1"), 422)
    assert_api_error(run_client.get(f"/api/v1/runs/{first_run_id}/results?sort_by=test_f1"), 422)


def test_run_changes_require_trusted_origin_and_request_header(run_client):
    dataset_id = upload_dataset(run_client)

    response = run_client.post("/api/v1/runs", json=run_request(dataset_id))

    assert_api_error(response, 403)
    assert run_client.get("/api/v1/runs").json()["total"] == 0


def test_queue_limit_keeps_http_responsive_and_does_not_publish_partial_metrics(
    run_settings, run_password_hash, monkeypatch
):
    from app.services import runs as run_service

    training_started = Event()

    release_training = Event()

    original_train_models = run_service.modeling.train_models

    def blocked_training(*arguments, **keyword_arguments):
        training_started.set()
        assert release_training.wait(timeout=10), "테스트 학습 대기가 해제되지 않았습니다."
        return original_train_models(*arguments, **keyword_arguments)

    monkeypatch.setattr(run_service.modeling, "train_models", blocked_training)
    limited_settings = run_settings.model_copy(update={"max_pending_runs": 1})

    with TestClient(create_app(limited_settings)) as test_client:
        seed_run_users(test_client.app, run_password_hash)
        login_user(test_client)
        dataset_id = upload_dataset(test_client)

        try:
            run_id = create_run(test_client, dataset_id, models=["lightgbm"])

            assert training_started.wait(timeout=3)
            queue_full_response = test_client.post(
                "/api/v1/runs",
                json=run_request(dataset_id, models=["lightgbm"]),
                headers=WRITE_HEADERS,
            )

            assert_api_error(queue_full_response, 429)
            request_started = time.monotonic()

            assert test_client.get("/api/v1/health").status_code == 200
            assert time.monotonic() - request_started < 1
            pending_results = test_client.get(f"/api/v1/runs/{run_id}/results").json()

            assert pending_results["status"] in {"queued", "running"}
            assert pending_results["items"] == []
            assert test_client.get("/api/v1/runs").json()["total"] == 1
            assert_api_error(
                test_client.post(
                    f"/api/v1/runs/{run_id}/selection",
                    json={"model_key": "lightgbm"},
                    headers=WRITE_HEADERS,
                ),
                409,
            )
        finally:
            # 테스트 assertion이 실패해도 종료 대기 중인 작업 스레드를 반드시 풀어준다.
            release_training.set()

        assert wait_for_training(test_client, run_id)["run"]["status"] == "completed"


def test_pending_test_evaluation_locks_selection_and_is_not_queued_twice(run_client, monkeypatch):
    from app.services import runs as run_service

    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["lightgbm", "xgboost"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    assert (
        run_client.post(
            f"/api/v1/runs/{run_id}/selection",
            json={"model_key": "lightgbm"},
            headers=WRITE_HEADERS,
        ).status_code
        == 200
    )
    evaluation_started = Event()

    release_evaluation = Event()

    evaluation_call_count = 0

    original_evaluate_model = run_service.modeling.evaluate_model

    def blocked_evaluation(*arguments, **keyword_arguments):
        nonlocal evaluation_call_count

        evaluation_call_count += 1

        evaluation_started.set()
        assert release_evaluation.wait(timeout=10), "테스트 평가 대기가 해제되지 않았습니다."
        return original_evaluate_model(*arguments, **keyword_arguments)

    monkeypatch.setattr(run_service.modeling, "evaluate_model", blocked_evaluation)
    try:
        first_response = run_client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS)

        assert first_response.status_code == 202
        assert evaluation_started.wait(timeout=3)
        repeated_response = run_client.post(
            f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS
        )

        assert repeated_response.status_code == 202
        assert repeated_response.json()["metrics"] is None
        assert_api_error(
            run_client.post(
                f"/api/v1/runs/{run_id}/selection",
                json={"model_key": "xgboost"},
                headers=WRITE_HEADERS,
            ),
            409,
        )
    finally:
        release_evaluation.set()

    assert wait_for_evaluation(run_client, run_id)["status"] == "completed"
    assert evaluation_call_count == 1


def test_completed_run_selected_model_and_evaluation_survive_server_restart(
    run_settings, run_password_hash
):
    first_application = create_app(run_settings)

    with TestClient(first_application) as first_client:
        seed_run_users(first_application, run_password_hash)
        login_user(first_client)
        csv_bytes = prepared_csv()

        dataset_id = upload_dataset(first_client, csv_bytes)

        run_id = create_run(first_client, dataset_id, models=["lightgbm"])

        first_detail = wait_for_training(first_client, run_id)

        assert first_detail["run"]["status"] == "completed"
        selection_response = first_client.post(
            f"/api/v1/runs/{run_id}/selection",
            json={"model_key": "lightgbm"},
            headers=WRITE_HEADERS,
        )

        assert selection_response.status_code == 200
        assert (
            first_client.post(
                f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS
            ).status_code
            == 202
        )
        first_evaluation = wait_for_evaluation(first_client, run_id)

        assert first_evaluation["status"] == "completed"
        first_results = first_client.get(f"/api/v1/runs/{run_id}/results").json()

        cookies = dict(first_client.cookies)

    with TestClient(create_app(run_settings)) as restarted_client:
        restarted_client.cookies.update(cookies)
        restarted_detail = restarted_client.get(f"/api/v1/runs/{run_id}").json()

        assert restarted_detail["run"]["status"] == "completed"
        assert restarted_detail["run"]["selected_model"] == "lightgbm"
        assert restarted_client.get(f"/api/v1/runs/{run_id}/results").json() == first_results
        assert restarted_client.get(f"/api/v1/runs/{run_id}/evaluation").json() == first_evaluation
        assert restarted_client.get(f"/api/v1/datasets/{dataset_id}/file").content == csv_bytes
        with restarted_client.app.state.database.session_factory() as database_session:
            assert len(database_session.scalars(select(User)).all()) == 2


def test_restart_marks_unfinished_work_failed_without_deleting_original_dataset(
    run_settings, run_password_hash
):
    first_application = create_app(run_settings)

    with TestClient(first_application) as first_client:
        seed_run_users(first_application, run_password_hash)
        owner_id = login_user(first_client)["id"]

        csv_bytes = prepared_csv()

        dataset_id = upload_dataset(first_client, csv_bytes)

        cookies = dict(first_client.cookies)

    database = Database(run_settings.database_path)

    try:
        with database.session_factory() as database_session:
            # 프로세스가 중간에 종료돼 DB에 running 상태만 남은 상황을 재현한다.
            database_session.add_all(
                [
                    ModelRun(
                        id="b" * 32,
                        owner_id=owner_id,
                        dataset_id=dataset_id,
                        status="running",
                        configuration=run_request(dataset_id, models=["lightgbm"]),
                        input_sha256=hashlib.sha256(csv_bytes).hexdigest(),
                    ),
                    ModelRun(
                        id="c" * 32,
                        owner_id=owner_id,
                        dataset_id=dataset_id,
                        status="completed",
                        configuration=run_request(dataset_id, models=["lightgbm"]),
                        input_sha256=hashlib.sha256(csv_bytes).hexdigest(),
                        selected_model="lightgbm",
                        evaluation_status="running",
                    ),
                ]
            )
            database_session.commit()
    finally:
        database.dispose()

    with TestClient(create_app(run_settings)) as restarted_client:
        restarted_client.cookies.update(cookies)
        interrupted_run = restarted_client.get("/api/v1/runs/" + "b" * 32).json()

        interrupted_evaluation = restarted_client.get(
            "/api/v1/runs/" + "c" * 32 + "/evaluation"
        ).json()

        assert interrupted_run["run"]["status"] == "failed"
        assert interrupted_run["run"]["error_message"]
        assert interrupted_evaluation["status"] == "failed"
        assert interrupted_evaluation["error_message"]
        assert interrupted_evaluation["metrics"] is None
        assert restarted_client.get(f"/api/v1/datasets/{dataset_id}/file").content == csv_bytes


def test_training_row_limit_is_checked_before_queue_registration(run_settings, run_password_hash):
    limited_settings = run_settings.model_copy(update={"max_training_rows": 59})

    with TestClient(create_app(limited_settings)) as test_client:
        seed_run_users(test_client.app, run_password_hash)
        login_user(test_client)
        dataset_id = upload_dataset(test_client)

        response = test_client.post(
            "/api/v1/runs", json=run_request(dataset_id), headers=WRITE_HEADERS
        )

        assert_api_error(response, 413)
        assert test_client.get("/api/v1/runs").json()["total"] == 0


def test_run_endpoints_are_documented_with_json_and_common_errors(run_client):
    schema = run_client.get("/openapi.json").json()

    paths = schema["paths"]

    assert "/api/v1/models" in paths
    assert {"post", "get"} <= paths["/api/v1/runs"].keys()
    assert "202" in paths["/api/v1/runs"]["post"]["responses"]
    assert "application/json" in paths["/api/v1/runs"]["post"]["requestBody"]["content"]
    assert "post" in paths["/api/v1/runs/{run_id}/selection"]
    assert {"post", "get"} <= paths["/api/v1/runs/{run_id}/evaluation"].keys()
    run_schema = schema["components"]["schemas"]["NewRunCreate"]

    assert {"dataset_id", "feature_columns", "models", "train_end", "validation_end"} <= set(
        run_schema["required"]
    )
    assert run_schema["additionalProperties"] is False
    assert paths["/api/v1/runs"]["post"]["responses"]["422"]["content"]["application/json"][
        "schema"
    ]["$ref"].endswith("/ErrorResponse")


def test_retired_dummy_cannot_create_new_training_or_queue_record(run_client):
    dataset_id = upload_dataset(run_client)

    response = run_client.post(
        "/api/v1/runs",
        json=run_request(dataset_id, models=["dummy"]),
        headers=WRITE_HEADERS,
    )

    assert_api_error(response, 422)
    assert run_client.get("/api/v1/runs").json()["total"] == 0


def test_old_dummy_run_configuration_and_results_remain_readable(run_client):
    dataset_id = upload_dataset(run_client)

    owner_id = run_client.get("/api/v1/auth/me").json()["user"]["id"]

    old_run_id = "d" * 32

    # 기존 DB에 남은 실행은 새 모델 선택 목록과 무관하게 원래 키로 읽는다.
    with run_client.app.state.database.session_factory() as database_session:
        database_session.add(
            ModelRun(
                id=old_run_id,
                owner_id=owner_id,
                dataset_id=dataset_id,
                status="completed",
                configuration=run_request(dataset_id, models=["dummy"]),
                input_sha256=hashlib.sha256(prepared_csv()).hexdigest(),
                selected_model="dummy",
            )
        )
        database_session.commit()
    detail = run_client.get(f"/api/v1/runs/{old_run_id}")

    assert detail.status_code == 200
    assert detail.json()["configuration"]["models"] == ["dummy"]
    assert detail.json()["run"]["selected_model"] == "dummy"
    assert run_client.get(f"/api/v1/runs/{old_run_id}/evaluation").json()["model_key"] == "dummy"
