"""큰 작업의 직렬 실행, 대기 중 응답과 기존 결과 보존을 확인한다."""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Event, Lock

import anyio
import httpx
import pytest
from fastapi import Body, Depends, FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from starlette.responses import StreamingResponse

from app.config import Settings
from app.db import get_db
from app.main import create_app
from app.memory_work import MemoryWorkBusy, MemoryWorkGate, memory_guard
from app.models import LoginAttempt, User
from app.security import hash_password
from app.services import modeling

ORIGIN = "http://localhost:5173"
HEADERS = {"Origin": ORIGIN, "X-Requested-With": "kkobugi-web"}
PASSWORD = "memory-work-test-only!"


def test_http_and_background_share_one_slot_and_release_after_errors():
    gate = MemoryWorkGate(wait_seconds=2)
    counters = {"active": 0, "peak": 0}
    counter_lock = Lock()

    def compute(value):
        with counter_lock:
            counters["active"] += 1
            counters["peak"] = max(counters["peak"], counters["active"])
        time.sleep(0.01)
        with counter_lock:
            counters["active"] -= 1
        return value * 2

    def background(value):
        with gate.sync_slot():
            return compute(value)

    async def http(value):
        async with gate.async_slot():
            return await anyio.to_thread.run_sync(compute, value)

    async def run():
        results = await asyncio.gather(
            *(http(value) for value in range(5)),
            *(anyio.to_thread.run_sync(background, value) for value in range(5, 8)),
        )
        assert results == [value * 2 for value in range(8)]
        with pytest.raises(RuntimeError):
            async with gate.async_slot():
                raise RuntimeError("test cleanup")
        async with gate.async_slot():
            pass

    asyncio.run(run())
    with pytest.raises(RuntimeError), gate.sync_slot():
        raise RuntimeError("test cleanup")
    with gate.sync_slot():
        pass
    assert counters["peak"] == 1


def test_queue_limit_and_wait_deadline_release_admission():
    gate = MemoryWorkGate(max_pending=2, wait_seconds=0.04)

    async def blocked():
        with pytest.raises(MemoryWorkBusy):
            async with gate.async_slot():
                pytest.fail("busy gate admitted work")

    with gate.sync_slot():
        asyncio.run(blocked())
        # A timeout must not leak its admission slot.
        asyncio.run(blocked())
    with gate.sync_slot():
        pass


@pytest.fixture(scope="module")
def password_hash():
    return hash_password(PASSWORD)


@pytest.fixture
def memory_client(tmp_path, password_hash):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("memory-test-page", encoding="utf-8")
    gate = MemoryWorkGate(wait_seconds=2)
    application = create_app(
        Settings(
            _env_file=None,
            database_path=tmp_path / "test.sqlite3",
            dataset_storage_path=tmp_path / "datasets",
            model_storage_path=tmp_path / "models",
            frontend_dist_path=dist,
            cors_origins=[ORIGIN],
        ),
        memory_gate=gate,
    )
    with TestClient(application) as client:
        with application.state.database.session_factory() as session:
            session.add(User(username="memory", display_name="Test", password_hash=password_hash))
            session.commit()
        assert (
            client.post(
                "/api/v1/auth/login",
                json={"username": "memory", "password": PASSWORD},
                headers=HEADERS,
            ).status_code
            == 200
        )
        rows = ["timestamp,sensor_00,label"]
        for index in range(20):
            timestamp = datetime(2026, 1, 1) + timedelta(minutes=index)
            rows.append(f"{timestamp.isoformat()},{index},{'abnormal' if index % 2 else 'normal'}")
        response = client.post(
            "/api/v1/datasets",
            files={"file": ("test.csv", "\n".join(rows).encode(), "text/csv")},
            headers=HEADERS,
        )
        assert response.status_code == 201
        yield client, application, response.json()["dataset"]["id"]


def test_background_training_wait_does_not_block_metadata_or_change_graph(
    memory_client, monkeypatch
):
    client, application, dataset_id = memory_client
    series_path = f"/api/v1/datasets/{dataset_id}/series"
    expected = client.get(series_path, params={"channels": "sensor_00"}).json()
    started, finish = Event(), Event()
    original_training = modeling.train_models

    def delayed_training(*args, **kwargs):
        started.set()
        assert finish.wait(5)
        return original_training(*args, **kwargs)

    monkeypatch.setattr(modeling, "train_models", delayed_training)
    response = client.post(
        "/api/v1/runs",
        json={
            "dataset_id": dataset_id,
            "feature_columns": ["sensor_00"],
            "models": ["xgboost"],
            "train_end": "2026-01-01T00:09:00",
            "validation_end": "2026-01-01T00:14:00",
        },
        headers=HEADERS,
    )
    assert response.status_code == 202
    run_id = response.json()["run"]["id"]
    assert started.wait(2)
    with ThreadPoolExecutor(max_workers=1) as pool:
        graph = pool.submit(client.get, series_path, params={"channels": "sensor_00"})
        try:
            time.sleep(0.05)
            assert not graph.done()
            for path in ("/api/v1/health", "/api/v1/auth/me", f"/api/v1/runs/{run_id}", "/"):
                before = time.monotonic()
                assert client.get(path).status_code == 200
                assert time.monotonic() - before < 1
        finally:
            finish.set()
        assert graph.result(timeout=4).json() == expected
    assert application.state.run_manager.memory_gate is application.state.memory_gate
    assert application.state.report_manager.memory_gate is application.state.memory_gate


def test_http_waiter_does_not_enter_database_dependency(memory_client):
    client, application, dataset_id = memory_client
    database_entered = Event()

    def tracked_db(request: Request):
        database_entered.set()
        yield from get_db(request)

    application.dependency_overrides[get_db] = tracked_db
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with application.state.memory_gate.sync_slot():
                graph = pool.submit(
                    client.get,
                    f"/api/v1/datasets/{dataset_id}/series",
                    params={"channels": "sensor_00"},
                )
                time.sleep(0.05)
                assert not graph.done()
                assert not database_entered.is_set()
                assert client.get("/api/v1/health").status_code == 200
                assert client.get("/").status_code == 200
            assert graph.result(timeout=2).status_code == 200
            assert database_entered.is_set()
    finally:
        application.dependency_overrides.pop(get_db)


@pytest.mark.parametrize("max_pending", [1, 2])
def test_busy_login_preserves_hash_attempts_and_existing_session(
    memory_client, password_hash, max_pending
):
    client, application, _ = memory_client
    # Fill admission to make busy rejection deterministic, without changing hash settings.
    gate = MemoryWorkGate(max_pending=max_pending, wait_seconds=0.05)
    application.state.memory_gate = gate
    with gate.sync_slot():
        response = client.post(
            "/api/v1/auth/login",
            json={"username": "memory", "password": PASSWORD},
            headers=HEADERS,
        )
        assert response.status_code == 503
        assert response.headers["retry-after"] == "3"
        assert response.json()["error"]["code"] == "MEMORY_WORK_BUSY"
        assert client.get("/api/v1/auth/me").status_code == 200
    with application.state.database.session_factory() as session:
        assert session.scalar(select(func.count()).select_from(LoginAttempt)) == 0
        assert session.scalar(select(User.password_hash)) == password_hash
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"username": "memory", "password": PASSWORD},
            headers=HEADERS,
        ).status_code
        == 200
    )


def test_chunked_json_is_limited_before_auth_or_gate(memory_client, monkeypatch):
    client, application, _ = memory_client
    called = Event()

    def unexpected_verify(*args):
        called.set()
        pytest.fail("oversized login reached password verification")

    monkeypatch.setattr("app.services.auth.verify_password", unexpected_verify)
    response = client.post(
        "/api/v1/auth/login",
        content=iter([b'{"username":"memory","password":"', b"x" * (16 * 1024), b'"}']),
        headers={**HEADERS, "Content-Type": "application/json"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "REQUEST_TOO_LARGE"
    assert not called.is_set()
    response = client.post(
        "/api/v1/reviews",
        content=iter([b" " * (1024 * 1024), b"x"]),
        headers={**HEADERS, "Content-Type": "application/json"},
    )
    assert response.status_code == 413


def test_slow_body_does_not_hold_gate_and_streaming_response_keeps_it():
    gate = MemoryWorkGate(wait_seconds=1)
    application = FastAPI()
    application.state.memory_gate = gate

    @application.post("/body", dependencies=[Depends(memory_guard)])
    def body_endpoint(value: dict = Body()):
        return value

    async def slow_body_case():
        body_started, finish_body = asyncio.Event(), asyncio.Event()

        async def body():
            yield b'{"value":'
            body_started.set()
            await finish_body.wait()
            yield b"7}"

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(application), base_url="http://test"
        ) as client:
            task = asyncio.create_task(
                client.post("/body", content=body(), headers={"Content-Type": "application/json"})
            )
            await asyncio.wait_for(body_started.wait(), 1)
            async with gate.async_slot():
                finish_body.set()
            response = await asyncio.wait_for(task, 2)
            assert response.json() == {"value": 7}

    asyncio.run(slow_body_case())
    streaming, finish_stream = Event(), Event()

    @application.get("/stream", dependencies=[Depends(memory_guard)])
    def stream_endpoint():
        def chunks():
            yield b"start"
            streaming.set()
            assert finish_stream.wait(3)
            yield b"end"

        return StreamingResponse(chunks())

    @application.get("/next", dependencies=[Depends(memory_guard)])
    def next_endpoint():
        return {"ok": True}

    with TestClient(application) as client, ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(client.get, "/stream")
        assert streaming.wait(1)
        second = pool.submit(client.get, "/next")
        try:
            time.sleep(0.05)
            assert not second.done()
        finally:
            finish_stream.set()
        assert first.result(timeout=2).content == b"startend"
        assert second.result(timeout=2).json() == {"ok": True}
