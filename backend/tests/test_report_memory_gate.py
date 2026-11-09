"""보고서 파일 생성도 학습·CSV 조회의 공용 메모리 슬롯을 기다린다."""

import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace

from app.config import Settings
from app.memory_work import MemoryWorkGate
from app.services import reports


def test_document_generation_waits_for_shared_memory_slot(tmp_path, monkeypatch):
    gate = MemoryWorkGate(wait_seconds=2)

    settings = Settings(_env_file=None, dataset_storage_path=tmp_path / "datasets")

    manager = reports.ReportManager(settings, memory_gate=gate)

    writing = Event()

    report = SimpleNamespace(id="a" * 32, status="queued", preview=None, updated_at=0)

    report.model_dump = lambda **kwargs: {"status": report.status}

    def write_document(preview, destination, *args):
        writing.set()
        destination.write_bytes(b"test report")

    monkeypatch.setattr(reports, "_write_docx", write_document)
    monkeypatch.setattr(reports, "_write_pdf", write_document)
    manager._pending.acquire()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            with gate.sync_slot():
                task = pool.submit(manager._generate, 1, report)

                time.sleep(0.05)
                assert not writing.is_set()
                assert report.status == "queued"
            task.result(timeout=2)
        assert writing.is_set()
        assert report.status == "completed"
    finally:
        manager.shutdown()
