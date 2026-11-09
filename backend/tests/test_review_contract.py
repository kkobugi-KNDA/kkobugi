"""화면 연결에 쓰는 구간·관찰 API의 공통 인증과 문서 계약을 확인한다."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import User
from app.security import hash_password

WRITE_HEADERS = {"Origin": "http://localhost:5173", "X-Requested-With": "kkobugi-web"}

TEST_PASSWORD = "review-contract-test-only!"


@pytest.fixture
def review_client(tmp_path):
    # 실제 계정·CSV·모델에 테스트 기록이 섞이지 않도록 저장 위치를 모두 분리한다.
    settings = Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "review.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
    )

    application = create_app(settings)

    with TestClient(application) as client:
        with application.state.database.session_factory() as session:
            session.add(User(
                username="reviewer", display_name="관찰 계약 테스트",
                password_hash=hash_password(TEST_PASSWORD),
            ))
            session.commit()
        yield client


def login(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"username": "reviewer", "password": TEST_PASSWORD},
        headers=WRITE_HEADERS,
    )

    assert response.status_code == 200


def observation_body(dataset_id):
    return {
        "dataset_id": dataset_id,
        "channel": "sensor_04",
        "start_time": "2026-11-09T01:00:00",
        "end_time": "2026-11-09T01:01:00",
        "content": "누수 위치 추가 확인 필요",
    }


@pytest.mark.parametrize(("method", "path", "body"), [
    ("GET", "/datasets/{id}/series?channels=sensor_04", None),
    ("GET", "/datasets/{id}/label-intervals", None),
    ("GET", "/runs/{id}/predictions", None),
    ("GET", "/runs/{id}/prediction-intervals", None),
    ("GET", "/observations", None),
    ("POST", "/observations", observation_body("a" * 32)),
    ("GET", "/observations/{id}", None),
    ("PATCH", "/observations/{id}", {"revision": 1, "content": "추가 확인"}),
    ("GET", "/observations/{id}/history", None),
])
def test_review_endpoints_require_session_and_never_cache(review_client, method, path, body):
    response = review_client.request(
        method, "/api/v1" + path.format(id="a" * 32), json=body, headers=WRITE_HEADERS,
    )

    assert response.status_code == 401, response.text
    assert response.headers["Cache-Control"] == "no-store"


def test_openapi_has_nine_review_operations_and_current_training_models(review_client):
    specification = review_client.get("/openapi.json").json()

    expected_operations = {
        "/api/v1/datasets/{dataset_id}/series": {"get"},
        "/api/v1/datasets/{dataset_id}/label-intervals": {"get"},
        "/api/v1/runs/{run_id}/predictions": {"get"},
        "/api/v1/runs/{run_id}/prediction-intervals": {"get"},
        "/api/v1/observations": {"get", "post"},
        "/api/v1/observations/{observation_id}": {"get", "patch"},
        "/api/v1/observations/{observation_id}/history": {"get"},
    }

    for path, methods in expected_operations.items():
        assert methods <= set(specification["paths"][path])
    request_schema = specification["paths"]["/api/v1/runs"]["post"]["requestBody"][
        "content"
    ]["application/json"]["schema"]["$ref"].rsplit("/", 1)[-1]

    model_keys = specification["components"]["schemas"][request_schema]["properties"][
        "models"
    ]["items"]["enum"]

    assert set(model_keys) == {"xgboost", "lightgbm", "autoencoder"}


def test_observation_writes_check_origin_and_keep_source_label_separate(review_client):
    login(review_client)
    original_csv = (
        b"timestamp,sensor_04,label\n"
        b"2026-11-09T01:00:00,4,normal\n"
        b"2026-11-09T01:01:00,5,abnormal\n"
        b"2026-11-09T01:02:00,6,normal\n"
    )

    upload = review_client.post(
        "/api/v1/datasets", files={"file": ("review.csv", original_csv, "text/csv")},
        headers=WRITE_HEADERS,
    )

    assert upload.status_code == 201, upload.text
    dataset_id = upload.json()["dataset"]["id"]

    body = observation_body(dataset_id)

    untrusted = review_client.post("/api/v1/observations", json=body)

    assert untrusted.status_code == 403
    assert untrusted.headers["Cache-Control"] == "no-store"
    created = review_client.post("/api/v1/observations", json=body, headers=WRITE_HEADERS)

    assert created.status_code == 201, created.text
    observation = created.json()

    patched = review_client.patch(
        f"/api/v1/observations/{observation['id']}",
        json={"revision": 1, "judgment": "normal", "content": "현장에서는 정상으로 판단"},
        headers=WRITE_HEADERS,
    )

    assert patched.status_code == 200, patched.text
    assert patched.json()["revision"] == 2
    assert patched.headers["Cache-Control"] == "no-store"
    assert review_client.get(f"/api/v1/datasets/{dataset_id}/file").content == original_csv
    labels = review_client.get(f"/api/v1/datasets/{dataset_id}/label-intervals").json()

    # 사람 판단을 정상으로 바꿔도 원본의 이상 라벨과 그 시간은 보존한다.
    assert labels["total"] == 1
    assert labels["items"][0]["start_row"] == 1
    history = review_client.get(f"/api/v1/observations/{observation['id']}/history")

    assert history.status_code == 200
    assert history.json()["total"] == 2
    assert history.headers["Cache-Control"] == "no-store"
