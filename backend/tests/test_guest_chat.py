"""관람 AI는 실제 생성 답변을 제공하되 비공개 데이터와 공용 대화 저장을 사용하지 않는다."""

import hashlib
import json
import time

import pytest
from sqlalchemy import select
from test_auth import AUTH_REQUEST_HEADERS, COOKIE_NAME
from test_auth import auth_client as auth_client
from test_auth import auth_settings as auth_settings
from test_auth import test_password_hashes as test_password_hashes
from test_chat import provider
from test_guest_auth import guest

from app.models import LoginAttempt, LoginSession
from app.security import hash_token


def send(client, **changes):
    return client.post(
        "/api/v1/assistant/chat",
        headers=AUTH_REQUEST_HEADERS,
        json={"question": "어떻게 사용하는지 설명해줘", **changes},
    )


def test_guest_receives_actual_llm_without_private_reads_or_persistence(auth_client, monkeypatch):
    assert guest(auth_client).status_code == 200
    calls = provider(
        monkeypatch, auth_client, {"answer": "샘플 화면을 확인해보세요.", "citation_ids": []}
    )

    def forbidden(*args, **kwargs):
        raise AssertionError("관람 대화는 비공개 자료 조회나 저장을 할 수 없다.")

    monkeypatch.setattr("app.services.chat.dataset_service.get_dataset", forbidden)
    monkeypatch.setattr("app.services.chat.assistant.capture_model", forbidden)
    monkeypatch.setattr("app.services.chat.assistant.save_json", forbidden)
    response = send(
        auth_client,
        history=[{"role": "user", "content": "시뮬레이션을 보고 있어"}],
        simulation_context={"status": "playing", "cursor": 10, "total_rows": 60},
    )

    assert response.status_code == 201, response.text
    assert response.json()["answer"] == "샘플 화면을 확인해보세요."
    assert response.json()["source_mode"] == "llm"
    assert response.json()["model_snapshot"] is response.json()["report_message_id"] is None
    facts = json.loads(calls[0]["json"]["messages"][0]["content"].split("\n", 1)[1])

    assert facts["guest_preview"] is True
    assert facts["dataset"] is facts["model"] is None
    assert facts["example_browser_state"]["cursor"] == 10
    assert "실제 센서·학습 결과가 아니다" in calls[0]["json"]["system"]


@pytest.mark.parametrize(
    "private",
    [
        {"dataset_id": "a" * 32},
        {"run_id": "b" * 32, "model_key": "xgboost"},
    ],
)
def test_guest_private_context_rejected_before_provider(auth_client, monkeypatch, private):
    guest(auth_client)
    calls = provider(monkeypatch, auth_client)

    response = send(auth_client, **private)

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "GUEST_READ_ONLY"
    assert calls == []


def test_guest_provider_failure_is_error_not_canned_answer(auth_client, monkeypatch):
    guest(auth_client)
    provider(monkeypatch, auth_client, status=529)
    response = send(auth_client)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_BUSY"


def test_guest_minute_limit_is_scoped_to_browser_session(auth_client, monkeypatch):
    guest(auth_client)
    calls = provider(monkeypatch, auth_client, {"answer": "답변입니다.", "citation_ids": []})

    for _ in range(10):
        assert send(auth_client).status_code == 201
    limited = send(auth_client)

    assert limited.status_code == 429
    assert len(calls) == 10
    auth_client.cookies.clear()
    guest(auth_client)
    assert send(auth_client).status_code == 201


def test_guest_session_total_limit_is_enforced(auth_client, monkeypatch):
    guest(auth_client)
    calls = provider(monkeypatch, auth_client)

    token_hash = hash_token(auth_client.cookies[COOKIE_NAME])

    with auth_client.app.state.database.session_factory() as session:
        login_session = session.scalar(
            select(LoginSession).where(LoginSession.token_hash == token_hash)
        )

        digest = hashlib.sha256(f"session:{login_session.token_hash}".encode()).hexdigest()

        session.add(
            LoginAttempt(key="guestai:" + digest[:56], failures=50, window_start=int(time.time()))
        )
        session.commit()
    assert send(auth_client).status_code == 429
    assert calls == []
