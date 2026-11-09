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

FRONTEND_ORIGIN = "http://localhost:5173"

COOKIE_NAME = "kkobugi_session"

AUTH_REQUEST_HEADERS = {"Origin": FRONTEND_ORIGIN, "X-Requested-With": "kkobugi-web"}

ALICE_PASSWORD = "test-only-alice-password!"

BOB_PASSWORD = "test-only-bob-password!"


@pytest.fixture(scope="session")
def test_password_hashes():
    # 비밀번호 해시는 테스트 실행 중 재사용하고, 실제 사용자 정보는 사용하지 않는다.
    return {
        "alice": hash_password(ALICE_PASSWORD),
        "bob": hash_password(BOB_PASSWORD),
    }


@pytest.fixture
def auth_settings(tmp_path):
    # 각 테스트는 별도 SQLite 파일을 사용하므로 이전 테스트의 로그인 제한에 영향받지 않는다.
    return Settings(
        _env_file=None,
        database_path=tmp_path / "auth.sqlite3",
        cors_origins=[FRONTEND_ORIGIN],
        session_ttl_seconds=43_200,
        cookie_secure=False,
        login_max_attempts=5,
        login_window_seconds=900,
    )


def seed_users(test_application, password_hashes):
    # 서로 다른 두 계정을 만들어 계정별 세션과 실패 횟수 분리를 확인한다.
    with test_application.state.database.session_factory() as database_session:
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
    test_application = create_app(auth_settings)

    with TestClient(test_application) as test_client:
        seed_users(test_application, test_password_hashes)
        yield test_client


def login(test_client, username="alice", password=ALICE_PASSWORD):
    return test_client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
        headers=AUTH_REQUEST_HEADERS,
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
    # 인증 의존성을 새 API에 붙이기만 해도 로그인 여부를 검사해야 한다.
    @auth_client.app.get("/api/v1/test-protected")
    def protected_api(current_user: Annotated[User, Depends(get_current_user)]):
        return {"username": current_user.username}

    unauthenticated_response = auth_client.get("/api/v1/test-protected")

    assert unauthenticated_response.status_code == 401
    assert unauthenticated_response.json()["error"]["code"] == "UNAUTHENTICATED"

    assert login(auth_client).status_code == 200
    authenticated_response = auth_client.get("/api/v1/test-protected")

    assert authenticated_response.status_code == 200
    assert authenticated_response.json() == {"username": "alice"}

    assert auth_client.post("/api/v1/auth/logout", headers=AUTH_REQUEST_HEADERS).status_code == 204
    logged_out_response = auth_client.get("/api/v1/test-protected")

    assert logged_out_response.status_code == 401
    assert logged_out_response.json()["error"]["code"] == "UNAUTHENTICATED"


def test_login_sets_private_cookie_and_returns_public_user(auth_client):
    # 로그인 응답에는 공개 사용자 정보만, 세션 토큰은 HttpOnly 쿠키에만 담겨야 한다.
    response = login(auth_client)

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    response_data = response.json()

    assert set(response_data) == {"user", "expires_in"}
    assert response_data["expires_in"] == 43_200
    assert set(response_data["user"]) == {"id", "username", "display_name"}
    assert response_data["user"]["username"] == "alice"
    assert response_data["user"]["display_name"] == "테스트 사용자 하나"
    cookie_header = response.headers["set-cookie"].lower()

    assert f"{COOKIE_NAME}=" in cookie_header
    assert "httponly" in cookie_header
    assert "samesite=lax" in cookie_header
    assert "max-age=43200" in cookie_header
    assert "path=/" in cookie_header
    assert "secure" not in cookie_header

    current_user_response = auth_client.get("/api/v1/auth/me")

    assert current_user_response.status_code == 200
    assert current_user_response.headers["cache-control"] == "no-store"
    assert current_user_response.json()["user"] == response_data["user"]
    assert 0 < current_user_response.json()["expires_in"] <= 43_200
    for response_body in (response.text, current_user_response.text):
        assert ALICE_PASSWORD not in response_body
        assert "password_hash" not in response_body
        assert auth_client.cookies[COOKIE_NAME] not in response_body


def test_database_stores_only_the_session_token_hash(auth_client):
    # DB가 유출돼도 원본 세션 토큰과 비밀번호가 그대로 드러나지 않아야 한다.
    assert login(auth_client).status_code == 200
    session_token = auth_client.cookies[COOKIE_NAME]

    with auth_client.app.state.database.session_factory() as database_session:
        stored_session = database_session.scalar(select(LoginSession))

        assert stored_session is not None
        assert stored_session.token_hash == hash_token(session_token)
        assert stored_session.token_hash != session_token
        assert len(stored_session.token_hash) == 64
        assert stored_session.expires_at - stored_session.created_at == 43_200
        assert database_session.scalar(select(User)).password_hash != ALICE_PASSWORD

    database_bytes = auth_client.app.state.settings.database_path.read_bytes()

    assert session_token.encode() not in database_bytes
    assert ALICE_PASSWORD.encode() not in database_bytes


def test_wrong_password_and_unknown_username_have_same_generic_error(auth_client):
    # 실패 응답만으로 어떤 아이디가 존재하는지 알아낼 수 없어야 한다.
    wrong_password_response = login(auth_client, password="test-only-wrong-password")

    unknown_user_response = login(
        auth_client, username="unknown", password="test-only-wrong-password"
    )

    assert assert_error(wrong_password_response, 401) == assert_error(unknown_user_response, 401)
    assert "test-only-wrong-password" not in wrong_password_response.text
    assert "unknown" not in unknown_user_response.text
    assert COOKIE_NAME not in auth_client.cookies
    with auth_client.app.state.database.session_factory() as database_session:
        assert database_session.scalar(select(LoginSession)) is None


def test_disabled_user_cannot_login_or_use_an_existing_session(auth_client):
    # 이미 로그인했더라도 계정이 비활성화되면 다음 인증부터 거부한다.
    assert login(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        current_user = database_session.scalar(select(User).where(User.username == "alice"))

        current_user.is_active = False

        database_session.commit()

    assert_error(auth_client.get("/api/v1/auth/me"), 401)
    assert_error(login(auth_client), 401)


def test_validation_error_never_echoes_password_input(auth_client):
    # 비밀번호 형식이 틀렸을 때도 입력 원문을 오류 메시지에 포함하지 않는다.
    invalid_password = "test-only-sensitive-invalid-password-input"

    response = auth_client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": {"invalid": invalid_password}},
        headers=AUTH_REQUEST_HEADERS,
    )

    assert_error(response, 422)
    assert invalid_password not in response.text
    assert '"input"' not in response.text


def test_logout_revokes_session_clears_cookie_and_is_idempotent(auth_client):
    # 쿠키만 지우는 것이 아니라 DB의 세션도 폐기해야 이전 토큰 재사용을 막을 수 있다.
    assert login(auth_client).status_code == 200
    previous_session_token = auth_client.cookies[COOKIE_NAME]

    response = auth_client.post("/api/v1/auth/logout", headers=AUTH_REQUEST_HEADERS)

    assert response.status_code == 204
    assert response.headers["cache-control"] == "no-store"
    assert response.content == b""
    assert COOKIE_NAME not in auth_client.cookies
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert_error(auth_client.get("/api/v1/auth/me"), 401)
    assert auth_client.post("/api/v1/auth/logout", headers=AUTH_REQUEST_HEADERS).status_code == 204
    with auth_client.app.state.database.session_factory() as database_session:
        assert database_session.scalar(select(LoginSession)) is None

    auth_client.cookies.set(COOKIE_NAME, previous_session_token)
    assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_expired_session_is_rejected_without_waiting(auth_client):
    # 실제 12시간을 기다리지 않고 저장된 만료 시각을 과거로 바꿔 확인한다.
    assert login(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        stored_session = database_session.scalar(select(LoginSession))

        stored_session.expires_at = int(time.time()) - 1

        database_session.commit()

    assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_user_and_session_survive_server_restart(auth_settings, test_password_hashes):
    # 첫 앱을 닫고 같은 DB를 사용하는 새 앱을 만들어 서버 재시작을 재현한다.
    first_application = create_app(auth_settings)

    with TestClient(first_application) as first_client:
        seed_users(first_application, test_password_hashes)
        response = login(first_client)

        assert response.status_code == 200
        public_user = response.json()["user"]

        session_token = first_client.cookies[COOKIE_NAME]

    with TestClient(create_app(auth_settings)) as restarted_client:
        restarted_client.cookies.set(COOKIE_NAME, session_token)
        response = restarted_client.get("/api/v1/auth/me")

        assert response.status_code == 200
        assert response.json()["user"] == public_user
        with restarted_client.app.state.database.session_factory() as database_session:
            assert len(database_session.scalars(select(User)).all()) == 2
            assert len(database_session.scalars(select(LoginSession)).all()) == 1


def test_login_rotates_current_session_and_preserves_other_browser(auth_client, auth_settings):
    # 재로그인은 현재 브라우저 토큰만 교체하고 다른 브라우저의 세션은 유지한다.
    assert login(auth_client).status_code == 200
    previous_session_token = auth_client.cookies[COOKIE_NAME]

    with TestClient(create_app(auth_settings)) as other_browser:
        assert login(other_browser).status_code == 200
        other_browser_token = other_browser.cookies[COOKIE_NAME]

        assert login(auth_client).status_code == 200
        renewed_session_token = auth_client.cookies[COOKIE_NAME]

        assert renewed_session_token not in {previous_session_token, other_browser_token}
        assert auth_client.get("/api/v1/auth/me").status_code == 200
        assert other_browser.get("/api/v1/auth/me").status_code == 200
        with auth_client.app.state.database.session_factory() as database_session:
            active_token_hashes = set(
                database_session.scalars(select(LoginSession.token_hash)).all()
            )

            assert active_token_hashes == {
                hash_token(renewed_session_token),
                hash_token(other_browser_token),
            }

        auth_client.cookies.clear()
        auth_client.cookies.set(COOKIE_NAME, previous_session_token)
        assert_error(auth_client.get("/api/v1/auth/me"), 401)


def test_logout_preserves_other_browser_session(auth_client, auth_settings):
    # 한 브라우저의 로그아웃이 같은 계정의 다른 브라우저까지 끊지 않아야 한다.
    assert login(auth_client).status_code == 200
    with TestClient(create_app(auth_settings)) as other_browser:
        assert login(other_browser).status_code == 200
        other_browser_token = other_browser.cookies[COOKIE_NAME]

        assert (
            auth_client.post("/api/v1/auth/logout", headers=AUTH_REQUEST_HEADERS).status_code == 204
        )
        assert other_browser.get("/api/v1/auth/me").status_code == 200
        with auth_client.app.state.database.session_factory() as database_session:
            assert database_session.scalars(select(LoginSession.token_hash)).all() == [
                hash_token(other_browser_token)
            ]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Requested-With": "kkobugi-web"},
        {"Origin": FRONTEND_ORIGIN},
        {"Origin": "https://untrusted.example", "X-Requested-With": "kkobugi-web"},
        {"Origin": "null", "X-Requested-With": "kkobugi-web"},
        {"Origin": FRONTEND_ORIGIN, "X-Requested-With": "another-client"},
    ],
)
def test_login_and_logout_require_trusted_origin_and_request_header(auth_client, headers):
    # 다른 사이트에서 사용자의 쿠키를 악용한 로그인·로그아웃 요청을 보내지 못하게 한다.
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
    headers = dict(AUTH_REQUEST_HEADERS)

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
    # 본문이 잘못됐어도 먼저 JSON 요청 형식인지 검사해야 한다.
    headers = dict(AUTH_REQUEST_HEADERS)

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
            "Origin": FRONTEND_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-requested-with",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    assert "x-requested-with" in response.headers["access-control-allow-headers"].lower()


def test_login_limit_is_per_account_and_resets_after_window(auth_client):
    # 같은 IP를 쓰는 팀원 중 한 명의 실패가 다른 계정의 로그인을 막지 않아야 한다.
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    limited_response = login(auth_client)

    assert_error(limited_response, 429)
    assert 0 < int(limited_response.headers["retry-after"]) <= 900

    assert login(auth_client, username="bob", password=BOB_PASSWORD).status_code == 200
    with auth_client.app.state.database.session_factory() as database_session:
        login_attempts = database_session.scalars(select(LoginAttempt)).all()

        assert login_attempts
        for login_attempt in login_attempts:
            login_attempt.window_start = int(time.time()) - 901

        database_session.commit()

    assert login(auth_client).status_code == 200
    assert_error(login(auth_client, password="test-only-wrong-password"), 401)


def test_successful_login_resets_previous_failures(auth_client):
    # 정상 로그인 뒤에는 그 계정·IP 조합의 이전 실패 횟수를 지운다.
    for _ in range(4):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    assert login(auth_client).status_code == 200
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    assert_error(login(auth_client, password="test-only-wrong-password"), 429)


def test_login_limit_uses_client_ip_without_trusting_forwarded_header(auth_client, auth_settings):
    # 임의로 보낸 X-Forwarded-For 값만 바꿔 로그인 제한을 피할 수 없어야 한다.
    for _ in range(5):
        assert_error(login(auth_client, password="test-only-wrong-password"), 401)
    spoofed_response = auth_client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": ALICE_PASSWORD},
        headers={**AUTH_REQUEST_HEADERS, "X-Forwarded-For": "192.0.2.50"},
    )

    assert_error(spoofed_response, 429)

    with TestClient(create_app(auth_settings), client=("192.0.2.51", 50000)) as another_ip:
        assert login(another_ip).status_code == 200


def test_secure_cookie_can_be_used_over_https(auth_settings, test_password_hashes):
    # 운영용 Secure 쿠키가 HTTPS에서 발급되고 다음 인증 요청에도 사용되는지 확인한다.
    secure_settings = auth_settings.model_copy(update={"cookie_secure": True})

    test_application = create_app(secure_settings)

    with TestClient(test_application, base_url="https://testserver") as test_client:
        seed_users(test_application, test_password_hashes)
        response = login(test_client)

        assert response.status_code == 200
        cookie_header = response.headers["set-cookie"].lower()

        assert "; secure" in cookie_header
        assert "httponly" in cookie_header
        assert "samesite=lax" in cookie_header
        assert test_client.get("/api/v1/auth/me").status_code == 200
