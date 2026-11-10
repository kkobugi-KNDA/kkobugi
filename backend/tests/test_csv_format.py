"""SKAB 원본의 구분자를 검사·학습·그래프·시뮬레이션에서 동일하게 읽는다."""

import csv
import hashlib
import io
from datetime import datetime, timedelta

import pytest

from app.config import Settings
from app.models import Dataset
from app.schemas.runs import RunCreate
from app.schemas.training import TrainingPlanRequest
from app.services import modeling, series_source, simulations, training
from app.services.csv_format import detect_csv_delimiter
from app.services.csv_inspection import inspect_csv


@pytest.mark.parametrize("delimiter", [",", ";", "\t"])
def test_delimiter_ignores_quoted_header_and_preserves_position(delimiter):
    stream = io.StringIO()

    writer = csv.writer(stream, delimiter=delimiter)

    writer.writerow(["datetime", 'sensor,;\t"quoted"', "anomaly"])
    writer.writerow(["2026-11-10T00:00:00", 2, "0.0"])
    stream.seek(4)
    assert detect_csv_delimiter(stream) == delimiter
    assert stream.tell() == 4


@pytest.mark.parametrize("delimiter", [",", ";", "\t"])
def test_delimited_csv_works_through_training_series_and_seek(tmp_path, delimiter):
    settings = Settings(_env_file=None, dataset_storage_path=tmp_path)

    dataset_id = "a" * 32

    path = tmp_path / f"{dataset_id}.csv"

    channel = "sensor,quoted;name"

    start = datetime(2026, 11, 10)

    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream, delimiter=delimiter)

        writer.writerow(["datetime", channel, "anomaly", "changepoint"])
        for index in range(12):
            writer.writerow(
                [(start + timedelta(minutes=index)).isoformat(), index, f"{index % 2}.0", 0]
            )
    original = path.read_bytes()

    inspection = inspect_csv(path, "datetime", "anomaly", "0.0", "1.0")

    assert inspection.is_valid
    assert inspection.channels == [channel]
    dataset = Dataset(
        id=dataset_id,
        owner_id=1,
        filename="skab.csv",
        size_bytes=len(original),
        sha256=hashlib.sha256(original).hexdigest(),
        timestamp_column="datetime",
        label_column="anomaly",
        normal_label="0.0",
        abnormal_label="1.0",
        created_at=1,
        inspection=inspection.model_dump(mode="json"),
    )

    plan = training.make_training_plan(
        dataset,
        settings,
        TrainingPlanRequest(
            dataset_id=dataset_id,
            model_key="xgboost",
            train_ratio=0.5,
            validation_ratio=0.25,
        ),
    )

    assert plan.configuration.feature_columns == [channel]
    assert plan.split == {"train_rows": 6, "validation_rows": 3, "test_rows": 3}
    values, labels, split = modeling._read_dataset(
        path,
        RunCreate(**plan.configuration.model_dump()),
        timestamp_column="datetime",
        label_column="anomaly",
        normal_label="0.0",
        abnormal_label="1.0",
        expected_sha256=dataset.sha256,
    )

    assert values[:, 0].tolist() == list(range(12))
    assert labels.tolist() == [index % 2 for index in range(12)]
    assert split.train.row_count == 6
    source = series_source.load_index(dataset, settings)

    batches = list(series_source.value_batches(dataset, settings, source, [channel], 2, 5))

    assert batches[0].values[:, 0].tolist() == [2, 3, 4]
    assert batches[0].raw_labels == ["0.0", "1.0", "0.0"]
    manifest = simulations._inspect_csv(path, "datetime", [channel], settings)

    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        stream.seek(manifest["offsets"][0])
        reader = csv.DictReader(
            stream, fieldnames=manifest["columns"], delimiter=detect_csv_delimiter(stream)
        )

        assert next(reader)[channel] == "0"
    assert manifest["total_rows"] == 12
    assert path.read_bytes() == original
