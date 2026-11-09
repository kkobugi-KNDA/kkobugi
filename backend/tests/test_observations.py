"""현장 관찰의 소유권·원본 보존·구간 검증·버전 충돌·수정 이력 저장을 확인한다."""

from io import BytesIO

import pytest
from fastapi import HTTPException, UploadFile
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.main import create_app
from app.models import Dataset, ModelRun, Observation, ObservationHistory, User
from app.schemas.observations import ObservationPatch
from app.security import hash_password
from app.services import datasets as dataset_service
from app.services import observations as observation_service

ORIGIN = "http://localhost:5173"

HEADERS = {"Origin": ORIGIN, "X-Requested-With": "kkobugi-web"}

PASSWORD = "observation-test-only-password"

CSV_BYTES = (
    b"timestamp,sensor_00,sensor_01,label\n"
    b"2026-01-01 00:00:00,1,10,normal\n"
    b"2026-01-01 00:01:00,2,20,abnormal\n"
    b"2026-01-01 00:02:00,3,30,normal\n"
    b"2026-01-01 00:05:00,4,40,abnormal\n"
    b"2026-01-01 00:06:00,5,50,normal\n"
    b"2026-01-01 00:07:00,6,60,abnormal\n"
    b"2026-01-01 00:08:00,7,70,normal\n"
    b"2026-01-01 00:09:00,8,80,abnormal\n"
)


@pytest.fixture(scope="session")
def observation_password_hash():
    return hash_password(PASSWORD)


@pytest.fixture
def observation_setup(tmp_path, observation_password_hash):
    settings = Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
        cors_origins=[ORIGIN],
    )

    application = create_app(settings)

    with TestClient(application) as test_client:
        with application.state.database.session_factory() as database_session:
            database_session.add_all(
                [
                    User(
                        username="alice",
                        display_name="작성자",
                        password_hash=observation_password_hash,
                    ),
                    User(
                        username="bob",
                        display_name="다른 사용자",
                        password_hash=observation_password_hash,
                    ),
                ]
            )
            database_session.commit()
        login(test_client)
        uploaded = test_client.post(
            "/api/v1/datasets",
            files={"file": ("prepared.csv", CSV_BYTES, "text/csv")},
            headers=HEADERS,
        )

        assert uploaded.status_code == 201
        yield test_client, application, settings, uploaded.json()["dataset"]["id"]


def login(client, username="alice"):
    response = client.post(
        "/api/v1/auth/login", json={"username": username, "password": PASSWORD}, headers=HEADERS
    )

    assert response.status_code == 200
    return response.json()["user"]


def payload(dataset_id, **changes):
    body = {
        "dataset_id": dataset_id,
        "channel": "sensor_00",
        "start_time": "2026-01-01T00:01:00",
        "end_time": "2026-01-01T00:05:00",
        "location": "펌프 주변",
        "content": "  누수 흔적을 확인함.\n다음 점검 때 비교.  ",
        "judgment": "anomaly_candidate",
    }

    body.update(changes)
    return body


def create_record(client, dataset_id, **changes):
    response = client.post(
        "/api/v1/observations", json=payload(dataset_id, **changes), headers=HEADERS
    )

    assert response.status_code == 201, response.text
    return response.json()


def test_create_patch_and_history_preserve_csv_and_previous_versions(observation_setup):
    client, application, settings, dataset_id = observation_setup

    created = create_record(client, dataset_id)

    assert created["revision"] == 1
    assert created["content"] == payload(dataset_id)["content"]
    assert created["author"] == created["last_editor"]
    assert created["author"]["username"] == "alice"
    assert created["start_time"] == "2026-01-01T00:01:00.000000"
    assert created["run_id"] is None
    assert created["model_key"] is None
    assert (settings.dataset_storage_path / f"{dataset_id}.csv").read_bytes() == CSV_BYTES
    changed = client.patch(
        f"/api/v1/observations/{created['id']}",
        json={"revision": 1, "content": "패킹 주변은 건조함.", "judgment": "normal"},
        headers=HEADERS,
    )

    assert changed.status_code == 200, changed.text
    updated = changed.json()

    assert updated["revision"] == 2
    assert updated["content"] == "패킹 주변은 건조함."
    assert updated["judgment"] == "normal"
    assert updated["created_at"] == created["created_at"]
    history = client.get(f"/api/v1/observations/{created['id']}/history").json()

    assert history["total"] == 2
    assert [item["revision"] for item in history["items"]] == [2, 1]
    assert history["items"][0]["snapshot"] == updated
    assert history["items"][1]["snapshot"] == created
    assert history["items"][1]["changed_by"] == created["author"]
    assert (settings.dataset_storage_path / f"{dataset_id}.csv").read_bytes() == CSV_BYTES
    with application.state.database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(Dataset)) == 1
        assert database_session.scalar(select(func.count()).select_from(ObservationHistory)) == 2


def test_stale_revision_is_conflict_without_extra_history(observation_setup):
    client, _, _, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    path = f"/api/v1/observations/{record['id']}"

    assert (
        client.patch(path, json={"revision": 1, "location": "모터 옆"}, headers=HEADERS).status_code
        == 200
    )
    conflict = client.patch(path, json={"revision": 1, "content": "오래된 탭"}, headers=HEADERS)

    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "OBSERVATION_CONFLICT"
    assert client.get(path).json()["location"] == "모터 옆"
    assert client.get(path + "/history").json()["total"] == 2


def test_database_compare_and_swap_rejects_race_after_initial_read(observation_setup, monkeypatch):
    client, application, settings, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    database = application.state.database

    with database.session_factory() as first_session, database.session_factory() as second_session:
        first_user = first_session.scalar(select(User).where(User.username == "alice"))

        second_user = second_session.get(User, first_user.id)

        stale_record = observation_service.get_observation(
            first_session, record["id"], first_user.id
        )

        winner = observation_service.patch_observation(
            second_session,
            second_user,
            settings,
            record["id"],
            ObservationPatch(revision=1, content="먼저 저장됨"),
        )

        assert winner.revision == 2
        # 읽기 직후 다른 요청이 저장한 상황을 재현해 UPDATE의 revision 조건을 확인한다.
        original_get = observation_service.get_observation

        monkeypatch.setattr(observation_service, "get_observation", lambda *args: stale_record)
        with pytest.raises(HTTPException) as error:
            observation_service.patch_observation(
                first_session,
                first_user,
                settings,
                record["id"],
                ObservationPatch(revision=1, content="늦은 저장"),
            )
        assert error.value.status_code == 409
        monkeypatch.setattr(observation_service, "get_observation", original_get)
    assert client.get(f"/api/v1/observations/{record['id']}").json()["content"] == "먼저 저장됨"


@pytest.mark.parametrize("operation", ["create", "patch"])
def test_history_failure_rolls_back_record_in_same_transaction(
    observation_setup, monkeypatch, operation
):
    client, application, _, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    def fail_history(*args):
        raise SQLAlchemyError("test-only history insert failure")

    monkeypatch.setattr(observation_service, "_add_history", fail_history)
    if operation == "create":
        response = client.post("/api/v1/observations", json=payload(dataset_id), headers=HEADERS)

    else:
        response = client.patch(
            f"/api/v1/observations/{record['id']}",
            json={"revision": 1, "content": "실패해야 할 수정"},
            headers=HEADERS,
        )

    assert response.status_code == 503
    assert "test-only" not in response.text
    with application.state.database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(Observation)) == 1
        assert database_session.scalar(select(func.count()).select_from(ObservationHistory)) == 1
        stored_record = database_session.get(Observation, record["id"])

        assert stored_record.revision == 1
        assert stored_record.content == record["content"]


def test_all_operations_require_login_and_writes_require_csrf_headers(observation_setup):
    client, _, _, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    path = f"/api/v1/observations/{record['id']}"

    assert client.post("/api/v1/observations", json=payload(dataset_id)).status_code == 403
    assert client.patch(path, json={"revision": 1, "content": "무단 수정"}).status_code == 403
    client.cookies.clear()
    responses = [
        client.get("/api/v1/observations"),
        client.get(path),
        client.get(path + "/history"),
        client.post("/api/v1/observations", json=payload(dataset_id), headers=HEADERS),
        client.patch(path, json={"revision": 1, "content": "익명 수정"}, headers=HEADERS),
    ]

    assert all(response.status_code == 401 for response in responses)


def test_other_owner_cannot_read_edit_history_or_filter_private_dataset(observation_setup):
    client, _, _, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    login(client, "bob")
    path = f"/api/v1/observations/{record['id']}"

    assert client.get("/api/v1/observations").json()["items"] == []
    for response in (
        client.get(path),
        client.get(path + "/history"),
        client.patch(path, json={"revision": 1, "content": "다른 사용자 수정"}, headers=HEADERS),
        client.post("/api/v1/observations", json=payload(dataset_id), headers=HEADERS),
        client.get("/api/v1/observations", params={"dataset_id": dataset_id}),
    ):
        assert response.status_code == 404
    assert client.get(path).json() == client.get("/api/v1/observations/" + "0" * 32).json()


@pytest.mark.parametrize(
    "changes",
    [
        {"content": "   "},
        {"content": ""},
        {"content": "x" * 5001},
        {"location": "x" * 201},
        {"content": None},
        {"channel": "unknown"},
        {"channel": "timestamp"},
        {"start_time": "2026-01-01T00:06:00"},
        {"start_time": 1767225600},
        {"start_time": "1767225600"},
        {"start_time": "2025-12-31T23:59:59"},
        {"end_time": "2026-01-01T00:10:00"},
        {"start_time": "2026-01-01T00:03:00", "end_time": "2026-01-01T00:04:00"},
        {"start_time": "2026-01-01T00:01:00+09:00"},
        {"judgment": "broken"},
        {"owner_id": 123},
        {"model_key": "xgboost"},
    ],
)
def test_invalid_creation_is_rejected_without_storage(observation_setup, changes):
    client, application, _, dataset_id = observation_setup

    response = client.post(
        "/api/v1/observations", json=payload(dataset_id, **changes), headers=HEADERS
    )

    assert response.status_code == 422, response.text
    with application.state.database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(Observation)) == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"revision": 1},
        {"revision": "1", "content": "문자열 버전"},
        {"revision": 0, "content": "잘못된 버전"},
        {"revision": 1, "content": None},
        {"revision": 1, "content": "  "},
        {"revision": 1, "start_time": None},
        {"revision": 1, "end_time": "2026-01-01T00:00:00"},
        {"revision": 1, "start_time": "2026-01-01T00:08:00"},
        {"revision": 1, "dataset_id": "0" * 32},
        {"revision": 1, "run_id": None},
        {"revision": 1, "author": {"id": 1}},
    ],
)
def test_invalid_patch_preserves_record_and_history(observation_setup, changes):
    client, _, _, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    response = client.patch(f"/api/v1/observations/{record['id']}", json=changes, headers=HEADERS)

    assert response.status_code == 422, response.text
    assert client.get(f"/api/v1/observations/{record['id']}").json() == record
    assert client.get(f"/api/v1/observations/{record['id']}/history").json()["total"] == 1


def test_zero_duration_observed_point_is_allowed_but_gap_is_not(observation_setup):
    client, _, _, dataset_id = observation_setup

    record = create_record(
        client, dataset_id, start_time="2026-01-01T00:02:00", end_time="2026-01-01T00:02:00"
    )

    assert record["start_time"] == record["end_time"]


def test_list_filters_overlap_inclusively_and_paginate_history(observation_setup):
    client, _, _, dataset_id = observation_setup

    first = create_record(client, dataset_id)

    second = create_record(
        client,
        dataset_id,
        channel="sensor_01",
        start_time="2026-01-01T00:08:00",
        end_time="2026-01-01T00:09:00",
    )

    filtered = client.get(
        "/api/v1/observations",
        params={
            "dataset_id": dataset_id,
            "start_time": "2026-01-01T00:05:00",
            "end_time": "2026-01-01T00:05:00",
        },
    )

    assert filtered.status_code == 200, filtered.text
    assert [item["id"] for item in filtered.json()["items"]] == [first["id"]]
    by_channel = client.get(
        "/api/v1/observations", params={"dataset_id": dataset_id, "channel": "sensor_01"}
    )

    assert [item["id"] for item in by_channel.json()["items"]] == [second["id"]]
    page = client.get("/api/v1/observations", params={"limit": 1, "offset": 1}).json()

    assert page["total"] == 2
    assert len(page["items"]) == 1
    path = f"/api/v1/observations/{first['id']}"

    assert (
        client.patch(
            path, json={"revision": 1, "content": "2번째 기록"}, headers=HEADERS
        ).status_code
        == 200
    )
    history = client.get(path + "/history", params={"limit": 1, "offset": 1}).json()

    assert history["total"] == 2
    assert history["items"][0]["revision"] == 1


@pytest.mark.parametrize(
    "query",
    [
        {"channel": "sensor_00"},
        {"start_time": "2026-01-01T00:00:00"},
        {"end_time": "2026-01-01T00:01:00"},
        {"channel": "missing", "with_dataset": True},
        {"start_time": "1767225600", "with_dataset": True},
        {"start_time": "2026-01-01T00:00:00Z", "with_dataset": True},
        {
            "start_time": "2026-01-01T00:09:00",
            "end_time": "2026-01-01T00:01:00",
            "with_dataset": True,
        },
        {"limit": 101},
        {"offset": -1},
    ],
)
def test_list_validates_dataset_timezone_range_and_pagination(observation_setup, query):
    client, _, _, dataset_id = observation_setup

    parameters = dict(query)

    if parameters.pop("with_dataset", False):
        parameters["dataset_id"] = dataset_id

    assert client.get("/api/v1/observations", params=parameters).status_code == 422


def test_model_context_must_belong_to_dataset_owner_and_completed_model(observation_setup):
    client, application, _, dataset_id = observation_setup

    with application.state.database.session_factory() as database_session:
        owner = database_session.scalar(select(User).where(User.username == "alice"))

        other_user = database_session.scalar(select(User).where(User.username == "bob"))

        for run_id, owner_id, linked_dataset, status in (
            ("1" * 32, owner.id, dataset_id, "completed"),
            ("2" * 32, owner.id, dataset_id, "queued"),
            ("3" * 32, other_user.id, dataset_id, "completed"),
        ):
            database_session.add(
                ModelRun(
                    id=run_id,
                    owner_id=owner_id,
                    dataset_id=linked_dataset,
                    status=status,
                    configuration={"models": ["xgboost"]},
                    input_sha256="0" * 64,
                    training_report={"models": [{"model_key": "xgboost"}]},
                )
            )
        database_session.commit()
    attached = create_record(client, dataset_id, run_id="1" * 32, model_key="xgboost")

    assert attached["run_id"] == "1" * 32
    assert attached["model_key"] == "xgboost"
    for changes, expected_status in (
        ({"run_id": "2" * 32}, 409),
        ({"run_id": "3" * 32}, 404),
        ({"run_id": "0" * 32}, 404),
        ({"run_id": "1" * 32, "model_key": "autoencoder"}, 422),
    ):
        response = client.post(
            "/api/v1/observations", json=payload(dataset_id, **changes), headers=HEADERS
        )

        assert response.status_code == expected_status, response.text


def test_source_tampering_prevents_new_records_and_edits(observation_setup):
    client, _, settings, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    (settings.dataset_storage_path / f"{dataset_id}.csv").write_bytes(CSV_BYTES + b"\n")
    response = client.post("/api/v1/observations", json=payload(dataset_id), headers=HEADERS)

    assert response.status_code in (409, 422)
    patched = client.patch(
        f"/api/v1/observations/{record['id']}",
        json={"revision": 1, "content": "변조 뒤 수정"},
        headers=HEADERS,
    )

    assert patched.status_code == response.status_code
    assert client.get(f"/api/v1/observations/{record['id']}").json() == record


def test_aware_times_are_utc_canonical_for_storage_and_overlap_queries(observation_setup):
    client, application, settings, _ = observation_setup

    # 각 행에 명시적 시간대를 넣어 naive 자료와 별도로 등록한다.
    aware_lines = CSV_BYTES.decode().splitlines()

    for index in range(1, len(aware_lines)):
        timestamp, remaining = aware_lines[index].split(",", 1)

        aware_lines[index] = timestamp.replace("00:", "09:", 1) + "+09:00," + remaining

    aware_bytes = ("\n".join(aware_lines) + "\n").encode()

    with application.state.database.session_factory() as database_session:
        user = database_session.scalar(select(User).where(User.username == "alice"))

        dataset, _ = dataset_service.upload_dataset(
            database_session,
            UploadFile(file=BytesIO(aware_bytes), filename="aware.csv"),
            user,
            settings,
        )

    record = create_record(
        client,
        dataset.id,
        start_time="2026-01-01T09:01:00+09:00",
        end_time="2026-01-01T00:05:00Z",
    )

    assert record["start_time"] == "2026-01-01T00:01:00.000000+00:00"
    filtered = client.get(
        "/api/v1/observations",
        params={"dataset_id": dataset.id, "start_time": "2026-01-01T09:05:00+09:00"},
    )

    assert filtered.status_code == 200
    assert filtered.json()["total"] == 1


def test_restart_preserves_account_dataset_observation_and_history(observation_setup):
    client, _, settings, dataset_id = observation_setup

    record = create_record(client, dataset_id)

    path = f"/api/v1/observations/{record['id']}"

    assert (
        client.patch(
            path, json={"revision": 1, "content": "재시작 전 수정"}, headers=HEADERS
        ).status_code
        == 200
    )
    restarted = create_app(settings)

    with TestClient(restarted) as second_client:
        second_client.cookies.update(client.cookies)
        assert second_client.get("/api/v1/auth/me").status_code == 200
        assert second_client.get(path).json()["revision"] == 2
        assert second_client.get(path + "/history").json()["total"] == 2
        assert second_client.get(f"/api/v1/datasets/{dataset_id}/file").content == CSV_BYTES
