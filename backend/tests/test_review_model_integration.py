"""실제 학습 결과·현장 관찰·검토 완료를 연결해 원본과 근거가 유지되는지 확인한다."""

from test_runs import (
    WRITE_HEADERS,
    create_run,
    upload_dataset,
    wait_for_training,
)
from test_runs import (
    run_client as run_client,
)
from test_runs import (
    run_password_hash as run_password_hash,
)
from test_runs import (
    run_settings as run_settings,
)


def test_trained_model_and_observation_version_are_frozen_on_review_completion(
    run_client, monkeypatch,
):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["lightgbm"])

    trained_run = wait_for_training(run_client, run_id)

    assert trained_run["run"]["status"] == "completed"
    model_before = run_client.get(f"/api/v1/runs/{run_id}").json()

    source_before = run_client.get(f"/api/v1/datasets/{dataset_id}/file").content

    observed = run_client.post(
        "/api/v1/observations",
        json={
            "dataset_id": dataset_id,
            "channel": "sensor_00",
            "start_time": "2026-01-01T00:31:00",
            "end_time": "2026-01-01T00:34:00",
            "content": "처음 확인한 누수 흔적",
        },
        headers=WRITE_HEADERS,
    )

    assert observed.status_code == 201, observed.text
    observation_id = observed.json()["id"]

    created = run_client.post(
        "/api/v1/reviews",
        json={
            "dataset_id": dataset_id,
            "channel": "sensor_00",
            "start_time": "2026-01-01T00:31:00",
            "end_time": "2026-01-01T00:34:00",
            "conclusion": "모델 결과와 현장 관찰을 함께 확인함. 원인 판단은 보류.",
            "judgment": "needs_check",
            "model_result": {"run_id": run_id, "model_key": "lightgbm"},
            "observations": [{"observation_id": observation_id, "revision": 1}],
        },
        headers=WRITE_HEADERS,
    )

    assert created.status_code == 201, created.text
    review_id = created.json()["id"]

    assert created.json()["evidence"]["model_result"]["partition_metrics"]["sample_count"] == 15
    assert created.json()["evidence"]["model_result"]["metrics_scope"] == "full_partition"
    changed = run_client.patch(
        f"/api/v1/observations/{observation_id}",
        json={"revision": 1, "content": "다음 점검에서 확인한 다른 내용"},
        headers=WRITE_HEADERS,
    )

    assert changed.status_code == 200
    completed = run_client.post(
        f"/api/v1/reviews/{review_id}/complete", json={"revision": 1}, headers=WRITE_HEADERS,
    )

    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    assert completed.json()["judgment"] == "needs_check"
    assert completed.json()["evidence"]["observations"][0]["content"] == "처음 확인한 누수 흔적"
    assert completed.json()["evidence"]["observations"][0]["revision"] == 1
    assert run_client.get(f"/api/v1/runs/{run_id}").json() == model_before
    assert run_client.get(f"/api/v1/datasets/{dataset_id}/file").content == source_before

    def forbid_source_read(*args, **kwargs):
        # 과거 검토 조회는 파일·모델을 다시 읽거나 근거를 새로 만들지 않아야 한다.
        raise AssertionError("저장한 검토 조회 중 원본 재검사 또는 근거 재생성")

    monkeypatch.setattr("app.services.series.validate_observation_interval", forbid_source_read)
    monkeypatch.setattr("app.services.review_evidence.capture_evidence", forbid_source_read)
    restored = run_client.get(f"/api/v1/reviews/{review_id}")

    history = run_client.get(f"/api/v1/reviews/{review_id}/history")

    assert restored.status_code == 200
    assert restored.json() == completed.json()
    assert history.status_code == 200
    assert history.json()["total"] == 2
    assert history.json()["items"][0]["snapshot"] == completed.json()
