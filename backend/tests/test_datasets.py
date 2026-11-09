"""임시 계정과 CSV로 업로드·검사·소유권·재시작 보존을 확인한다."""

import hashlib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.main import create_app
from app.models import Dataset, User
from app.security import hash_password

FRONTEND_ORIGIN = "http://localhost:5173"

WRITE_HEADERS = {"Origin": FRONTEND_ORIGIN, "X-Requested-With": "kkobugi-web"}

TEST_PASSWORD = "dataset-test-only-password!"

VALID_CSV = (
    b"timestamp,sensor_00,label\n"
    b"2026-01-01 00:00:00,1.25,normal\n"
    b"2026-01-01 00:01:00,2.5,abnormal\n"
    b"2026-01-01 00:02:00,3.75,normal\n"
)


@pytest.fixture(scope="session")
def dataset_password_hash():
    return hash_password(TEST_PASSWORD)


@pytest.fixture
def dataset_settings(tmp_path):
    # DB와 CSV를 모두 테스트별 임시 폴더에 두어 실제 계정·파일을 사용하지 않는다.
    return Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        cors_origins=[FRONTEND_ORIGIN],
    )


def seed_dataset_users(application, password_hash):
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


def login_dataset_user(test_client, username="alice"):
    login_response = test_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": TEST_PASSWORD},
        headers=WRITE_HEADERS,
    )

    assert login_response.status_code == 200
    return login_response.json()["user"]


@pytest.fixture
def dataset_client(dataset_settings, dataset_password_hash):
    application = create_app(dataset_settings)

    with TestClient(application) as test_client:
        seed_dataset_users(application, dataset_password_hash)
        login_dataset_user(test_client)
        yield test_client


def upload_csv(test_client, csv_bytes=VALID_CSV, filename="prepared.csv", form_fields=None):
    return test_client.post(
        "/api/v1/datasets",
        files={"file": (filename, csv_bytes, "text/csv")},
        data=form_fields or {},
        headers=WRITE_HEADERS,
    )


def stored_files(storage_path):
    return sorted(file_path for file_path in storage_path.rglob("*") if file_path.is_file())


def assert_api_error(response, status_code):
    assert response.status_code == status_code
    assert response.json()["error"]["code"]
    assert response.json()["error"]["message"]


def test_every_dataset_endpoint_requires_login(dataset_client):
    dataset_client.cookies.clear()

    responses = [
        upload_csv(dataset_client),
        dataset_client.get("/api/v1/datasets"),
        dataset_client.get("/api/v1/datasets/" + "a" * 32),
        dataset_client.get("/api/v1/datasets/" + "a" * 32 + "/file"),
        dataset_client.post("/api/v1/datasets/" + "a" * 32 + "/reinspect", headers=WRITE_HEADERS),
    ]

    for response in responses:
        assert_api_error(response, 401)


def test_upload_exposes_inspection_and_downloads_unchanged_bytes(dataset_client, dataset_settings):
    upload_response = upload_csv(dataset_client)

    assert upload_response.status_code == 201
    response_data = upload_response.json()

    dataset = response_data["dataset"]

    inspection = response_data["inspection"]

    assert len(dataset["id"]) == 32
    assert dataset["filename"] == "prepared.csv"
    assert dataset["size_bytes"] == len(VALID_CSV)
    assert dataset["sha256"] == hashlib.sha256(VALID_CSV).hexdigest()
    assert dataset["status"] == "valid"
    assert dataset["row_count"] == inspection["row_count"] == 3
    assert dataset["column_count"] == inspection["column_count"] == 3
    assert dataset["channels"] == ["sensor_00"]
    assert inspection["label_counts"] == {"normal": 2, "abnormal": 1}
    assert inspection["missing_counts"] == {"timestamp": 0, "sensor_00": 0, "label": 0}
    assert inspection["is_valid"] is True
    assert inspection["timezone_mode"] == "naive"
    assert not inspection["time_start"].endswith("Z")

    detail_response = dataset_client.get(f"/api/v1/datasets/{dataset['id']}")

    assert detail_response.status_code == 200
    assert detail_response.json() == response_data

    download_response = dataset_client.get(f"/api/v1/datasets/{dataset['id']}/file")

    assert download_response.status_code == 200
    assert download_response.content == VALID_CSV
    assert download_response.headers["cache-control"] == "no-store"
    assert "prepared.csv" in download_response.headers["content-disposition"]
    assert str(dataset_settings.dataset_storage_path) not in upload_response.text
    assert str(dataset_settings.database_path) not in upload_response.text
    assert "password" not in upload_response.text

    original_files = stored_files(dataset_settings.dataset_storage_path)

    assert len(original_files) == 1
    assert original_files[0].name == dataset["id"] + ".csv"
    assert original_files[0].read_bytes() == VALID_CSV


def test_same_file_and_mapping_reuses_dataset_without_another_file(
    dataset_client, dataset_settings
):
    first_response = upload_csv(dataset_client)

    repeated_response = upload_csv(dataset_client, filename="renamed.csv")

    assert first_response.status_code == 201
    assert repeated_response.status_code == 200
    assert repeated_response.json()["dataset"]["id"] == first_response.json()["dataset"]["id"]
    assert len(stored_files(dataset_settings.dataset_storage_path)) == 1
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 1


def test_mapping_is_part_of_dataset_identity(dataset_client):
    first_response = upload_csv(dataset_client)

    remapped_response = upload_csv(
        dataset_client, form_fields={"normal_label": "0", "abnormal_label": "1"}
    )

    assert first_response.status_code == remapped_response.status_code == 201
    assert first_response.json()["dataset"]["id"] != remapped_response.json()["dataset"]["id"]
    assert remapped_response.json()["dataset"]["status"] == "needs_review"
    assert remapped_response.json()["inspection"]["invalid_label_count"] == 3


def test_reinspection_updates_only_derived_results_and_preserves_old_id(
    dataset_client, dataset_settings
):
    source = (
        b"timestamp,sensor_00,machine_status,label\n"
        b"2026-01-01T00:00:00,1,NORMAL,normal\n"
        b"2026-01-01T00:01:00,2,RECOVERING,abnormal\n"
    )

    uploaded = upload_csv(dataset_client, source).json()

    dataset_id = uploaded["dataset"]["id"]

    # 과거 버전이 상태 열을 숫자 채널로 오인했던 저장 결과를 재현한다.
    with dataset_client.app.state.database.session_factory() as session:
        dataset = session.get(Dataset, dataset_id)

        previous = dict(dataset.inspection)

        previous.pop("ignored_columns", None)
        previous["channels"] = ["sensor_00", "machine_status"]
        previous["invalid_numeric_counts"] = {"sensor_00": 0, "machine_status": 2}
        previous["is_valid"] = False
        previous["issues"] = [
            {
                "code": "INVALID_NUMERIC_VALUES",
                "message": "숫자가 아닙니다.",
                "column": "machine_status",
                "count": 2,
                "severity": "error",
            }
        ]
        dataset.inspection = previous
        session.commit()
    assert (
        dataset_client.get(f"/api/v1/datasets/{dataset_id}").json()["dataset"]["status"]
        == "needs_review"
    )
    response = dataset_client.post(
        f"/api/v1/datasets/{dataset_id}/reinspect", headers=WRITE_HEADERS
    )

    assert response.status_code == 200
    result = response.json()

    assert result["dataset"]["id"] == dataset_id
    assert result["dataset"]["sha256"] == uploaded["dataset"]["sha256"]
    assert result["dataset"]["created_at"] == uploaded["dataset"]["created_at"]
    assert result["dataset"]["status"] == "valid"
    assert result["inspection"]["channels"] == ["sensor_00"]
    assert result["inspection"]["ignored_columns"] == ["machine_status"]
    assert dataset_client.get(f"/api/v1/datasets/{dataset_id}/file").content == source
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 1
    assert (dataset_settings.dataset_storage_path / f"{dataset_id}.csv").read_bytes() == source


def test_reinspection_requires_owner_and_trusted_write(dataset_client):
    dataset_id = upload_csv(dataset_client).json()["dataset"]["id"]

    route = f"/api/v1/datasets/{dataset_id}/reinspect"

    assert dataset_client.post(route).status_code == 403
    login_dataset_user(dataset_client, "bob")
    assert dataset_client.post(route, headers=WRITE_HEADERS).status_code == 404


def test_reinspection_rejects_changed_source_without_replacing_saved_inspection(
    dataset_client, dataset_settings
):
    uploaded = upload_csv(dataset_client).json()

    dataset_id = uploaded["dataset"]["id"]

    stored = dataset_settings.dataset_storage_path / f"{dataset_id}.csv"

    stored.write_bytes(VALID_CSV.replace(b"1.25", b"9.99"))
    response = dataset_client.post(
        f"/api/v1/datasets/{dataset_id}/reinspect", headers=WRITE_HEADERS
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "DATASET_CHANGED"
    assert (
        dataset_client.get(f"/api/v1/datasets/{dataset_id}").json()["inspection"]
        == uploaded["inspection"]
    )


def test_new_training_rejects_numeric_metadata_from_old_cached_inspection(dataset_client):
    source = (
        b"timestamp,sensor_00,machine_status,label\n"
        b"2026-01-01T00:00:00,1,0,normal\n"
        b"2026-01-01T00:01:00,2,1,abnormal\n"
        b"2026-01-01T00:02:00,3,0,normal\n"
    )

    dataset_id = upload_csv(dataset_client, source).json()["dataset"]["id"]

    with dataset_client.app.state.database.session_factory() as session:
        dataset = session.get(Dataset, dataset_id)

        previous = dict(dataset.inspection)

        previous["channels"] = ["sensor_00", "machine_status"]
        previous["ignored_columns"] = []
        previous["invalid_numeric_counts"] = {"sensor_00": 0, "machine_status": 0}
        dataset.inspection = previous
        session.commit()
    plan_response = dataset_client.post(
        "/api/v1/training/plan",
        headers=WRITE_HEADERS,
        json={
            "dataset_id": dataset_id,
            "model_key": "xgboost",
            "feature_columns": ["machine_status"],
        },
    )

    run_response = dataset_client.post(
        "/api/v1/runs",
        headers=WRITE_HEADERS,
        json={
            "dataset_id": dataset_id,
            "feature_columns": ["machine_status"],
            "models": ["xgboost"],
            "train_end": "2026-01-01T00:00:00",
            "validation_end": "2026-01-01T00:01:00",
        },
    )

    for response in [plan_response, run_response]:
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "INVALID_FEATURES"
    assert dataset_client.get("/api/v1/runs").json()["total"] == 0


def test_reinspection_detects_change_during_scan(dataset_client, dataset_settings, monkeypatch):
    from app.services import datasets as dataset_service

    uploaded = upload_csv(dataset_client).json()

    dataset_id = uploaded["dataset"]["id"]

    stored = dataset_settings.dataset_storage_path / f"{dataset_id}.csv"

    original_inspector = dataset_service.inspect_csv

    def inspect_and_change(path, **options):
        result = original_inspector(path, **options)

        stored.write_bytes(VALID_CSV.replace(b"1.25", b"9.99"))
        return result

    monkeypatch.setattr(dataset_service, "inspect_csv", inspect_and_change)
    response = dataset_client.post(
        f"/api/v1/datasets/{dataset_id}/reinspect", headers=WRITE_HEADERS
    )

    assert response.status_code == 409
    assert (
        dataset_client.get(f"/api/v1/datasets/{dataset_id}").json()["inspection"]
        == uploaded["inspection"]
    )


@pytest.mark.parametrize(
    "form_fields",
    [
        {"timestamp_column": "label", "label_column": "label"},
        {"normal_label": "same", "abnormal_label": "same"},
    ],
)
def test_conflicting_column_or_label_mapping_is_rejected(
    dataset_client, dataset_settings, form_fields
):
    upload_response = upload_csv(dataset_client, form_fields=form_fields)

    assert_api_error(upload_response, 422)
    assert stored_files(dataset_settings.dataset_storage_path) == []
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 0


@pytest.mark.parametrize(
    "field_name", ["timestamp_column", "label_column", "normal_label", "abnormal_label"]
)
def test_explicit_empty_option_is_rejected_instead_of_using_default(
    dataset_client, dataset_settings, field_name
):
    # 선택을 비운 요청을 기본값으로 저장하면 화면의 설정과 실제 저장값이 달라진다.
    upload_response = upload_csv(dataset_client, form_fields={field_name: ""})

    assert_api_error(upload_response, 422)
    assert upload_response.json()["error"]["code"] == "INVALID_CSV"
    assert stored_files(dataset_settings.dataset_storage_path) == []
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 0


def test_dataset_owner_is_taken_from_current_session(dataset_client):
    current_user = dataset_client.get("/api/v1/auth/me").json()["user"]

    # 소유자 값을 폼에 임의로 넣어도 다른 사람의 데이터로 등록할 수 없어야 한다.
    upload_response = upload_csv(dataset_client, form_fields={"owner_id": "999999"})

    assert upload_response.status_code == 201
    assert upload_response.json()["dataset"]["owner_id"] == current_user["id"]


def test_dataset_list_paginates_only_registered_files(dataset_client):
    dataset_ids = set()

    for sequence in range(3):
        csv_bytes = VALID_CSV.replace(b"1.25", str(sequence + 10).encode())

        upload_response = upload_csv(dataset_client, csv_bytes, filename=f"prepared-{sequence}.csv")

        assert upload_response.status_code == 201
        dataset_ids.add(upload_response.json()["dataset"]["id"])

    first_page = dataset_client.get("/api/v1/datasets", params={"limit": 2, "offset": 0})

    last_page = dataset_client.get("/api/v1/datasets", params={"limit": 2, "offset": 2})

    assert first_page.status_code == last_page.status_code == 200
    assert first_page.json()["total"] == last_page.json()["total"] == 3
    assert first_page.json()["limit"] == 2
    assert last_page.json()["offset"] == 2
    assert len(first_page.json()["items"]) == 2
    assert len(last_page.json()["items"]) == 1
    assert {
        item["id"] for item in first_page.json()["items"] + last_page.json()["items"]
    } == dataset_ids


@pytest.mark.parametrize("query", [{"limit": 0}, {"limit": 101}, {"offset": -1}])
def test_dataset_list_rejects_invalid_page_parameters(dataset_client, query):
    assert_api_error(dataset_client.get("/api/v1/datasets", params=query), 422)


def test_other_account_cannot_read_or_deduplicate_owner_file(dataset_client, dataset_settings):
    alice_dataset = upload_csv(dataset_client).json()["dataset"]

    bob_user = login_dataset_user(dataset_client, "bob")

    assert dataset_client.get("/api/v1/datasets").json()["total"] == 0

    # 없는 파일과 다른 사람의 파일을 같은 응답으로 처리해 존재 여부를 숨긴다.
    for suffix in ("", "/file"):
        private_response = dataset_client.get(f"/api/v1/datasets/{alice_dataset['id']}{suffix}")

        missing_response = dataset_client.get("/api/v1/datasets/" + "f" * 32 + suffix)

        assert_api_error(private_response, 404)
        assert_api_error(missing_response, 404)
        assert private_response.json() == missing_response.json()

    bob_response = upload_csv(dataset_client)

    assert bob_response.status_code == 201
    assert bob_response.json()["dataset"]["id"] != alice_dataset["id"]
    assert bob_response.json()["dataset"]["owner_id"] == bob_user["id"]
    assert len(stored_files(dataset_settings.dataset_storage_path)) == 2


@pytest.mark.parametrize(
    "csv_bytes",
    [
        b"",
        b"timestamp,sensor_00,label\n",
        b"timestamp,sensor_00,sensor_00,label\n2026-01-01,1,2,normal\n",
        b"timestamp,,label\n2026-01-01,1,normal\n",
        b"timestamp,sensor_00\n2026-01-01,1\n",
        b"timestamp,sensor_00,label\n2026-01-01,1,normal,extra\n",
        b"timestamp,sensor_00,label\n2026-01-01,1\n",
        b'timestamp,sensor_00,label\n2026-01-01,"unterminated,normal\n',
        b"timestamp,sensor_00,label\n2026-01-01,\xff,normal\n",
        b"timestamp,label\n2026-01-01,normal\n",
    ],
)
def test_structural_csv_errors_leave_no_registered_file(
    dataset_client, dataset_settings, csv_bytes
):
    upload_response = upload_csv(dataset_client, csv_bytes)

    assert_api_error(upload_response, 422)
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 0
    assert stored_files(dataset_settings.dataset_storage_path) == []


@pytest.mark.parametrize(
    "filename", ["prepared.exe", "prepared.csv.exe", "prepared", "prepared.zip"]
)
def test_non_csv_filename_is_rejected(dataset_client, dataset_settings, filename):
    assert_api_error(upload_csv(dataset_client, filename=filename), 415)
    assert stored_files(dataset_settings.dataset_storage_path) == []


def test_quality_problems_are_reported_without_changing_source(dataset_client):
    csv_bytes = (
        b"timestamp,sensor_00,sensor_01,label\n"
        b"2026-01-01 00:02:00,1,,normal\n"
        b"2026-01-01 00:01:00,nan,2,abnormal\n"
        b"2026-01-01 00:01:00,oops,inf,unknown\n"
        b"not-a-time,3,4,\n"
    )

    upload_response = upload_csv(dataset_client, csv_bytes)

    assert upload_response.status_code == 201
    dataset = upload_response.json()["dataset"]

    inspection = upload_response.json()["inspection"]

    assert dataset["status"] == "needs_review"
    assert inspection["is_valid"] is False
    assert inspection["row_count"] == 4
    assert inspection["invalid_timestamp_count"] == 1
    assert inspection["duplicate_timestamp_count"] == 1
    assert inspection["out_of_order_count"] == 1
    assert inspection["missing_counts"]["sensor_01"] == 1
    assert inspection["missing_counts"]["label"] == 1
    assert inspection["invalid_numeric_counts"] == {"sensor_00": 2, "sensor_01": 1}
    assert inspection["invalid_label_count"] == 1
    assert inspection["label_counts"] == {"normal": 1, "abnormal": 1}
    assert inspection["issues"]
    assert dataset_client.get(f"/api/v1/datasets/{dataset['id']}/file").content == csv_bytes


def test_custom_columns_and_binary_label_mapping_are_explicit(dataset_client):
    csv_bytes = b"observed_at,pressure,state\n2026-01-01,1,0\n2026-01-02,2,1\n"

    upload_response = upload_csv(
        dataset_client,
        csv_bytes,
        form_fields={
            "timestamp_column": "observed_at",
            "label_column": "state",
            "normal_label": "0",
            "abnormal_label": "1",
        },
    )

    assert upload_response.status_code == 201
    assert upload_response.json()["dataset"]["status"] == "valid"
    assert upload_response.json()["dataset"]["channels"] == ["pressure"]
    assert upload_response.json()["inspection"]["label_counts"] == {"0": 1, "1": 1}


def test_numeric_labels_are_not_guessed_as_normal_and_abnormal(dataset_client):
    csv_bytes = b"timestamp,pressure,label\n2026-01-01,1,0\n2026-01-02,2,1\n"

    upload_response = upload_csv(dataset_client, csv_bytes)

    assert upload_response.status_code == 201
    assert upload_response.json()["dataset"]["status"] == "needs_review"
    assert upload_response.json()["inspection"]["invalid_label_count"] == 2


@pytest.mark.parametrize("filename", ["../../outside.csv", r"C:\temp\..\outside.CSV"])
def test_client_filename_cannot_choose_server_path(dataset_client, dataset_settings, filename):
    upload_response = upload_csv(dataset_client, filename=filename)

    assert upload_response.status_code == 201
    dataset = upload_response.json()["dataset"]

    original_files = stored_files(dataset_settings.dataset_storage_path)

    assert len(original_files) == 1
    assert original_files[0].parent == dataset_settings.dataset_storage_path
    assert original_files[0].name == dataset["id"] + ".csv"
    assert "/" not in dataset["filename"] and "\\" not in dataset["filename"]
    assert original_files[0].read_bytes() == VALID_CSV


def test_utf8_bom_is_supported_and_preserved(dataset_client):
    csv_bytes = b"\xef\xbb\xbf" + VALID_CSV

    upload_response = upload_csv(dataset_client, csv_bytes)

    assert upload_response.status_code == 201
    dataset = upload_response.json()["dataset"]

    assert dataset["status"] == "valid"
    assert dataset["timestamp_column"] == "timestamp"
    assert dataset["sha256"] == hashlib.sha256(csv_bytes).hexdigest()
    assert dataset_client.get(f"/api/v1/datasets/{dataset['id']}/file").content == csv_bytes


@pytest.mark.parametrize(
    "headers",
    [{}, {"Origin": FRONTEND_ORIGIN}, {**WRITE_HEADERS, "Origin": "https://untrusted.example"}],
)
def test_csv_upload_requires_trusted_browser_request(dataset_client, dataset_settings, headers):
    upload_response = dataset_client.post(
        "/api/v1/datasets",
        files={"file": ("prepared.csv", VALID_CSV, "text/csv")},
        headers=headers,
    )

    assert_api_error(upload_response, 403)
    assert stored_files(dataset_settings.dataset_storage_path) == []


def test_json_request_cannot_replace_required_multipart_file(dataset_client):
    upload_response = dataset_client.post(
        "/api/v1/datasets", json={"file": "prepared.csv"}, headers=WRITE_HEADERS
    )

    assert_api_error(upload_response, 422)


def test_file_size_limit_removes_partial_upload(dataset_settings, dataset_password_hash):
    limited_settings = dataset_settings.model_copy(update={"max_upload_bytes": 32})

    with TestClient(create_app(limited_settings)) as test_client:
        seed_dataset_users(test_client.app, dataset_password_hash)
        login_dataset_user(test_client)
        assert_api_error(upload_csv(test_client), 413)
        assert stored_files(limited_settings.dataset_storage_path) == []
        assert test_client.get("/api/v1/datasets").json()["total"] == 0


def test_row_limit_removes_rejected_upload(dataset_settings, dataset_password_hash):
    limited_settings = dataset_settings.model_copy(update={"max_dataset_rows": 2})

    with TestClient(create_app(limited_settings)) as test_client:
        seed_dataset_users(test_client.app, dataset_password_hash)
        login_dataset_user(test_client)
        assert_api_error(upload_csv(test_client), 413)
        assert stored_files(limited_settings.dataset_storage_path) == []


def test_column_limit_removes_rejected_upload(dataset_settings, dataset_password_hash):
    limited_settings = dataset_settings.model_copy(update={"max_dataset_columns": 2})

    with TestClient(create_app(limited_settings)) as test_client:
        seed_dataset_users(test_client.app, dataset_password_hash)
        login_dataset_user(test_client)
        assert_api_error(upload_csv(test_client), 422)
        assert stored_files(limited_settings.dataset_storage_path) == []


@pytest.mark.parametrize("declared_size", [None, "1"])
def test_request_limit_checks_received_bytes_instead_of_trusting_content_length(
    dataset_settings, dataset_password_hash, declared_size
):
    limited_settings = dataset_settings.model_copy(update={"max_upload_bytes": 64})

    multipart_boundary = "dataset-boundary"

    request_body = (
        (
            f"--{multipart_boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="prepared.csv"\r\n'
            "Content-Type: text/csv\r\n\r\n"
        ).encode()
        + b"x" * (1024 * 1024 + 1024)
        + f"\r\n--{multipart_boundary}--\r\n".encode()
    )

    request_headers = {
        **WRITE_HEADERS,
        "Content-Type": f"multipart/form-data; boundary={multipart_boundary}",
    }

    if declared_size is not None:
        request_headers["Content-Length"] = declared_size

    with TestClient(create_app(limited_settings)) as test_client:
        seed_dataset_users(test_client.app, dataset_password_hash)
        login_dataset_user(test_client)

        # 1바이트라고 거짓으로 선언하거나 크기를 생략해도 실제 수신량을 확인해야 한다.
        upload_response = test_client.post(
            "/api/v1/datasets", content=iter([request_body]), headers=request_headers
        )

        assert_api_error(upload_response, 413)
        assert stored_files(limited_settings.dataset_storage_path) == []


def test_dataset_file_account_and_session_survive_server_restart(
    dataset_settings, dataset_password_hash
):
    with TestClient(create_app(dataset_settings)) as first_client:
        seed_dataset_users(first_client.app, dataset_password_hash)
        original_user = login_dataset_user(first_client)

        upload_response = upload_csv(first_client)

        assert upload_response.status_code == 201
        original_result = upload_response.json()

        session_token = first_client.cookies[dataset_settings.cookie_name]

    # 같은 DB와 파일 경로로 새 앱을 열어, 실제 프로세스 재생성과 같은 상태를 확인한다.
    with TestClient(create_app(dataset_settings)) as restarted_client:
        restarted_client.cookies.set(dataset_settings.cookie_name, session_token)
        assert restarted_client.get("/api/v1/auth/me").json()["user"] == original_user
        assert restarted_client.get("/api/v1/datasets").json()["total"] == 1
        assert (
            restarted_client.get(f"/api/v1/datasets/{original_result['dataset']['id']}").json()
            == original_result
        )
        assert (
            restarted_client.get(
                f"/api/v1/datasets/{original_result['dataset']['id']}/file"
            ).content
            == VALID_CSV
        )

        with restarted_client.app.state.database.session_factory() as database_session:
            stored_users = database_session.scalars(select(User)).all()

            assert len(stored_users) == 2


def test_openapi_defines_upload_and_public_dataset_contract(dataset_client, dataset_settings):
    openapi_schema = dataset_client.get("/openapi.json").json()

    upload_operation = openapi_schema["paths"]["/api/v1/datasets"]["post"]

    upload_schema = upload_operation["requestBody"]["content"]["multipart/form-data"]["schema"]

    if "$ref" in upload_schema:
        schema_name = upload_schema["$ref"].rsplit("/", 1)[-1]

        upload_schema = openapi_schema["components"]["schemas"][schema_name]

    assert "file" in upload_schema["required"]
    file_schema = upload_schema["properties"]["file"]

    # OpenAPI 버전에 따라 파일을 binary 형식 또는 바이트 미디어 유형으로 표현한다.
    assert file_schema["type"] == "string"
    assert (
        file_schema.get("format") == "binary"
        or file_schema.get("contentMediaType") == "application/octet-stream"
    )
    assert upload_schema["properties"]["timestamp_column"]["default"] == "timestamp"
    assert upload_schema["properties"]["label_column"]["default"] == "label"
    assert upload_schema["properties"]["normal_label"]["default"] == "normal"
    assert upload_schema["properties"]["abnormal_label"]["default"] == "abnormal"
    assert "201" in upload_operation["responses"]
    assert "200" in upload_operation["responses"]
    assert "/api/v1/datasets/{dataset_id}" in openapi_schema["paths"]
    assert "/api/v1/datasets/{dataset_id}/file" in openapi_schema["paths"]
    assert str(dataset_settings.dataset_storage_path) not in str(openapi_schema)
    assert str(dataset_settings.database_path) not in str(openapi_schema)
