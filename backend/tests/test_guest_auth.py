"""QR 관람 세션은 팀 자료 접근 없이 샘플 화면만 사용할 수 있다."""

import time

from sqlalchemy import select
from test_auth import AUTH_REQUEST_HEADERS, COOKIE_NAME, login
from test_auth import auth_client as auth_client
from test_auth import auth_settings as auth_settings
from test_auth import test_password_hashes as test_password_hashes

from app.models import GUEST_USERNAME, LoginSession, User
from app.security import hash_token


def guest(client):
    return client.post("/api/v1/auth/guest", json={}, headers=AUTH_REQUEST_HEADERS)


def test_guest_login_me_reuse_and_logout(auth_client):
    response = guest(auth_client)

    assert response.status_code == 200
    assert response.json()["user"]["is_guest"] is True
    assert response.json()["expires_in"] == 7200
    assert "httponly" in response.headers["set-cookie"].lower()
    token = auth_client.cookies[COOKIE_NAME]

    assert auth_client.get("/api/v1/auth/me").json()["user"]["is_guest"] is True
    assert guest(auth_client).status_code == 200
    assert auth_client.cookies[COOKIE_NAME] == token
    with auth_client.app.state.database.session_factory() as session:
        account = session.scalar(select(User).where(User.username == GUEST_USERNAME))

        assert account.password_hash.startswith("$argon2")
        saved = session.scalar(select(LoginSession).where(LoginSession.user_id == account.id))

        assert saved.token_hash == hash_token(token)
        assert saved.expires_at - saved.created_at == 7200
    assert auth_client.post("/api/v1/auth/logout", headers=AUTH_REQUEST_HEADERS).status_code == 204
    assert auth_client.get("/api/v1/auth/me").status_code == 401


def test_member_session_is_not_replaced_by_qr(auth_client):
    assert login(auth_client).status_code == 200
    token = auth_client.cookies[COOKIE_NAME]

    response = guest(auth_client)

    assert response.status_code == 200
    assert response.json()["user"]["username"] == "alice"
    assert response.json()["user"]["is_guest"] is False
    assert "set-cookie" not in response.headers
    assert auth_client.cookies[COOKIE_NAME] == token


def test_guest_cannot_read_or_modify_team_data(auth_client):
    assert guest(auth_client).status_code == 200
    responses = [
        auth_client.get("/api/v1/datasets"),
        auth_client.get("/api/v1/runs"),
        auth_client.delete("/api/v1/datasets/" + "a" * 32, headers=AUTH_REQUEST_HEADERS),
        auth_client.post(
            "/api/v1/datasets",
            headers=AUTH_REQUEST_HEADERS,
            files={"file": ("blocked.csv", b"timestamp,x,label\n", "text/csv")},
        ),
        auth_client.post(
            "/api/v1/training/plan",
            headers=AUTH_REQUEST_HEADERS,
            json={"dataset_id": "a" * 32, "model_key": "xgboost"},
        ),
    ]

    for response in responses:
        assert response.status_code == 403, response.text
        assert response.json()["error"]["code"] == "GUEST_READ_ONLY"


def test_guest_endpoint_requires_write_headers_and_cleans_expired_sessions(auth_client):
    assert auth_client.post("/api/v1/auth/guest", json={}).status_code == 403
    assert guest(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as session:
        old_session = session.scalar(select(LoginSession))

        old_session.expires_at = int(time.time()) - 1
        session.commit()
    auth_client.cookies.clear()
    assert guest(auth_client).status_code == 200
    with auth_client.app.state.database.session_factory() as session:
        sessions = session.scalars(select(LoginSession)).all()

        accounts = session.scalars(select(User).where(User.username == GUEST_USERNAME)).all()

        assert len(sessions) == len(accounts) == 1
        assert sessions[0].expires_at > time.time()
