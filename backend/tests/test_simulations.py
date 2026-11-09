"""업로드 원본 보존·학습 입력 순서·계정 격리와 요청 배치만의 실제 추론."""

import csv
import io
from datetime import datetime, timedelta

import joblib
import numpy as np
import pytest
from test_series import WRITE_HEADERS, finish_evaluation, login, trained_run, upload

from app.services import simulations

pytest_plugins = ["test_series"]


def simulation_csv(count=20, *, labels=True):
    columns = ["timestamp", "sensor_a", "all_sensors_missing", "sensor_b"]

    if labels:
        columns.append("label")
    output = io.StringIO(newline="")

    writer = csv.writer(output)

    writer.writerow(columns)
    for index in range(count):
        timestamp = datetime(2026, 11, 1) + timedelta(minutes=index)

        row = [timestamp.isoformat(), 10 if index % 2 else 0, "False", index / 10]

        writer.writerow([*row, "not_a_model_input"] if labels else row)
    return output.getvalue().encode()


def ready_model(client, model_key="xgboost"):
    dataset_id = upload(client)

    run_id = trained_run(client, dataset_id, [model_key])

    finish_evaluation(client, run_id, model_key)
    return run_id


def create_simulation(client, run_id, content=None, model_key="xgboost"):
    return client.post(
        "/api/v1/simulations",
        headers=WRITE_HEADERS,
        data={"run_id": run_id, "model_key": model_key},
        files={"file": ("sensor_demo.csv", content or simulation_csv(), "text/csv")},
    )


@pytest.mark.parametrize("model_key", ["xgboost", "autoencoder"])
def test_upload_preserves_source_and_predicts_only_requested_ordered_features(
    series_client, monkeypatch, model_key
):
    run_id = ready_model(series_client, model_key)

    original = simulation_csv(2100, labels=False)

    response = create_simulation(series_client, run_id, original, model_key)

    assert response.status_code == 201, response.text
    manifest = response.json()

    assert manifest["total_rows"] == 2100
    assert manifest["feature_columns"] == ["sensor_b", "sensor_a"]
    assert manifest["start_time"] == "2026-11-01T00:00:00"
    assert manifest["end_time"] == "2026-11-02T10:59:00"
    assert manifest["synthetic"] is True
    settings = series_client.app.state.settings

    assert simulations._path(settings, 1, manifest["id"], "csv").read_bytes() == original
    assert series_client.get("/api/v1/datasets").json()["total"] == 1
    requested_arrays = []

    actual_predict = simulations._predict

    def capture_predict(estimator, features):
        requested_arrays.append(features.copy())
        return actual_predict(estimator, features)

    monkeypatch.setattr(simulations, "_predict", capture_predict)
    batch_response = series_client.get(
        f"/api/v1/simulations/{manifest['id']}/batch",
        params={"cursor": 1002, "limit": 3, "channel": "sensor_a"},
    )

    assert batch_response.status_code == 200, batch_response.text
    batch = batch_response.json()

    expected_inputs = np.array([[100.2, 0], [100.3, 10], [100.4, 0]])

    np.testing.assert_array_equal(requested_arrays[0], expected_inputs)
    estimator = joblib.load(settings.model_storage_path / run_id / f"{model_key}.joblib")

    assert [point["predicted_code"] for point in batch["points"]] == estimator.predict(
        expected_inputs
    ).tolist()
    assert [point["row_index"] for point in batch["points"]] == [1002, 1003, 1004]
    assert batch["next_cursor"] == 1005
    assert batch["done"] is False
    assert batch["score_type"] == (
        "reconstruction_error" if model_key == "autoencoder" else "probability"
    )
    assert batch_response.headers["cache-control"] == "no-store"
    assert (
        series_client.get(
            f"/api/v1/simulations/{manifest['id']}/batch",
            params={"cursor": 2100, "channel": "sensor_b"},
        ).json()["points"]
        == []
    )


def test_uploaded_metadata_is_ignored_and_repeat_is_idempotent(series_client):
    run_id = ready_model(series_client)

    first = create_simulation(series_client, run_id)

    assert first.status_code == 201, first.text
    second = create_simulation(series_client, run_id)

    assert second.json()["id"] == first.json()["id"]
    listing = series_client.get("/api/v1/simulations").json()

    assert listing["total"] == 1
    assert listing["items"][0]["id"] == first.json()["id"]


def test_cross_account_cannot_upload_against_model_or_read_simulation(series_client):
    run_id = ready_model(series_client)

    manifest = create_simulation(series_client, run_id).json()

    login(series_client, "bob")
    assert create_simulation(series_client, run_id).status_code == 404
    assert series_client.get(f"/api/v1/simulations/{manifest['id']}").status_code == 404
    assert (
        series_client.get(
            f"/api/v1/simulations/{manifest['id']}/batch", params={"channel": "sensor_a"}
        ).status_code
        == 404
    )
    assert series_client.get("/api/v1/simulations").json()["total"] == 0


@pytest.mark.parametrize(
    "content",
    [
        b"timestamp,sensor_a\n2026-11-01,1\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-01,,1\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-01,nan,1\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-01,1,inf\n",
        b"timestamp,sensor_a,sensor_b\nwrong,1,2\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-02,1,2\n2026-11-01,2,3\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-01,1,2\n2026-11-01,2,3\n",
        b"timestamp,sensor_a,sensor_b\n2026-11-01,1,2\n2026-11-02T00:00:00Z,2,3\n",
        b"timestamp,sensor_a,sensor_b\n",
    ],
)
def test_invalid_upload_is_rejected_without_publishing_private_files(series_client, content):
    run_id = ready_model(series_client)

    response = create_simulation(series_client, run_id, content)

    assert response.status_code == 422, response.text
    assert series_client.get("/api/v1/simulations").json()["total"] == 0
    assert not list(simulations._directory(series_client.app.state.settings, 1).glob("*.tmp"))


def test_changed_uploaded_source_and_changed_trained_artifact_are_rejected(series_client):
    run_id = ready_model(series_client)

    manifest = create_simulation(series_client, run_id).json()

    settings = series_client.app.state.settings

    request_path = f"/api/v1/simulations/{manifest['id']}/batch"

    assert series_client.get(request_path, params={"channel": "sensor_a"}).status_code == 200
    original_path = simulations._path(settings, 1, manifest["id"], "csv")

    original = original_path.read_bytes()

    original_path.write_bytes(original + b"\n")
    changed_response = series_client.get(request_path, params={"channel": "sensor_a"})

    assert changed_response.status_code == 409
    assert changed_response.json()["error"]["code"] == "SIMULATION_CHANGED"
    original_path.write_bytes(original)
    artifact = settings.model_storage_path / run_id / "xgboost.joblib"

    artifact.write_bytes(artifact.read_bytes() + b"changed")
    assert series_client.get(request_path, params={"channel": "sensor_a"}).status_code == 503


def test_model_must_finish_final_evaluation_and_upload_obeys_file_limit(series_client):
    run_id = trained_run(series_client, upload(series_client), ["xgboost"])

    assert create_simulation(series_client, run_id).status_code == 409
    finish_evaluation(series_client, run_id, "xgboost")
    series_client.app.state.settings.max_upload_bytes = 10
    assert create_simulation(series_client, run_id).status_code == 413
