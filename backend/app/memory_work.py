"""큰 메모리 작업을 직렬로 실행하고, HTTP 대기는 이벤트 루프에 맡긴다."""

import threading
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager

import anyio
from fastapi import HTTPException, Request


class MemoryWorkBusy(ValueError):
    def __init__(self):
        super().__init__("다른 작업이 실행 중입니다. 잠시 후 다시 요청하세요.")


class MemoryWorkGate:
    def __init__(self, *, max_pending: int = 16, wait_seconds: float = 60):
        self._admission = threading.BoundedSemaphore(max_pending)
        self._work = threading.Lock()
        self._wait_seconds = wait_seconds

    @asynccontextmanager
    async def async_slot(self) -> AsyncIterator[None]:
        # 대기 중에는 worker thread와 DB 연결을 잡지 않는다.
        if not self._admission.acquire(blocking=False):
            raise MemoryWorkBusy()
        acquired = False
        deadline = time.monotonic() + self._wait_seconds
        try:
            while not acquired:
                acquired = self._work.acquire(blocking=False)
                if acquired:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise MemoryWorkBusy()
                await anyio.sleep(min(0.025, remaining))
            yield
        finally:
            if acquired:
                self._work.release()
            self._admission.release()

    @contextmanager
    def sync_slot(self) -> Iterator[None]:
        # 전용 background 학습 thread에서만 동기 대기를 사용한다.
        deadline = time.monotonic() + self._wait_seconds
        if not self._admission.acquire(timeout=self._wait_seconds):
            raise MemoryWorkBusy()
        acquired = False
        try:
            acquired = self._work.acquire(timeout=max(0, deadline - time.monotonic()))
            if not acquired:
                raise MemoryWorkBusy()
            yield
        finally:
            if acquired:
                self._work.release()
            self._admission.release()


async def memory_guard(request: Request) -> AsyncIterator[None]:
    # FastAPI가 body/form 수신을 마친 뒤, 사용자·DB dependency보다 먼저 실행한다.
    # 기본 request scope의 yield는 응답 전송이 끝난 뒤 해제된다.
    try:
        async with request.app.state.memory_gate.async_slot():
            yield
    except MemoryWorkBusy as error:
        raise HTTPException(
            status_code=503,
            detail={"code": "MEMORY_WORK_BUSY", "message": str(error)},
            headers={"Retry-After": "3"},
        ) from None
