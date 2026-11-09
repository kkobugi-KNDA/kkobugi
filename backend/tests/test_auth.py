"""인증 상태는 임시 SQLite 파일에만 저장하는 API 통합 테스트."""

import time
from typing import Annotated

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.auth import get_current_user
from app.config import Settings
from app.main import create_app
from app.models import LoginAttempt, LoginSession, User
from app.security import hash_password, hash_token

ORIGIN = "http://localhost:5173"
COOKIE_NAME = "kkobugi_session"
WRITE_HEADERS = {"Origin": ORIGIN, "X-Requested-With": "kkobugi-web"}
ALICE_PASSWORD = "test-only-alice-password!"
BOB_PASSWORD = "test-only-bob-password!"


@pytest.fixture(scope="session")
def test_password_hashes():
    return {
        "alice": hash_password(ALICE_PASSWORD),
        "bob": hash_password(BOB_PASSWORD),
    }


@pytest.fixture
def auth_settings(tmp_path):
    return Settings(
        _env_file=None,
        database_path=tmp_path / "auth.sqlite3",
        cors_origins=[ORIGIN],
        session_ttl_seconds=43_200,
        cookie_secure=False,
        login_max_attempts=5,
        login_window_seconds=900,
    )


def seed_users(application, password_hashes):
    with application.state.database.session_factory() as database_session:
        database_session.add_all(
            [
                User(
                    username="alice",
                    display_name="테스트 사용자 하나",
                    password_hash=password_hashes["alice"],
                    is_active=True,
                    created_at=int(time.time()),
                ),
                User(
                    username="bob",
                    display_name="테스트 사용자 둘",
                    password_hash=password_hashes["bob"],
                    is_active=True,
                    created_at=int(time.time()),
                ),
            ]
        )
        database_session.commit()


@pytest.fixture
def auth_client(auth_settings, test_password_hashes):
    application = create_app(auth_settings)
    with TestClient(application) as client:
        seed_users(application, test_password_hashes)
        yield client


def login(client, username="alice", password=ALICE_PASSWORD):
    return client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
        headers=WRITE_HEADERS,
    )


def assert_error(response, status):
    assert response.status_code == status
    assert response.headers["cache-control"] == "no-store"
    error = response.json()["error"]
    assert isinstance(error["code"], str) and error["code"]
    assert isinstance(error["message"], str) and error["message"]
    return error


def test_me_requires_a_valid_session(auth_client):
    assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_current_user_dependency_protects_another_api(auth_client):
    @auth_client.app.get("/api/v1/test-protected")
    def protected_api(user: Annotated[User, Depends(get_current_user)]):
        return {"username": user.username}

    unauthenticated = auth_client.get("/api/v1/test-protected")
    assert unauthenticated.status_code == 401
    assert unauthenticated.json()["error"]["code"] == "UNAUTHENTICATED"

    assert login(auth_client).status_code == 200
    authenticated = auth_client.get("/api/v1/test-protected")
    assert authenticated.status_code == 200
    assert authenticated.json() == {"username": "alice"}

    assert auth_client.post("/api/v1/auth/logout", headers=WRITE_HEADERS).status_code == 204
    logged_out = auth_client.get("/api/v1/test-protected")
    assert logged_out.status_code == 401
    assert logged_out.json()["error"]["code"] == "UNAUTHENTICATED"


def test_login_sets_private_cookie_and_returns_public_user(auth_client):
    response = login(auth_client)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    payload = response.json()
    assert set(payload) == {"user", "expires_in"}
    assert payload["expires_in"] == 43_200
    assert set(payload["user"]) == {"id", "username", "display_name"}
    assert payload["user"]["username"] == "alice"
    assert payload["user"]["display_name"] == "테스트 사용자 하나"
    cookie = response.headers["set-cookie"].lower()
    assert f"{COOKIE_NAME}=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "max-age=43200" in cookie
    assert "path=/" in cookie
    assert "secure" not in cookie

    me = auth_client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.headers["cache-control"] == "no-store"
    assert me.json()["user"] == payload["user"]
    assert 0 < me.json()["expires_in"] <= 43_200
    for response_body in (response.text, me.text):
        assert ALICE_PASSWORD not in response_body
        assert "password_hash" not in response_body
        assert auth_client.cookies[COOKIE_NAME] not in response_body


def test_database_stores_only_the_session_token_hash(auth_client):
    assert login(auth_client).status_code == 200
    token = auth_client.cookies[COOKIE_NAME]
    with auth_client.app.state.database.session_factory() as database_session:
        stored = database_session.scalar(select(LoginSession))
        assert stored is not None
        assert stored.token_hash == hash_token(token)
        assert stored.token_hash != token
        assert len(stored.token_hash) == 64
        assert stored.expires_at - stored.created_at == 43_200
        assert database_session.scalar(select(User)).password_hash != ALICE_PASSWORD

    database_bytes = auth_client.app.state.settings.database_path.read_bytes()
    assert token.encode() not in database_bytes
    assert ALICE_PASSWORD.encode() not in database_bytes


def test_wrong_password_and_unknown_username_have_same_generic_error(auth_client):
    wrong_password = login(auth_client, password="test-only-wrong-password")
    unknown_user = login(auth_client, username="unknown", password="test-only-wrong-password")

    assert assert_error(wrong_password, 401) == assert_error(unknown_user, 401)
    assert "test-only-wrong-password" not in wrong_password.text
    assert "unknown" not in unknown_user.text
    assert COOKIE_NAME not in auth_client.cookies
    with auth_client.app.state.database.session_factory() as database_session:
        assert database_session.scalar(select(LoginSession)) is None


def test_disabled_user_cannot_login_or_use_an_existing_session(auth_client):
    assert login(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        user = database_session.scalar(select(User).where(User.username == "alice"))
        user.is_active = False
        database_session.commit()

    assert_error(auth_client.get("/api/v1/auth/me"), 401)
    assert_error(login(auth_client), 401)


def test_validation_error_never_echoes_password_input(auth_client):
    secret = "test-only-sensitive-invalid-password-input"
    response = auth_client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": {"invalid": secret}},
        headers=WRITE_HEADERS,
    )

    assert_error(response, 422)
    assert secret not in response.text
    assert '"input"' not in response.text


def test_logout_revokes_session_clears_cookie_and_is_idempotent(auth_client):
    assert login(auth_client).status_code == 200
    old_token = auth_client.cookies[COOKIE_NAME]
    response = auth_client.post("/api/v1/auth/logout", headers=WRITE_HEADERS)

    assert response.status_code == 204
    assert response.headers["cache-control"] == "no-store"
    assert response.content == b""
    assert COOKIE_NAME not in auth_client.cookies
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert_error(auth_client.get("/api/v1/auth/me"), 401)
    assert auth_client.post("/api/v1/auth/logout", headers=WRITE_HEADERS).status_code == 204
    with auth_client.app.state.database.session_factory() as database_session:
        assert database_session.scalar(select(LoginSession)) is None

    auth_client.cookies.set(COOKIE_NAME, old_token)
    assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_expired_session_is_rejected_without_waiting(auth_client):
    assert login(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        stored = database_session.scalar(select(LoginSession))
        stored.expires_at = int(time.time()) - 1
        database_session.commit()

    assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_user_and_session_survive_server_restart(auth_settings, test_password_hashes):
    first_application = create_app(auth_settings)
    with TestClient(first_application) as first_client:
        seed_users(first_application, test_password_hashes)
        response = login(first_client)
        assert response.status_code == 200
        public_user = response.json()["user"]
        token = first_client.cookies[COOKIE_NAME]

    with TestClient(create_app(auth_settings)) as restarted_client:
        restarted_client.cookies.set(COOKIE_NAME, token)
        response = restarted_client.get("/api/v1/auth/me")
        assert response.status_code == 200
        assert response.json()["user"] == public_user
        with restarted_client.app.state.database.session_factory() as database_session:
            assert len(database_session.scalars(select(User)).all()) == 2
            assert len(database_session.scalars(select(LoginSession)).all()) == 1


def test_login_rotates_current_session_and_preserves_other_browser(auth_client, auth_settings):
    assert login(auth_client).status_code == 200
    old_token = auth_client.cookies[COOKIE_NAME]

    with TestClient(create_app(auth_settings)) as other_browser:
        assert login(other_browser).status_code == 200
        other_token = other_browser.cookies[COOKIE_NAME]
        assert login(auth_client).status_code == 200
        new_token = auth_client.cookies[COOKIE_NAME]
        assert new_token not in {old_token, other_token}
        assert auth_client.get("/api/v1/auth/me").status_code == 200
        assert other_browser.get("/api/v1/auth/me").status_code == 200
        with auth_client.app.state.database.session_factory() as database_session:
            active_hashes = set(database_session.scalars(select(LoginSession.token_hash)).all())
            assert active_hashes == {hash_token(new_token), hash_token(other_token)}

        auth_client.cookies.clear()
        auth_client.cookies.set(COOKIE_NAME, old_token)
        assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_logout_preserves_other_browser_session(auth_client, auth_settings):
    assert login(auth_client).status_code == 200
    with TestClient(create_app(auth_settings)) as other_browser:
        assert login(other_browser).status_code == 200
        other_token = other_browser.cookies[COOKIE_NAME]
        assert auth_client.post("/api/v1/auth/logout", headers=WRITE_HEADERS).status_code == 204
        assert other_browser.get("/api/v1/auth/me").status_code == 200
        with auth_client.app.state.database.session_factory() as database_session:
            assert database_session.scalars(select(LoginSession.token_hash)).all() == [
                hash_token(other_token)
            ]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Requested-With": "kkobugi-web"},
        {"Origin": ORIGIN},
        {"Origin": "https://untrusted.example", "X-Requested-With": "kkobugi-web"},
        {"Origin": "null", "X-Requested-With": "kkobugi-web"},
        {"Origin": ORIGIN, "X-Requested-With": "another-client"},
    ],
)
def test_login_and_logout_require_trusted_origin_and_request_header(auth_client, headers):
    assert login(auth_client).status_code == 200
    login_response = auth_client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": ALICE_PASSWORD},
        headers=headers,
    )
    logout_response = auth_client.post("/api/v1/auth/logout", headers=headers)

    assert_error(login_response, 403)
    assert_error(logout_response, 403)
    assert auth_client.get("/api/v1/auth/me").status_code == 200


@pytest.mark.parametrize("content_type", [None, "text/plain", "application/x-www-form-urlencoded"])
def test_login_requires_json_content_type(auth_client, content_type):
    headers = dict(WRITE_HEADERS)
    if content_type is not None:
        headers["Content-Type"] = content_type
    response = auth_client.post(
        "/api/v1/auth/login",
        content='{"username":"alice","password":"test-only-alice-password!"}',
        headers=headers,
    )

    assert_error(response, 415)
    assert COOKIE_NAME not in auth_client.cookies


@pytest.mark.parametrize("content_type", [None, "text/plain"])
def test_login_checks_content_type_before_parsing_malformed_json(auth_client, content_type):
    headers = dict(WRITE_HEADERS)
    if content_type is not None:
        headers["Content-Type"] = content_type
    response = auth_client.post(
        "/api/v1/auth/login",
        content='{"username":"alice","password":',
        headers=headers,
    )

    assert_error(response, 415)
    assert COOKIE_NAME not in auth_client.cookies


def test_auth_cors_preflight_allows_browser_request_header(auth_client):
    response = auth_client.options(
        "/api/v1/auth/login",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-requested-with",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    assert "x-requested-with" in response.headers["access-control-allow-headers"].lower()


def test_login_limit_is_per_account_and_resets_after_window(auth_client):
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    limited = login(auth_client)
    assert_error(limited, 429)
    assert 0 < int(limited.headers["retry-after"]) <= 900

    assert login(auth_client, username="bob", password=BOB_PASSWORD).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        attempts = database_session.scalars(select(LoginAttempt)).all()
        assert attempts
        for attempt in attempts:
            attempt.window_start = int(time.time()) - 901
        database_session.commit()

    assert login(auth_client).status_code == 200
    assert_error(login(auth_client, password="test-only-wrong-password"), 401)


def test_successful_login_resets_previous_failures(auth_client):
    for _ in range(4):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    assert login(auth_client).status_code == 200
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    assert_error(login(auth_client, password="test-only-wrong-password"), 429)


def test_login_limit_uses_client_ip_without_trusting_forwarded_header(auth_client, auth_settings):
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    spoofed = auth_client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": ALICE_PASSWORD},
        headers={**WRITE_HEADERS, "X-Forwarded-For": "192.0.2.50"},
    )
    assert_error(spoofed, 429)

    with TestClient(create_app(auth_settings), client=("192.0.2.51", 50000)) as another_ip:
        assert login(another_ip).status_code == 200


def test_secure_cookie_can_be_used_over_https(auth_settings, test_password_hashes):
    secure_settings = auth_settings.model_copy(update={"cookie_secure": True})
    application = create_app(secure_settings)
    with TestClient(application, base_url="https://testserver") as client:
        seed_users(application, test_password_hashes)
        response = login(client)
        assert response.status_code == 200
        cookie = response.headers["set-cookie"].lower()
        assert "; secure" in cookie
        assert "httponly" in cookie
        assert "samesite=lax" in cookie
        assert client.get("/api/v1/auth/me").status_code == 200
