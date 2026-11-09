"""실패·중복 요청에서도 기존 CSV와 계정이 보존되는지 확인한다."""

import hashlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from threading import Barrier, local
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.db import Database
from app.models import Dataset, User
from app.services import datasets as dataset_service

PREPARED_CSV = (
    b"\xef\xbb\xbftimestamp,sensor_00,label\r\n"
    b"2026-11-09 00:00:00,1.25,normal\r\n"
    b"2026-11-09 00:01:00,2.50,abnormal\r\n"
)


@pytest.fixture
def storage_setup(tmp_path):
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
    )

    database = Database(settings.database_path)

    database.create_tables()
    with database.session_factory() as database_session:
        current_user = User(
            username="alice", display_name="테스트 사용자", password_hash="test-hash"
        )

        database_session.add(current_user)
        database_session.commit()
    yield database, settings, current_user
    database.dispose()


def csv_upload(content=PREPARED_CSV, filename="prepared.csv"):
    return UploadFile(file=BytesIO(content), filename=filename)


def assert_empty_storage(database, settings):
    # 업로드가 실패하면 DB에 자료가 없어야 하고, 임시·완성 파일도 남지 않아야 한다.
    with database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(Dataset)) == 0
        assert database_session.scalar(select(func.count()).select_from(User)) == 1
    assert list(settings.dataset_storage_path.iterdir()) == []


def test_upload_keeps_exact_original_bytes_and_sanitizes_display_name(storage_setup):
    database, settings, current_user = storage_setup

    with database.session_factory() as database_session:
        stored_dataset, is_new_dataset = dataset_service.upload_dataset(
            database_session,
            csv_upload(filename=r"C:\fakepath\prepared.CSV"),
            current_user,
            settings,
        )

    assert is_new_dataset
    assert stored_dataset.filename == "prepared.CSV"
    assert stored_dataset.sha256 == hashlib.sha256(PREPARED_CSV).hexdigest()
    assert stored_dataset.size_bytes == len(PREPARED_CSV)
    assert (settings.dataset_storage_path / f"{stored_dataset.id}.csv").read_bytes() == PREPARED_CSV
    assert len(list(settings.dataset_storage_path.iterdir())) == 1


def test_duplicate_reuses_dataset_without_leaving_an_extra_file(storage_setup):
    database, settings, current_user = storage_setup

    with database.session_factory() as database_session:
        first_dataset, first_created = dataset_service.upload_dataset(
            database_session, csv_upload(), current_user, settings
        )

        second_dataset, second_created = dataset_service.upload_dataset(
            database_session, csv_upload(filename="another-name.csv"), current_user, settings
        )

        assert first_created and not second_created
        assert second_dataset.id == first_dataset.id
        assert database_session.scalar(select(func.count()).select_from(Dataset)) == 1
    assert len(list(settings.dataset_storage_path.iterdir())) == 1


def test_same_bytes_with_different_label_mapping_are_a_separate_dataset(storage_setup):
    database, settings, current_user = storage_setup

    with database.session_factory() as database_session:
        first_dataset, _ = dataset_service.upload_dataset(
            database_session, csv_upload(), current_user, settings
        )

        second_dataset, is_new_dataset = dataset_service.upload_dataset(
            database_session,
            csv_upload(),
            current_user,
            settings,
            normal_label="abnormal",
            abnormal_label="normal",
        )

    assert is_new_dataset
    assert first_dataset.id != second_dataset.id
    assert len(list(settings.dataset_storage_path.iterdir())) == 2


def test_same_bytes_uploaded_by_other_user_have_independent_ownership(storage_setup):
    database, settings, first_user = storage_setup

    with database.session_factory() as database_session:
        second_user = User(username="bob", display_name="다른 사용자", password_hash="test-hash")

        database_session.add(second_user)
        database_session.commit()
        first_dataset, _ = dataset_service.upload_dataset(
            database_session, csv_upload(), first_user, settings
        )

        second_dataset, is_new_dataset = dataset_service.upload_dataset(
            database_session, csv_upload(), second_user, settings
        )

    assert is_new_dataset
    assert first_dataset.id != second_dataset.id
    assert first_dataset.owner_id != second_dataset.owner_id
    assert len(list(settings.dataset_storage_path.iterdir())) == 2


def test_invalid_csv_removes_temporary_file(storage_setup):
    database, settings, current_user = storage_setup

    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(
                database_session,
                csv_upload(b"timestamp,sensor\n2026-11-09,1\n"),
                current_user,
                settings,
            )
    assert error.value.status_code == 422
    assert_empty_storage(database, settings)


def test_oversized_file_removes_partial_copy(storage_setup):
    database, original_settings, current_user = storage_setup

    settings = original_settings.model_copy(update={"max_upload_bytes": 10})

    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(database_session, csv_upload(), current_user, settings)
    assert error.value.status_code == 413
    assert_empty_storage(database, settings)


def test_stream_read_error_removes_partial_copy(storage_setup):
    database, settings, current_user = storage_setup

    class BrokenUpload(BytesIO):
        def read(self, size=-1):
            if self.tell() > 0:
                raise OSError("test-only read failure")
            return super().read(10)

    upload_file = UploadFile(file=BrokenUpload(PREPARED_CSV), filename="prepared.csv")

    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(database_session, upload_file, current_user, settings)
    assert error.value.status_code == 503
    assert "test-only" not in str(error.value.detail)
    assert_empty_storage(database, settings)


def test_db_commit_failure_removes_published_file_without_removing_user(storage_setup, monkeypatch):
    database, settings, current_user = storage_setup

    def fail_commit():
        raise SQLAlchemyError("test-only database failure with private query data")

    with database.session_factory() as database_session:
        monkeypatch.setattr(database_session, "commit", fail_commit)
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(database_session, csv_upload(), current_user, settings)
    assert error.value.status_code == 503
    assert "private query" not in str(error.value.detail)
    assert_empty_storage(database, settings)


def test_db_read_failure_removes_temporary_file(storage_setup, monkeypatch):
    database, settings, current_user = storage_setup

    def fail_query(*args, **kwargs):
        raise SQLAlchemyError("test-only private database query")

    with database.session_factory() as database_session:
        monkeypatch.setattr(database_session, "scalar", fail_query)
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(database_session, csv_upload(), current_user, settings)
    assert error.value.status_code == 503
    assert_empty_storage(database, settings)


def test_publish_failure_removes_temporary_file(storage_setup, monkeypatch):
    database, settings, current_user = storage_setup

    def fail_publish(*args, **kwargs):
        raise OSError("test-only rename failure")

    monkeypatch.setattr(Path, "replace", fail_publish)
    with database.session_factory() as database_session:
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(database_session, csv_upload(), current_user, settings)
    assert error.value.status_code == 503
    assert_empty_storage(database, settings)


def test_dataset_id_collision_never_overwrites_original(storage_setup, monkeypatch):
    database, settings, current_user = storage_setup

    with database.session_factory() as database_session:
        original_dataset, _ = dataset_service.upload_dataset(
            database_session, csv_upload(), current_user, settings
        )

        # 드문 ID 충돌을 강제로 만들어 기존 파일 보존을 확인한다.
        monkeypatch.setattr(
            dataset_service, "uuid4", lambda: SimpleNamespace(hex=original_dataset.id)
        )
        with pytest.raises(HTTPException) as error:
            dataset_service.upload_dataset(
                database_session,
                csv_upload(PREPARED_CSV.replace(b"1.25", b"9.25")),
                current_user,
                settings,
            )
        assert database_session.scalar(select(func.count()).select_from(Dataset)) == 1
    assert error.value.status_code == 503
    assert (
        settings.dataset_storage_path / f"{original_dataset.id}.csv"
    ).read_bytes() == PREPARED_CSV
    assert len(list(settings.dataset_storage_path.iterdir())) == 1


def test_concurrent_duplicates_keep_one_row_and_one_file(storage_setup, monkeypatch):
    database, settings, current_user = storage_setup

    first_lookup_barrier = Barrier(2)

    thread_state = local()

    original_find_duplicate = dataset_service._find_duplicate

    def synchronized_lookup(*args, **kwargs):
        existing_dataset = original_find_duplicate(*args, **kwargs)

        # 두 요청이 모두 첫 조회에서 미등록 상태를 확인한 뒤 저장하도록 한다.
        if not getattr(thread_state, "has_looked_up", False):
            thread_state.has_looked_up = True

            first_lookup_barrier.wait(timeout=10)
        return existing_dataset

    monkeypatch.setattr(dataset_service, "_find_duplicate", synchronized_lookup)

    def upload_from_one_request():
        with database.session_factory() as database_session:
            dataset, is_new_dataset = dataset_service.upload_dataset(
                database_session, csv_upload(), current_user, settings
            )

            return dataset.id, is_new_dataset

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: upload_from_one_request(), range(2)))

    assert results[0][0] == results[1][0]
    assert sorted(result[1] for result in results) == [False, True]
    with database.session_factory() as database_session:
        assert database_session.scalar(select(func.count()).select_from(Dataset)) == 1
    assert len(list(settings.dataset_storage_path.iterdir())) == 1
