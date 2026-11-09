"""공유 시간축·원본 보존·관측 공백·Test 격리와 모델 예측 조회를 확인한다."""

import hashlib
import json
import time
from datetime import UTC, datetime, timedelta

import joblib
import numpy as np
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.main import create_app
from app.models import Dataset, ModelRun, User
from app.security import hash_password
from app.services import modeling, series

WRITE_HEADERS = {"Origin": "http://localhost:5173", "X-Requested-With": "kkobugi-web"}

PASSWORD = "series-test-password!"


def source_csv(count=180, *, aware=False, gap_at=None):
    start_time = datetime(2026, 11, 9, tzinfo=UTC) if aware else datetime(2026, 11, 9)

    lines = ["timestamp,sensor_a,sensor_b,label"]

    for row in range(count):
        timestamp = start_time + timedelta(
            minutes=row + (60 if gap_at is not None and row >= gap_at else 0)
        )

        label = "abnormal" if row % 5 in {1, 2} else "normal"

        value = 10.0 if label == "abnormal" else 0.0

        lines.append(f"{timestamp.isoformat()},{value},{row / 10},{label}")
    return ("\n".join(lines) + "\n").encode()


@pytest.fixture(scope="session")
def series_password_hash():
    return hash_password(PASSWORD)


@pytest.fixture
def series_client(tmp_path, series_password_hash):
    settings = Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
    )

    application = create_app(settings)

    with TestClient(application) as client:
        with application.state.database.session_factory() as database_session:
            database_session.add_all(
                [
                    User(
                        username="alice", display_name="작성자", password_hash=series_password_hash
                    ),
                    User(
                        username="bob",
                        display_name="다른 사용자",
                        password_hash=series_password_hash,
                    ),
                ]
            )
            database_session.commit()
        login(client)
        yield client


def login(client, username="alice"):
    response = client.post(
        "/api/v1/auth/login",
        headers=WRITE_HEADERS,
        json={"username": username, "password": PASSWORD},
    )

    assert response.status_code == 200


def upload(client, csv_bytes=None):
    response = client.post(
        "/api/v1/datasets",
        files={"file": ("prepared.csv", csv_bytes or source_csv(), "text/csv")},
        headers=WRITE_HEADERS,
    )

    assert response.status_code == 201, response.text
    return response.json()["dataset"]["id"]


def trained_run(client, dataset_id, models=None):
    response = client.post(
        "/api/v1/runs",
        headers=WRITE_HEADERS,
        json={
            "dataset_id": dataset_id,
            "feature_columns": ["sensor_b", "sensor_a"],
            "models": models or ["xgboost", "lightgbm", "autoencoder"],
            "train_end": "2026-11-09T01:29:00",
            "validation_end": "2026-11-09T02:14:00",
        },
    )

    assert response.status_code == 202, response.text
    run_id = response.json()["run"]["id"]

    deadline = time.monotonic() + 20

    while time.monotonic() < deadline:
        detail = client.get(f"/api/v1/runs/{run_id}").json()

        if detail["run"]["status"] in {"completed", "failed"}:
            assert detail["run"]["status"] == "completed", detail
            return run_id
        time.sleep(0.01)
    raise AssertionError("학습 완료 시간 초과")


def finish_evaluation(client, run_id, model_key):
    response = client.post(
        f"/api/v1/runs/{run_id}/selection", json={"model_key": model_key}, headers=WRITE_HEADERS
    )

    assert response.status_code == 200
    assert (
        client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS).status_code == 202
    )
    deadline = time.monotonic() + 20

    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}/evaluation")

        if response.json()["status"] in {"completed", "failed"}:
            assert response.json()["status"] == "completed", response.text
            return
        time.sleep(0.01)
    raise AssertionError("시험 평가 완료 시간 초과")


def test_graph_uses_real_rows_shared_channels_and_closed_time_bounds(series_client):
    dataset_id = upload(series_client)

    response = series_client.get(
        f"/api/v1/datasets/{dataset_id}/series",
        params=[
            ("channels", "sensor_b"),
            ("channels", "sensor_a"),
            ("start_time", "2026-11-09T00:01:00"),
            ("end_time", "2026-11-09T00:03:00"),
        ],
    )

    assert response.status_code == 200, response.text
    graph = response.json()

    assert graph["matched_count"] == graph["returned_count"] == 3
    assert graph["sampling_method"] == "none"
    assert graph["timezone_mode"] == "naive"
    assert [point["row_index"] for point in graph["points"]] == [1, 2, 3]
    assert graph["points"][0] == {
        "row_index": 1,
        "timestamp": "2026-11-09T00:01:00.000000",
        "values": {"sensor_b": 0.1, "sensor_a": 10.0},
        "actual_label": "abnormal",
        "actual_code": 1,
    }
    assert response.headers["cache-control"] == "no-store"


def test_minmax_sampling_preserves_each_channel_extrema_without_averaging():
    values = np.zeros((1000, 2))

    values[12, 0] = 999

    values[123, 0] = -888

    values[456, 1] = 777

    values[789, 1] = -666

    selected = series._sample_rows(values, 0, len(values), 64)

    assert len(selected) <= 64
    assert selected == sorted(set(selected))
    assert {0, 999, 12, 123, 456, 789} <= set(selected)
    assert selected == series._sample_rows(values, 0, len(values), 64)


def test_large_graph_is_bounded_and_labels_remain_independent(series_client):
    dataset_id = upload(series_client, source_csv(3000))

    graph = series_client.get(
        f"/api/v1/datasets/{dataset_id}/series",
        params=[("channels", "sensor_a"), ("channels", "sensor_b"), ("max_points", "64")],
    ).json()

    intervals = series_client.get(f"/api/v1/datasets/{dataset_id}/label-intervals").json()

    assert graph["matched_count"] == 3000
    assert graph["returned_count"] <= 64
    assert graph["downsampled"] is True
    assert graph["sampling_method"] == "min_max"
    assert graph["points"][0]["row_index"] == 0
    assert graph["points"][-1]["row_index"] == 2999
    assert intervals["total"] == 600
    assert intervals["cadence_seconds"] == 60
    assert intervals["items"][0]["start_row"] == 1
    assert intervals["items"][0]["end_row"] == 3
    assert intervals["items"][0]["row_count"] == 2


@pytest.mark.parametrize(
    "query",
    [
        [],
        [("channels", "sensor_a"), ("channels", "sensor_a")],
        [("channels", "missing")],
        [("channels", "timestamp")],
        [("channels", "sensor_a"), ("max_points", "63")],
        [("channels", "sensor_a"), ("max_points", "10001")],
        [("channels", "sensor_a"), ("start_time", "1234")],
        [("channels", "sensor_a"), ("start_time", "2026-11-09T01:00:00+00:00")],
        [("channels", "sensor_a"), ("start_time", "2026-11-10"), ("end_time", "2026-11-09")],
    ],
)
def test_invalid_graph_query_is_rejected(series_client, query):
    dataset_id = upload(series_client)

    assert (
        series_client.get(f"/api/v1/datasets/{dataset_id}/series", params=query).status_code == 422
    )


def test_aware_query_normalizes_same_instants_without_fabricating_timezone(series_client):
    dataset_id = upload(series_client, source_csv(aware=True))

    response = series_client.get(
        f"/api/v1/datasets/{dataset_id}/series",
        params={
            "channels": "sensor_a",
            "start_time": "2026-11-09T09:01:00+09:00",
            "end_time": "2026-11-09T09:02:00+09:00",
        },
    )

    assert response.status_code == 200
    assert [point["row_index"] for point in response.json()["points"]] == [1, 2]
    assert response.json()["start_time"] == "2026-11-09T00:01:00.000000+00:00"
    assert (
        series_client.get(
            f"/api/v1/datasets/{dataset_id}/series",
            params={"channels": "sensor_a", "start_time": "2026-11-09T00:00:00"},
        ).status_code
        == 422
    )


def test_empty_graph_range_returns_no_invented_endpoints(series_client):
    dataset_id = upload(series_client)

    response = series_client.get(
        f"/api/v1/datasets/{dataset_id}/series",
        params={"channels": "sensor_a", "start_time": "2026-11-10T00:00:00"},
    )

    assert response.status_code == 200
    assert response.json()["points"] == []
    assert response.json()["start_time"] is response.json()["end_time"] is None
    assert response.json()["matched_count"] == 0


@pytest.mark.parametrize("boundary", ["0001-01-01T00:00:00+09:00", "9999-12-31T23:59:59-09:00"])
def test_aware_query_overflow_returns_422_for_graph_and_label_intervals(series_client, boundary):
    dataset_id = upload(series_client, source_csv(aware=True))

    for suffix in ("series", "label-intervals"):
        response = series_client.get(
            f"/api/v1/datasets/{dataset_id}/{suffix}",
            params={"channels": "sensor_a", "start_time": boundary},
        )

        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "INVALID_TIME_RANGE"


def test_label_intervals_break_at_unobserved_time_gap_and_paginate(series_client):
    csv_bytes = source_csv(10, gap_at=2).replace(b",normal\n", b",abnormal\n")

    dataset_id = upload(series_client, csv_bytes)

    response = series_client.get(
        f"/api/v1/datasets/{dataset_id}/label-intervals",
        params={"code": 1, "limit": 1, "offset": 1},
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 2
    assert response.json()["items"][0]["start_row"] == 2
    assert response.json()["items"][0]["end_row"] == 10
    assert response.json()["items"][0]["row_count"] == 8
    normal = series_client.get(f"/api/v1/datasets/{dataset_id}/label-intervals", params={"code": 0})

    assert normal.status_code == 200
    assert normal.json()["total"] == 0


def test_unestablished_cadence_keeps_single_observations_separate():
    timestamps = [datetime(2026, 1, 1) + timedelta(seconds=value) for value in (0, 10, 30)]

    intervals, cadence = series._intervals(timestamps, [0, 1, 2], np.array([1, 1, 1]), 1)

    assert cadence is None
    assert [interval.row_count for interval in intervals] == [1, 1, 1]
    assert intervals[0].start_time == intervals[0].end_time
    assert intervals[0].start_row + 1 == intervals[0].end_row


@pytest.mark.parametrize("suffix", ["series?channels=sensor_a", "label-intervals"])
def test_foreign_dataset_matches_missing_dataset(series_client, suffix):
    dataset_id = upload(series_client)

    login(series_client, "bob")
    foreign = series_client.get(f"/api/v1/datasets/{dataset_id}/{suffix}")

    missing = series_client.get(f"/api/v1/datasets/{'a' * 32}/{suffix}")

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()


def test_changed_csv_and_unresolved_quality_are_not_silently_repaired(series_client):
    dataset_id = upload(series_client)

    source_path = series_client.app.state.settings.dataset_storage_path / f"{dataset_id}.csv"

    source_path.write_bytes(source_path.read_bytes() + b"changed")
    assert (
        series_client.get(
            f"/api/v1/datasets/{dataset_id}/series", params={"channels": "sensor_a"}
        ).status_code
        == 409
    )
    invalid_dataset_id = upload(
        series_client, source_csv().replace(b",0.0,0.0,normal", b",,0.0,normal", 1)
    )

    for suffix in ("series?channels=sensor_a", "label-intervals"):
        response = series_client.get(f"/api/v1/datasets/{invalid_dataset_id}/{suffix}")

        assert response.status_code == 422
        assert response.json()["error"]["code"] == "DATASET_NEEDS_REVIEW"


def test_observation_interval_helper_rejects_unobserved_and_outside_time(series_client):
    dataset_id = upload(series_client, source_csv(10, gap_at=2))

    with series_client.app.state.database.session_factory() as database_session:
        dataset = database_session.get(Dataset, dataset_id)

        settings = series_client.app.state.settings

        assert series.validate_observation_interval(
            dataset, settings, "sensor_a", datetime(2026, 11, 9), datetime(2026, 11, 9)
        ) == ("2026-11-09T00:00:00.000000", "2026-11-09T00:00:00.000000")
        with pytest.raises(HTTPException) as empty_error:
            series.validate_observation_interval(
                dataset,
                settings,
                "sensor_a",
                datetime(2026, 11, 9, 0, 5),
                datetime(2026, 11, 9, 0, 10),
            )
        assert empty_error.value.detail["code"] == "EMPTY_OBSERVATION_INTERVAL"
        with pytest.raises(HTTPException) as outside_error:
            series.validate_observation_interval(
                dataset, settings, "sensor_a", datetime(2026, 11, 8), datetime(2026, 11, 9)
            )
        assert outside_error.value.detail["code"] == "OBSERVATION_OUTSIDE_DATA"


def test_validation_predicts_each_model_in_exact_saved_feature_order(series_client, monkeypatch):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id)

    model_directory = series_client.app.state.settings.model_storage_path / run_id

    original_artifacts = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in model_directory.iterdir()
    }

    def reject_refit(*args, **kwargs):
        raise AssertionError("조회에서 재학습하면 안 됩니다.")

    monkeypatch.setattr(modeling, "create_estimator", reject_refit)
    for model_key in ("xgboost", "lightgbm", "autoencoder"):
        response = series_client.get(
            f"/api/v1/runs/{run_id}/predictions",
            params={"model_key": model_key, "limit": 5, "offset": 2},
        )

        assert response.status_code == 200, response.text
        result = response.json()

        assert result["total"] == 45
        assert [point["row_index"] for point in result["items"]] == list(range(92, 97))
        estimator = joblib.load(model_directory / f"{model_key}.joblib")

        features = np.array(
            [[row / 10, 10.0 if row % 5 in {1, 2} else 0.0] for row in range(92, 97)]
        )

        np.testing.assert_array_equal(
            [point["predicted_code"] for point in result["items"]], estimator.predict(features)
        )
        np.testing.assert_allclose(
            [point["score"] for point in result["items"]],
            modeling._anomaly_scores(estimator, features),
        )
        if model_key == "autoencoder":
            assert result["score_type"] == "reconstruction_error"
            assert result["threshold"] == estimator.threshold_
        else:
            assert result["score_type"] == "probability"
            assert result["threshold"] is None
        assert response.headers["cache-control"] == "no-store"
    assert original_artifacts == {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in model_directory.iterdir()
    }


def test_default_model_requires_explicit_selection_and_test_is_guarded_before_loading(
    series_client, monkeypatch
):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost"])

    assert series_client.get(f"/api/v1/runs/{run_id}/predictions").status_code == 409

    def reject_load(*args, **kwargs):
        raise AssertionError("Test 평가 전에 모델을 읽으면 안 됩니다.")

    monkeypatch.setattr(modeling, "load_trained_model", reject_load)
    for suffix in ("predictions", "prediction-intervals"):
        response = series_client.get(
            f"/api/v1/runs/{run_id}/{suffix}", params={"split": "test", "model_key": "xgboost"}
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "TEST_NOT_EVALUATED"
    assert (
        series_client.get(f"/api/v1/runs/{run_id}").json()["run"]["evaluation_status"]
        == "not_started"
    )


def test_completed_test_is_visible_only_for_evaluated_selected_model(series_client):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost", "lightgbm"])

    finish_evaluation(series_client, run_id, "lightgbm")
    response = series_client.get(f"/api/v1/runs/{run_id}/predictions", params={"split": "test"})

    assert response.status_code == 200, response.text
    assert response.json()["model_key"] == "lightgbm"
    assert [point["row_index"] for point in response.json()["items"]] == list(range(135, 180))
    for suffix in ("predictions", "prediction-intervals"):
        assert (
            series_client.get(
                f"/api/v1/runs/{run_id}/{suffix}", params={"split": "test", "model_key": "xgboost"}
            ).status_code
            == 409
        )


def test_validation_filter_cannot_read_test_and_intervals_match_prediction_rows(series_client):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost"])

    response = series_client.get(
        f"/api/v1/runs/{run_id}/predictions",
        params={"model_key": "xgboost", "start_time": "2026-11-09T02:15:00"},
    )

    assert response.status_code == 200
    assert response.json()["total"] == 0
    assert response.json()["items"] == []
    predictions = series_client.get(
        f"/api/v1/runs/{run_id}/predictions", params={"model_key": "xgboost"}
    ).json()

    interval_response = series_client.get(
        f"/api/v1/runs/{run_id}/prediction-intervals",
        params={"model_key": "xgboost", "predicted_code": 1},
    )

    assert interval_response.status_code == 200, interval_response.text
    expanded_rows = [
        row
        for interval in interval_response.json()["items"]
        for row in range(interval["start_row"], interval["end_row"])
    ]

    assert expanded_rows == [
        point["row_index"] for point in predictions["items"] if point["predicted_code"] == 1
    ]


@pytest.mark.parametrize("corruption", ["source", "metadata", "artifact"])
def test_corrupt_prediction_inputs_are_rejected_before_joblib_load(
    series_client, monkeypatch, corruption
):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost"])

    settings = series_client.app.state.settings

    model_directory = settings.model_storage_path / run_id

    if corruption == "source":
        source_path = settings.dataset_storage_path / f"{dataset_id}.csv"

        source_path.write_bytes(source_path.read_bytes() + b"changed")
    elif corruption == "artifact":
        artifact_path = model_directory / "xgboost.joblib"

        artifact_path.write_bytes(artifact_path.read_bytes() + b"changed")
    else:
        metadata_path = model_directory / "metadata.json"

        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

        metadata["configuration"]["feature_columns"].reverse()
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    def reject_deserialization(*args, **kwargs):
        raise AssertionError("무결성 확인 전에 joblib을 읽으면 안 됩니다.")

    monkeypatch.setattr(modeling.joblib, "load", reject_deserialization)
    response = series_client.get(
        f"/api/v1/runs/{run_id}/predictions", params={"model_key": "xgboost"}
    )

    assert response.status_code == (409 if corruption == "source" else 503)
    assert str(settings.model_storage_path) not in response.text


def test_foreign_runs_are_indistinguishable_from_missing_runs(series_client):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost"])

    login(series_client, "bob")
    for suffix in ("predictions", "prediction-intervals"):
        foreign = series_client.get(
            f"/api/v1/runs/{run_id}/{suffix}", params={"model_key": "xgboost"}
        )

        missing = series_client.get(
            f"/api/v1/runs/{'a' * 32}/{suffix}", params={"model_key": "xgboost"}
        )

        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()


def test_failed_and_untrained_model_predictions_are_unavailable(series_client):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, ["xgboost"])

    assert (
        series_client.get(
            f"/api/v1/runs/{run_id}/predictions", params={"model_key": "lightgbm"}
        ).status_code
        == 422
    )
    with series_client.app.state.database.session_factory() as database_session:
        model_run = database_session.scalar(select(ModelRun).where(ModelRun.id == run_id))

        model_run.status = "failed"

        database_session.commit()
    assert (
        series_client.get(
            f"/api/v1/runs/{run_id}/predictions", params={"model_key": "xgboost"}
        ).status_code
        == 409
    )


def test_model_prediction_failure_is_sanitized():
    class BrokenEstimator:
        def predict(self, features):
            raise ValueError("C:/private/path: confidential details")

    with pytest.raises(HTTPException) as error:
        series._predict(BrokenEstimator(), np.zeros((1, 2)))
    assert error.value.status_code == 503
    assert "private" not in str(error.value.detail)
