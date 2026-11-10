"""CSV 휴지통은 목록만 바꾸고 원본·계정·학습·관찰·검토 기록을 보존한다."""

import pytest
from sqlalchemy import select
from test_datasets import (
    VALID_CSV,
    WRITE_HEADERS,
    login_dataset_user,
    upload_csv,
)
from test_datasets import dataset_client as dataset_client
from test_datasets import dataset_password_hash as dataset_password_hash
from test_datasets import dataset_settings as dataset_settings

from app.db import Database
from app.models import Dataset, DatasetDeletion, ModelRun, Observation, Review, User


def test_delete_and_restore_preserve_original_and_related_records(dataset_client, dataset_settings):
    uploaded = upload_csv(dataset_client).json()

    dataset_id = uploaded["dataset"]["id"]

    with dataset_client.app.state.database.session_factory() as session:
        session.add(
            ModelRun(
                id="a" * 32,
                owner_id=1,
                dataset_id=dataset_id,
                status="completed",
                configuration={"retained": True},
                input_sha256=uploaded["dataset"]["sha256"],
            )
        )
        session.add(
            Observation(
                id="b" * 32,
                owner_id=1,
                dataset_id=dataset_id,
                channel="sensor_00",
                start_time="2026-01-01T00:00:00",
                end_time="2026-01-01T00:01:00",
                content="기존 현장 기록",
                last_editor_id=1,
            )
        )
        session.add(
            Review(
                id="c" * 32,
                owner_id=1,
                dataset_id=dataset_id,
                channel="sensor_00",
                start_time="2026-01-01T00:00:00",
                end_time="2026-01-01T00:01:00",
                conclusion="기존 판단",
                evidence={"retained": True},
                last_editor_id=1,
            )
        )
        session.commit()
    for _ in range(2):
        assert (
            dataset_client.delete(
                f"/api/v1/datasets/{dataset_id}", headers=WRITE_HEADERS
            ).status_code
            == 204
        )
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 0
    assert dataset_client.get("/api/v1/datasets?deleted=true").json()["items"] == [
        uploaded["dataset"]
    ]
    assert dataset_client.get(f"/api/v1/datasets/{dataset_id}").json() == uploaded
    assert dataset_client.get(f"/api/v1/datasets/{dataset_id}/file").content == VALID_CSV
    with dataset_client.app.state.database.session_factory() as session:
        assert session.get(ModelRun, "a" * 32).configuration == {"retained": True}
        assert session.get(Observation, "b" * 32).content == "기존 현장 기록"
        assert session.get(Review, "c" * 32).conclusion == "기존 판단"
        assert session.get(User, 1).username == "alice"
    restored = dataset_client.post(f"/api/v1/datasets/{dataset_id}/restore", headers=WRITE_HEADERS)

    assert restored.status_code == 200
    assert restored.json() == uploaded
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 1
    assert dataset_client.get("/api/v1/datasets?deleted=true").json()["total"] == 0
    assert (dataset_settings.dataset_storage_path / f"{dataset_id}.csv").read_bytes() == VALID_CSV


def test_reupload_restores_same_dataset_id_without_copy(dataset_client, dataset_settings):
    dataset_id = upload_csv(dataset_client).json()["dataset"]["id"]

    dataset_client.delete(f"/api/v1/datasets/{dataset_id}", headers=WRITE_HEADERS)
    repeated = upload_csv(dataset_client)

    assert repeated.status_code == 200
    assert repeated.json()["dataset"]["id"] == dataset_id
    assert dataset_client.get("/api/v1/datasets").json()["total"] == 1
    assert len(list(dataset_settings.dataset_storage_path.glob("*.csv"))) == 1


@pytest.mark.parametrize("method, suffix", [("delete", ""), ("post", "/restore")])
def test_delete_restore_require_owner_login_and_write_headers(dataset_client, method, suffix):
    dataset_id = upload_csv(dataset_client).json()["dataset"]["id"]

    path = f"/api/v1/datasets/{dataset_id}{suffix}"

    assert getattr(dataset_client, method)(path).status_code == 403
    login_dataset_user(dataset_client, "bob")
    assert getattr(dataset_client, method)(path, headers=WRITE_HEADERS).status_code == 404
    assert dataset_client.get("/api/v1/datasets?deleted=true").json()["items"] == []
    dataset_client.cookies.clear()
    assert getattr(dataset_client, method)(path, headers=WRITE_HEADERS).status_code == 401


def test_archived_csv_cannot_start_new_training_or_plan(dataset_client):
    dataset_id = upload_csv(dataset_client).json()["dataset"]["id"]

    dataset_client.delete(f"/api/v1/datasets/{dataset_id}", headers=WRITE_HEADERS)
    plan = dataset_client.post(
        "/api/v1/training/plan",
        json={"dataset_id": dataset_id, "model_key": "xgboost"},
        headers=WRITE_HEADERS,
    )

    run = dataset_client.post(
        "/api/v1/runs",
        headers=WRITE_HEADERS,
        json={
            "dataset_id": dataset_id,
            "feature_columns": ["sensor_00"],
            "models": ["xgboost"],
            "train_end": "2026-01-01T00:00:00",
            "validation_end": "2026-01-01T00:01:00",
        },
    )

    assert plan.status_code == run.status_code == 409
    assert plan.json()["error"]["code"] == run.json()["error"]["code"] == "DATASET_DELETED"


def test_existing_database_gets_new_table_without_changing_existing_rows(tmp_path):
    database = Database(tmp_path / "old.sqlite3")

    # 배포 전 스키마를 재현한다. 현재 사용자·CSV 테이블에는 변경 사항이 없다.
    User.__table__.create(database.engine)
    Dataset.__table__.create(database.engine)
    with database.session_factory() as session:
        session.add(User(username="existing", display_name="기존", password_hash="unchanged"))
        session.commit()
        session.add(
            Dataset(
                id="d" * 32,
                owner_id=1,
                filename="old.csv",
                size_bytes=123,
                sha256="e" * 64,
                timestamp_column="time",
                label_column="label",
                normal_label="0",
                abnormal_label="1",
                inspection={"retained": True},
            )
        )
        session.commit()
    database.create_tables()
    database.create_tables()
    with database.session_factory() as session:
        assert session.get(User, 1).password_hash == "unchanged"
        assert session.get(Dataset, "d" * 32).inspection == {"retained": True}
        assert session.scalars(select(DatasetDeletion)).all() == []
    database.dispose()
