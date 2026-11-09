"""실제 라우터로 검토 완료·재검토·입력 검사와 계정별 접근 계약을 확인한다."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import User
from app.security import hash_password

ORIGIN = "http://localhost:5173"

HEADERS = {"Origin": ORIGIN, "X-Requested-With": "kkobugi-web"}

PASSWORD = "review-api-test-only-password"

CSV_BYTES = (
    b"timestamp,sensor_00,sensor_01,label\n"
    b"2026-11-09T00:00:00,1,11,normal\n"
    b"2026-11-09T00:01:00,2,12,abnormal\n"
    b"2026-11-09T00:02:00,3,13,normal\n"
    b"2026-11-09T00:03:00,4,14,abnormal\n"
    b"2026-11-09T00:04:00,5,15,normal\n"
)


@pytest.fixture(scope="session")
def review_api_password_hash():
    return hash_password(PASSWORD)


@pytest.fixture
def review_setup(tmp_path, review_api_password_hash):
    # 별도 DB와 파일 폴더를 써서 실제 사용자의 기록을 검사 자료와 섞지 않는다.
    settings = Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "review.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
        cors_origins=[ORIGIN],
    )

    application = create_app(settings)

    with TestClient(application) as client:
        with application.state.database.session_factory() as session:
            session.add_all(
                [
                    User(
                        username="alice",
                        display_name="검토 작성자",
                        password_hash=review_api_password_hash,
                    ),
                    User(
                        username="bob",
                        display_name="다른 사용자",
                        password_hash=review_api_password_hash,
                    ),
                ]
            )
            session.commit()
        login(client)
        upload = client.post(
            "/api/v1/datasets",
            files={"file": ("review.csv", CSV_BYTES, "text/csv")},
            headers=HEADERS,
        )

        assert upload.status_code == 201
        yield client, settings, upload.json()["dataset"]["id"]


def login(client, username="alice"):
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": PASSWORD},
        headers=HEADERS,
    )

    assert response.status_code == 200


def payload(dataset_id, **changes):
    request_body = {
        "dataset_id": dataset_id,
        "channel": "sensor_00",
        "start_time": "2026-11-09T00:01:00",
        "end_time": "2026-11-09T00:03:00",
        "conclusion": "  현장 기록을 확인했고, 원인은 추가 확인 필요.\n판단은 보류함.  ",
    }

    request_body.update(changes)
    return request_body


def create_review(client, dataset_id, **changes):
    response = client.post("/api/v1/reviews", json=payload(dataset_id, **changes), headers=HEADERS)

    assert response.status_code == 201, response.text
    return response.json()


def create_observation(client, dataset_id):
    response = client.post(
        "/api/v1/observations",
        json={
            "dataset_id": dataset_id,
            "channel": "sensor_00",
            "start_time": "2026-11-09T00:02:00",
            "end_time": "2026-11-09T00:03:00",
            "content": "누수 흔적을 확인함. 원인은 확인 중.",
        },
        headers=HEADERS,
    )

    assert response.status_code == 201, response.text
    return response.json()


def test_complete_freezes_basis_and_reopen_keeps_previous_completion(review_setup):
    client, settings, dataset_id = review_setup

    observation = create_observation(client, dataset_id)

    review = create_review(
        client,
        dataset_id,
        observations=[
            {
                "observation_id": observation["id"],
                "revision": 1,
            }
        ],
    )

    assert review["status"] == "in_progress"
    assert review["judgment"] == "needs_check"
    assert review["conclusion"] == payload(dataset_id)["conclusion"]
    assert review["completed_at"] is None
    assert review["author"]["username"] == "alice"
    completed_response = client.post(
        f"/api/v1/reviews/{review['id']}/complete",
        json={"revision": 1},
        headers=HEADERS,
    )

    assert completed_response.status_code == 200, completed_response.text
    completed = completed_response.json()

    assert completed["status"] == "completed"
    assert completed["revision"] == 2
    assert completed["completed_at"] is not None
    assert completed["completed_by"] == completed["author"]
    # 검토 완료와 이상 확정은 별개라 판단 보류도 완료할 수 있다.
    assert completed["judgment"] == "needs_check"
    assert (
        client.post(
            f"/api/v1/reviews/{review['id']}/complete",
            json={"revision": 2},
            headers=HEADERS,
        ).json()
        == completed
    )
    assert (
        client.patch(
            f"/api/v1/reviews/{review['id']}",
            json={"revision": 2, "conclusion": "잠긴 기록에 덮어쓰기"},
            headers=HEADERS,
        ).status_code
        == 409
    )
    assert (
        client.patch(
            f"/api/v1/observations/{observation['id']}",
            json={"revision": 1, "content": "추가 확인 후 수정한 관찰"},
            headers=HEADERS,
        ).status_code
        == 200
    )
    stored = client.get(f"/api/v1/reviews/{review['id']}").json()

    assert stored["evidence"]["observations"][0] == observation
    reopened_response = client.post(
        f"/api/v1/reviews/{review['id']}/reopen",
        json={"revision": 2, "reason": "현장 관찰이 추가되어 다시 확인"},
        headers=HEADERS,
    )

    assert reopened_response.status_code == 200, reopened_response.text
    reopened = reopened_response.json()

    assert reopened["status"] == "in_progress"
    assert reopened["revision"] == 3
    assert reopened["completed_at"] is None
    assert reopened["completed_by"] is None
    updated_response = client.patch(
        f"/api/v1/reviews/{review['id']}",
        json={"revision": 3, "conclusion": "새 관찰을 확인한 뒤 다시 판단 예정"},
        headers=HEADERS,
    )

    assert updated_response.status_code == 200, updated_response.text
    assert updated_response.json()["evidence"]["observations"][0]["revision"] == 1
    history_response = client.get(f"/api/v1/reviews/{review['id']}/history")

    assert history_response.status_code == 200
    history = history_response.json()

    assert history["total"] == 4
    assert [item["action"] for item in history["items"]] == [
        "updated",
        "reopened",
        "completed",
        "created",
    ]
    assert history["items"][1]["reason"] == "현장 관찰이 추가되어 다시 확인"
    assert history["items"][2]["snapshot"] == completed
    assert (settings.dataset_storage_path / f"{dataset_id}.csv").read_bytes() == CSV_BYTES


@pytest.mark.parametrize(
    ("method", "path", "request_body"),
    [
        ("POST", "", payload("a" * 32)),
        ("GET", "", None),
        ("GET", "/{id}", None),
        ("PATCH", "/{id}", {"revision": 1, "conclusion": "다시 확인"}),
        ("POST", "/{id}/complete", {"revision": 1}),
        ("POST", "/{id}/reopen", {"revision": 1, "reason": "추가 관찰 확인"}),
        ("GET", "/{id}/history", None),
    ],
)
def test_all_review_routes_require_session_and_no_store(review_setup, method, path, request_body):
    client, _, _ = review_setup

    client.cookies.clear()
    response = client.request(
        method,
        "/api/v1/reviews" + path.format(id="a" * 32),
        json=request_body,
        headers=HEADERS,
    )

    assert response.status_code == 401, response.text
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    ("method", "path", "request_body"),
    [
        ("POST", "", payload("a" * 32)),
        ("PATCH", "/{id}", {"revision": 1, "conclusion": "다시 확인"}),
        ("POST", "/{id}/complete", {"revision": 1}),
        ("POST", "/{id}/reopen", {"revision": 1, "reason": "추가 관찰 확인"}),
    ],
)
def test_review_writes_require_trusted_browser(review_setup, method, path, request_body):
    client, _, _ = review_setup

    response = client.request(
        method, "/api/v1/reviews" + path.format(id="a" * 32), json=request_body
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "UNTRUSTED_REQUEST"
    assert response.headers["Cache-Control"] == "no-store"


def test_other_account_cannot_read_change_complete_reopen_or_see_history(review_setup):
    client, _, dataset_id = review_setup

    review = create_review(client, dataset_id)

    login(client, "bob")
    responses = [
        client.get(f"/api/v1/reviews/{review['id']}"),
        client.patch(
            f"/api/v1/reviews/{review['id']}",
            json={"revision": 1, "conclusion": "다른 계정 수정"},
            headers=HEADERS,
        ),
        client.post(
            f"/api/v1/reviews/{review['id']}/complete", json={"revision": 1}, headers=HEADERS
        ),
        client.post(
            f"/api/v1/reviews/{review['id']}/reopen",
            json={"revision": 1, "reason": "다른 계정 재검토"},
            headers=HEADERS,
        ),
        client.get(f"/api/v1/reviews/{review['id']}/history"),
        client.get("/api/v1/reviews", params={"dataset_id": dataset_id}),
    ]

    for response in responses:
        assert response.status_code == 404, response.text
        assert response.headers["Cache-Control"] == "no-store"
    assert client.get("/api/v1/reviews").json()["total"] == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"author_id": 12},
        {"status": "completed"},
        {"channel": " "},
        {"start_time": 0},
        {"start_time": "2026-11-09T01:00:00"},
        {"end_time": "2026-11-09T00:03:00+09:00"},
        {"judgment": "broken"},
        {"conclusion": "x" * 5001},
        {"model_result": {"run_id": "a" * 32, "model_key": "lightgbm", "owner_id": 1}},
        {"observations": [{"observation_id": "b" * 32, "revision": True}]},
        {"observations": [{"observation_id": "b" * 32, "revision": 1}] * 2},
        {
            "observations": [
                {"observation_id": f"{index:032x}", "revision": 1} for index in range(51)
            ]
        },
    ],
)
def test_creation_schema_rejects_ambiguous_or_forged_values(review_setup, changes):
    client, _, dataset_id = review_setup

    response = client.post("/api/v1/reviews", json=payload(dataset_id, **changes), headers=HEADERS)

    assert response.status_code == 422, response.text
    assert client.get("/api/v1/reviews").json()["total"] == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"revision": True, "conclusion": "확인"},
        {"revision": 1.0, "conclusion": "확인"},
        {"revision": 1},
        {"revision": 1, "dataset_id": "b" * 32},
        {"revision": 1, "conclusion": None},
        {"revision": 1, "observations": None},
        {"revision": 1, "start_time": None},
    ],
)
def test_patch_schema_keeps_immutable_context_and_revision_contract(review_setup, changes):
    client, _, dataset_id = review_setup

    review = create_review(client, dataset_id)

    response = client.patch(f"/api/v1/reviews/{review['id']}", json=changes, headers=HEADERS)

    assert response.status_code == 422
    assert client.get(f"/api/v1/reviews/{review['id']}").json() == review
    assert client.get(f"/api/v1/reviews/{review['id']}/history").json()["total"] == 1


def test_list_query_openapi_and_empty_evidence_unlink(review_setup):
    client, _, dataset_id = review_setup

    review = create_review(client, dataset_id)

    changed = client.patch(
        f"/api/v1/reviews/{review['id']}",
        json={"revision": 1, "model_result": None, "observations": []},
        headers=HEADERS,
    )

    assert changed.status_code == 200, changed.text
    assert changed.json()["revision"] == 2
    response = client.get(
        "/api/v1/reviews",
        params={
            "dataset_id": dataset_id,
            "channel": "sensor_00",
            "status": "in_progress",
            "judgment": "needs_check",
            "start_time": "2026-11-09T00:03:00",
            "end_time": "2026-11-09T00:04:00",
            "limit": 1,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 1
    assert response.json()["items"][0]["id"] == review["id"]
    specification = client.get("/openapi.json").json()

    expected_operations = {
        "/api/v1/reviews": {"get", "post"},
        "/api/v1/reviews/{review_id}": {"get", "patch"},
        "/api/v1/reviews/{review_id}/complete": {"post"},
        "/api/v1/reviews/{review_id}/reopen": {"post"},
        "/api/v1/reviews/{review_id}/history": {"get"},
    }

    for path, methods in expected_operations.items():
        assert methods <= set(specification["paths"][path])
    assert "author_id" not in specification["components"]["schemas"]["ReviewCreate"]["properties"]


@pytest.mark.parametrize(
    "query",
    [
        {"status": "done"},
        {"judgment": "broken"},
        {"limit": 101},
        {"offset": -1},
        {"start_time": "not-a-date"},
    ],
)
def test_bad_list_query_returns_standard_error(review_setup, query):
    client, _, _ = review_setup

    response = client.get("/api/v1/reviews", params=query)

    assert response.status_code == 422
    assert response.json()["error"]["code"]
    assert response.headers["Cache-Control"] == "no-store"
