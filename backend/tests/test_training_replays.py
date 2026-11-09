"""자동 설정·제한된 옵션·합성 시계열과 저장 모델의 실제 연결을 검증한다."""

import csv
import hashlib
import io
import time
from datetime import datetime
from pathlib import Path

import joblib
import numpy as np
import pytest
from pydantic import ValidationError
from sqlalchemy import select
from test_series import (
    WRITE_HEADERS,
    finish_evaluation,
    login,
    source_csv,
    trained_run,
    upload,
)

from app.models import ModelRun, User
from app.schemas.runs import NewRunCreate, RunCreate
from app.services import replays

pytest_plugins = ["test_series"]


def request_plan(client, dataset_id, model_key="xgboost"):
    response = client.post(
        "/api/v1/training/plan",
        headers=WRITE_HEADERS,
        json={"dataset_id": dataset_id, "model_key": model_key},
    )

    assert response.status_code == 200, response.text
    return response.json()


def test_plan_keeps_time_order_and_only_proposes_one_model(series_client):
    dataset_id = upload(series_client)

    plan = request_plan(series_client, dataset_id)

    assert plan["split"] == {"train_rows": 126, "validation_rows": 27, "test_rows": 27}
    assert plan["configuration"]["train_end"] == "2026-11-09T02:05:00"
    assert plan["configuration"]["validation_end"] == "2026-11-09T02:32:00"
    assert plan["configuration"]["models"] == ["xgboost"]
    assert plan["configuration"]["model_options"]["xgboost"]["max_depth"] == 4
    assert series_client.get("/api/v1/runs").json()["total"] == 0
    login(series_client, "bob")
    assert (
        series_client.post(
            "/api/v1/training/plan",
            headers=WRITE_HEADERS,
            json={"dataset_id": dataset_id, "model_key": "xgboost"},
        ).status_code
        == 404
    )


@pytest.mark.parametrize(
    "options",
    [
        {"xgboost": {"n_estimators": 301}},
        {"xgboost": {"max_depth": True}},
        {"xgboost": {"n_jobs": 16}},
        {"autoencoder": {"threshold_quantile": 1.0}},
        {"autoencoder": {"hidden_size": 1000}},
        {"lightgbm": {"max_depth": 4}},
    ],
)
def test_options_are_bounded_and_cannot_supply_arbitrary_estimator_arguments(options):
    with pytest.raises(ValidationError):
        NewRunCreate(
            dataset_id="a" * 32,
            feature_columns=["sensor_a"],
            models=["xgboost", "autoencoder"],
            train_end="2026-11-09T01:00:00",
            validation_end="2026-11-09T02:00:00",
            model_options=options,
        )


def test_old_configuration_metadata_does_not_gain_new_empty_options():
    configuration = RunCreate(
        dataset_id="a" * 32,
        feature_columns=["sensor_a"],
        models=["xgboost"],
        train_end="2026-11-09T01:00:00",
        validation_end="2026-11-09T02:00:00",
    )

    assert "model_options" not in configuration.model_dump(mode="json")


@pytest.mark.parametrize("model_key", ["xgboost", "autoencoder"])
def test_custom_options_are_saved_and_reload_without_retraining(series_client, model_key):
    dataset_id = upload(series_client)

    plan = request_plan(series_client, dataset_id, model_key)

    if model_key == "xgboost":
        plan["configuration"]["model_options"][model_key] = {
            "n_estimators": 20,
            "max_depth": 2,
            "learning_rate": 0.2,
        }

    else:
        plan["configuration"]["model_options"][model_key] = {
            "max_iter": 20,
            "hidden_size": 8,
            "threshold_quantile": 0.95,
        }

    response = series_client.post("/api/v1/runs", headers=WRITE_HEADERS, json=plan["configuration"])

    assert response.status_code == 202, response.text
    run_id = response.json()["run"]["id"]

    deadline = time.monotonic() + 20

    while time.monotonic() < deadline:
        run = series_client.get(f"/api/v1/runs/{run_id}").json()

        if run["run"]["status"] in {"completed", "failed"}:
            break
        time.sleep(0.01)
    assert run["run"]["status"] == "completed", run
    finish_evaluation(series_client, run_id, model_key)
    result = series_client.get(f"/api/v1/runs/{run_id}/predictions?split=test").json()

    assert result["total"] == 27
    model_path = (
        series_client.app.state.settings.model_storage_path / run_id / f"{model_key}.joblib"
    )

    estimator = joblib.load(model_path)

    if model_key == "xgboost":
        assert estimator.get_params()["n_estimators"] == 20
        assert estimator.get_params()["max_depth"] == 2
    else:
        assert estimator.network_.max_iter == 20
        assert estimator.hidden_layer_sizes_[0] == 8
        assert estimator.threshold_quantile == 0.95
    assert result["score_type"] == (
        "probability" if model_key == "xgboost" else "reconstruction_error"
    )


def ready_replay(client, *, row_count=230_000, model_key="xgboost"):
    dataset_id = upload(client)

    run_id = trained_run(client, dataset_id, models=[model_key])

    finish_evaluation(client, run_id, model_key)
    request = {
        "run_id": run_id,
        "model_key": model_key,
        "row_count": row_count,
        "source_split": "test",
        "start_time": "2026-11-09T00:00:00+09:00",
    }

    response = client.post("/api/v1/replays", headers=WRITE_HEADERS, json=request)

    assert response.status_code == 201, response.text
    return response.json(), request


def test_exact_230000_synthetic_rows_retain_test_provenance_and_originals(series_client):
    settings = series_client.app.state.settings

    manifest, request = ready_replay(series_client)

    file_response = series_client.get(f"/api/v1/replays/{manifest['id']}/file")

    csv_rows = list(csv.DictReader(io.StringIO(file_response.text)))

    assert len(csv_rows) == 230_000
    assert manifest["total_rows"] == 230_000
    assert manifest["source_split"] == "test"
    assert manifest["synthetic"] is True
    assert manifest["source_start_row"] == 135
    assert set(csv_rows[0]) == {"timestamp", "sensor_b", "sensor_a", "label"}
    assert datetime.fromisoformat(csv_rows[-1]["timestamp"]) > datetime.fromisoformat(
        csv_rows[0]["timestamp"]
    )
    assert set(row["label"] for row in csv_rows) == {"normal", "abnormal"}
    source_path = settings.dataset_storage_path / f"{manifest['source_dataset_id']}.csv"

    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == manifest["source_sha256"]
    assert source_path.read_bytes() == source_csv()
    assert (
        series_client.post("/api/v1/replays", headers=WRITE_HEADERS, json=request).json()["id"]
        == manifest["id"]
    )
    assert series_client.get("/api/v1/replays").json()["total"] == 1
    assert series_client.get("/api/v1/datasets").json()["total"] == 2
    assert "offsets" not in manifest and "source_timestamps" not in manifest


def test_batch_prediction_uses_exact_feature_order_and_only_requested_rows(series_client):
    manifest, _ = ready_replay(series_client, row_count=2100)

    response = series_client.get(
        f"/api/v1/replays/{manifest['id']}/batch?cursor=995&limit=12&channel=sensor_a"
    )

    assert response.status_code == 200, response.text
    batch = response.json()

    assert batch["next_cursor"] == 1007
    assert [point["row_index"] for point in batch["points"]] == list(range(995, 1007))
    assert batch["done"] is False
    assert len(batch["points"]) == 12
    model_path = (
        series_client.app.state.settings.model_storage_path / manifest["run_id"] / "xgboost.joblib"
    )

    estimator = joblib.load(model_path)

    source_rows = list(csv.DictReader(io.StringIO(source_csv().decode())))

    features = np.array(
        [
            [float(source_rows[point["source_row"]][name]) for name in manifest["feature_columns"]]
            for point in batch["points"]
        ]
    )

    assert [point["predicted_code"] for point in batch["points"]] == estimator.predict(
        features
    ).tolist()
    np.testing.assert_allclose(
        [point["score"] for point in batch["points"]], estimator.predict_proba(features)[:, 1]
    )
    assert all(
        point["value"] == float(source_rows[point["source_row"]]["sensor_a"])
        for point in batch["points"]
    )
    assert all(point["source_row"] >= manifest["source_start_row"] for point in batch["points"])
    end = series_client.get(
        f"/api/v1/replays/{manifest['id']}/batch?cursor=2100&limit=5&channel=sensor_a"
    ).json()

    assert end["points"] == [] and end["done"] is True
    login(series_client, "bob")
    assert series_client.get(f"/api/v1/replays/{manifest['id']}").status_code == 404
    assert series_client.get(f"/api/v1/replays/{manifest['id']}/file").status_code == 404
    assert (
        series_client.get(f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a").status_code
        == 404
    )
    assert series_client.get("/api/v1/replays").json()["total"] == 0


def test_replay_requires_test_completed_and_rejects_tampered_csv(series_client):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, models=["xgboost"])

    assert (
        series_client.post(
            "/api/v1/replays",
            headers=WRITE_HEADERS,
            json={"run_id": run_id, "model_key": "xgboost"},
        ).status_code
        == 409
    )
    finish_evaluation(series_client, run_id, "xgboost")
    manifest = series_client.post(
        "/api/v1/replays",
        headers=WRITE_HEADERS,
        json={"run_id": run_id, "model_key": "xgboost", "row_count": 100},
    ).json()

    generated_path = (
        series_client.app.state.settings.dataset_storage_path / f"{manifest['dataset_id']}.csv"
    )

    generated_path.write_text("changed", encoding="utf-8")
    assert (
        series_client.get(f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a").status_code
        == 409
    )


def test_autoencoder_replay_reports_raw_error_and_train_threshold(series_client):
    manifest, _ = ready_replay(series_client, row_count=120, model_key="autoencoder")

    response = series_client.get(
        f"/api/v1/replays/{manifest['id']}/batch?cursor=10&limit=9&channel=sensor_b"
    )

    assert response.status_code == 200, response.text
    batch = response.json()

    estimator = joblib.load(
        series_client.app.state.settings.model_storage_path
        / manifest["run_id"]
        / "autoencoder.joblib"
    )

    source_rows = list(csv.DictReader(io.StringIO(source_csv().decode())))

    features = np.array(
        [
            [float(source_rows[point["source_row"]][name]) for name in manifest["feature_columns"]]
            for point in batch["points"]
        ]
    )

    assert batch["score_type"] == "reconstruction_error"
    assert batch["threshold"] == estimator.threshold_
    np.testing.assert_allclose(
        [point["score"] for point in batch["points"]], estimator.decision_function(features)
    )
    assert [point["predicted_code"] for point in batch["points"]] == estimator.predict(
        features
    ).tolist()


def test_second_batch_reuses_only_validated_file_hashes_and_model(series_client, monkeypatch):
    manifest, _ = ready_replay(series_client, row_count=120)

    replays._cached_trained_model.cache_clear()
    replays._cached_generated_sha256.cache_clear()
    original_hash = replays.modeling._file_sha256

    original_load = replays.modeling.joblib.load

    hashed_paths = []

    loaded_paths = []

    def record_hash(path):
        hashed_paths.append(path)
        return original_hash(path)

    def record_load(path):
        loaded_paths.append(path)
        return original_load(path)

    monkeypatch.setattr(replays.modeling, "_file_sha256", record_hash)
    monkeypatch.setattr(replays.modeling.joblib, "load", record_load)
    url = f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a&limit=5"

    assert series_client.get(url).status_code == 200
    assert len(hashed_paths) == 3  # 학습 원본, 저장 모델, 생성 CSV를 첫 요청에서 확인한다.
    assert len(loaded_paths) == 1
    assert series_client.get(url + "&cursor=5").status_code == 200
    assert len(hashed_paths) == 3
    assert len(loaded_paths) == 1
    assert replays._cached_trained_model.cache_info().hits == 1
    # 검증된 파일을 바꾸면 stat가 달라지며 기존 해시 캐시를 재사용하지 않는다.
    generated_path = (
        series_client.app.state.settings.dataset_storage_path / f"{manifest['dataset_id']}.csv"
    )

    generated_path.write_text("changed", encoding="utf-8")
    assert series_client.get(url).status_code == 409
    assert len(hashed_paths) == 4
    assert replays._cached_generated_sha256.cache_info().currsize == 1


@pytest.mark.parametrize("changed_file", ["source", "model", "metadata"])
def test_source_model_and_metadata_stat_changes_revalidate_batch_cache(
    series_client, changed_file, monkeypatch
):
    manifest, _ = ready_replay(series_client, row_count=120)

    replays._cached_trained_model.cache_clear()
    url = f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a&limit=5"

    assert series_client.get(url).status_code == 200
    original_load = replays.modeling.load_trained_model

    validation_count = 0

    def record_validation(*args, **kwargs):
        nonlocal validation_count
        validation_count += 1

        return original_load(*args, **kwargs)

    monkeypatch.setattr(replays.modeling, "load_trained_model", record_validation)
    settings = series_client.app.state.settings

    paths = {
        "source": settings.dataset_storage_path / f"{manifest['source_dataset_id']}.csv",
        "model": settings.model_storage_path / manifest["run_id"] / "xgboost.joblib",
        "metadata": settings.model_storage_path / manifest["run_id"] / "metadata.json",
    }

    with paths[changed_file].open("ab") as changed:
        changed.write(b"\n")
    response = series_client.get(url)

    # JSON 공백만 바뀐 metadata는 재검증 후 허용하고, 원본·모델 변경은 거부한다.
    assert response.status_code == (200 if changed_file == "metadata" else 503)
    assert validation_count == 1
    assert replays._cached_trained_model.cache_info().currsize == (
        2 if changed_file == "metadata" else 1
    )


def test_warm_model_cache_does_not_cache_database_ownership(series_client):
    manifest, _ = ready_replay(series_client, row_count=120)

    replays._cached_trained_model.cache_clear()
    url = f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a&limit=5"

    assert series_client.get(url).status_code == 200
    with series_client.app.state.database.session_factory() as database_session:
        other_user = database_session.scalar(select(User).where(User.username == "bob"))

        model_run = database_session.get(ModelRun, manifest["run_id"])

        model_run.owner_id = other_user.id

        database_session.commit()
    assert series_client.get(url).status_code == 404
    assert replays._cached_trained_model.cache_info().hits == 0


def test_plan_discloses_normal_only_test_without_adjusting_time_boundaries(series_client):
    lines = source_csv().decode().splitlines()

    for index in range(153, 180):
        values = lines[index + 1].split(",")

        values[-1] = "normal"

        lines[index + 1] = ",".join(values)

    dataset_id = upload(series_client, ("\n".join(lines) + "\n").encode())

    plan = request_plan(series_client, dataset_id)

    assert plan["label_counts"]["test"] == {"normal": 27, "abnormal": 0}
    assert plan["label_counts"]["train"]["abnormal"] > 0
    assert plan["configuration"]["validation_end"] == "2026-11-09T02:32:00"
    assert any(
        "최종 확인" in warning and "비정상 기록이 없어" in warning for warning in plan["warnings"]
    )
    assert plan["split"]["test_rows"] == 27


@pytest.mark.parametrize("source_split, first_source_row", [("full", 0), ("test", 135)])
def test_full_and_test_resampling_provenance_also_handles_downsampling(
    series_client, source_split, first_source_row
):
    manifest, request = ready_replay(series_client, row_count=7)

    request["source_split"] = source_split

    response = series_client.post("/api/v1/replays", headers=WRITE_HEADERS, json=request)

    assert response.status_code == 201, response.text
    manifest = response.json()

    assert manifest["source_split"] == source_split
    assert manifest["source_start_row"] == first_source_row
    assert manifest["source_end_row"] == 180
    assert ("학습 구간 포함" in manifest["provenance"]) == (source_split == "full")
    batch = series_client.get(
        f"/api/v1/replays/{manifest['id']}/batch?channel=sensor_a&limit=7"
    ).json()

    source_rows = list(csv.DictReader(io.StringIO(source_csv().decode())))

    source_count = 180 - first_source_row

    for index, point in enumerate(batch["points"]):
        expected_row = first_source_row + index * source_count // 7

        assert point["source_row"] == expected_row
        assert point["source_timestamp"] == source_rows[expected_row]["timestamp"]
        assert point["value"] == float(source_rows[expected_row]["sensor_a"])


def test_stale_legacy_temp_and_failed_publish_do_not_block_retry(series_client, monkeypatch):
    dataset_id = upload(series_client)

    run_id = trained_run(series_client, dataset_id, models=["xgboost"])

    finish_evaluation(series_client, run_id, "xgboost")
    owner_id = series_client.get("/api/v1/auth/me").json()["user"]["id"]

    start_time = "2026-11-09T00:00:00+09:00"

    replay_id = hashlib.sha256(
        f"{owner_id}:{run_id}:xgboost:7:test:{start_time}".encode()
    ).hexdigest()[:32]

    manifest_path = replays._manifest_path(series_client.app.state.settings, replay_id)

    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_json = manifest_path.with_suffix(".json.tmp")

    legacy_csv = manifest_path.with_suffix(".csv.tmp")

    legacy_json.write_text("previous process interrupted", encoding="utf-8")
    legacy_csv.write_text("another old temporary file", encoding="utf-8")
    original_replace = Path.replace

    publish_failures = 0

    def interrupt_publish(path, destination):
        nonlocal publish_failures
        if (
            path.name.endswith(".json.tmp")
            and Path(destination) == manifest_path
            and publish_failures == 0
        ):
            publish_failures += 1

            raise OSError("테스트: manifest 게시 직전 중단")
        return original_replace(path, destination)

    monkeypatch.setattr(Path, "replace", interrupt_publish)
    body = {
        "run_id": run_id,
        "model_key": "xgboost",
        "row_count": 7,
        "source_split": "test",
        "start_time": start_time,
    }

    first = series_client.post("/api/v1/replays", headers=WRITE_HEADERS, json=body)

    assert first.status_code == 503
    assert not manifest_path.exists()
    assert list(manifest_path.parent.glob(f".{replay_id}.*.tmp")) == []
    retry = series_client.post("/api/v1/replays", headers=WRITE_HEADERS, json=body)

    assert retry.status_code == 201, retry.text
    assert retry.json()["id"] == replay_id
    assert legacy_json.read_text(encoding="utf-8") == "previous process interrupted"
    assert legacy_csv.read_text(encoding="utf-8") == "another old temporary file"
    assert list(manifest_path.parent.glob(f".{replay_id}.*.tmp")) == []
    assert (
        series_client.post("/api/v1/replays", headers=WRITE_HEADERS, json=body).json()["id"]
        == replay_id
    )
