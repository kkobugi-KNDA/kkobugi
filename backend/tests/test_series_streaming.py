"""큰 조회에서도 전체 채널 배열·전체 구간 목록을 만들지 않는지 검증한다."""

import csv
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from fastapi import HTTPException

from app.config import Settings
from app.models import Dataset, ModelRun
from app.schemas.runs import RunCreate
from app.services import modeling, series, series_source
from app.services.csv_inspection import inspect_csv


@pytest.fixture
def streaming_dataset(tmp_path):
    settings = Settings(_env_file=None, dataset_storage_path=tmp_path)

    source_path = tmp_path / ("a" * 32 + ".csv")

    channels = [f"sensor_{index:02}" for index in range(49)]

    start = datetime(2026, 1, 1)

    with source_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)

        writer.writerow(["timestamp", *channels, "label"])
        for row in range(3500):
            writer.writerow(
                [
                    (start + timedelta(seconds=row)).isoformat(),
                    *[row + column / 100 for column in range(49)],
                    "abnormal" if row % 2 else "normal",
                ]
            )
    dataset = Dataset(
        id="a" * 32,
        owner_id=1,
        filename="wide.csv",
        size_bytes=source_path.stat().st_size,
        sha256=modeling._file_sha256(source_path),
        timestamp_column="timestamp",
        label_column="label",
        normal_label="normal",
        abnormal_label="abnormal",
        created_at=1,
        inspection=inspect_csv(source_path).model_dump(mode="json"),
    )

    return dataset, settings, channels


def test_index_is_nine_bytes_per_row_and_raw_csv_is_unchanged(streaming_dataset):
    dataset, settings, channels = streaming_dataset

    source = series_source.load_index(dataset, settings)

    assert source.times.nbytes + source.codes.nbytes == 3500 * 9
    assert not hasattr(source, "values")
    batches = list(
        series_source.value_batches(dataset, settings, source, channels[::-1], 900, 2101)
    )

    assert [len(batch.values) for batch in batches] == [1000, 201]
    assert batches[0].values[0].tolist() == [900 + column / 100 for column in reversed(range(49))]
    assert source.timestamp(2100) == datetime(2026, 1, 1) + timedelta(seconds=2100)
    assert (
        modeling._file_sha256(settings.dataset_storage_path / f"{dataset.id}.csv") == dataset.sha256
    )


def test_streaming_graph_matches_previous_minmax_buckets_and_page_labels(streaming_dataset):
    dataset, settings, channels = streaming_dataset

    selected_channels = channels[:8]

    response = series.get_series(dataset, settings, selected_channels, None, None, 64)

    reference_values = np.array(
        [[row + column / 100 for column in range(8)] for row in range(3500)]
    )

    expected_rows = series._sample_rows(reference_values, 0, 3500, 64)

    assert [point.row_index for point in response.points] == expected_rows
    intervals = series.get_label_intervals(dataset, settings, None, None, 1, limit=2, offset=1200)

    assert intervals.total == 1750
    assert [item.start_row for item in intervals.items] == [2401, 2403]
    assert intervals.cadence_seconds == 1


def test_prediction_pages_and_intervals_keep_model_batches_small(streaming_dataset, monkeypatch):
    dataset, settings, channels = streaming_dataset

    configuration = RunCreate(
        dataset_id=dataset.id,
        feature_columns=channels[::-1],
        models=["xgboost"],
        train_end=datetime(2026, 1, 1) + timedelta(seconds=999),
        validation_end=datetime(2026, 1, 1) + timedelta(seconds=2999),
    )

    model_run = ModelRun(
        id="b" * 32,
        status="completed",
        configuration=configuration.model_dump(mode="json"),
        input_sha256=dataset.sha256,
        training_report={
            "models": [{"model_key": "xgboost", "artifact_sha256": "c" * 64}],
            "split": {
                "train": {"start_row": 0, "end_row": 1000, "row_count": 1000},
                "validation": {"start_row": 1000, "end_row": 3000, "row_count": 2000},
                "test": {"start_row": 3000, "end_row": 3500, "row_count": 500},
            },
        },
    )

    batch_sizes = []

    class Estimator:
        classes_ = np.array([0, 1])

        def predict(self, features):
            assert len(features) <= series_source.BATCH_ROWS
            np.testing.assert_allclose(features[:, 0] - features[:, -1], 0.48)
            batch_sizes.append(len(features))
            return np.floor(features[:, -1]).astype(int) % 2

        def predict_proba(self, features):
            codes = np.floor(features[:, -1]).astype(int) % 2

            return np.column_stack([1 - codes, codes]).astype(float)

    monkeypatch.setattr(modeling, "load_trained_model", lambda *args, **kwargs: Estimator())
    result = series.get_predictions(
        model_run, dataset, settings, "validation", "xgboost", None, None, 1800, 100
    )

    assert result.total == 2000
    assert batch_sizes == [1000, 800]
    assert [point.row_index for point in result.items] == list(range(1100, 2900))
    batch_sizes.clear()
    intervals = series.get_prediction_intervals(
        model_run, dataset, settings, "validation", "xgboost", None, None, 1, 2, 500
    )

    assert batch_sizes == [1000, 1000]
    assert intervals.total == 1000
    assert [item.start_row for item in intervals.items] == [2001, 2003]
    assert intervals.cadence_seconds == 1


def test_csv_change_between_index_and_values_is_rejected(streaming_dataset):
    dataset, settings, channels = streaming_dataset

    source = series_source.load_index(dataset, settings)

    source_path = settings.dataset_storage_path / f"{dataset.id}.csv"

    with source_path.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(HTTPException) as error:
        list(series_source.value_batches(dataset, settings, source, channels, 0, 1))
    assert error.value.status_code == 409


def test_compact_index_bounds_preserve_same_instants_with_different_offsets():
    timestamp = datetime(2026, 1, 1, tzinfo=UTC)

    source = series_source.SourceIndex(
        times=np.array([series_source.time_number(timestamp)], dtype=np.int64),
        codes=np.array([0], dtype=np.uint8),
        timezone_mode="aware",
        stamp=(0, 0, 0, 0),
    )

    same_instant = datetime.fromisoformat("2026-01-01T09:00:00+09:00")

    assert source.bounds(same_instant, same_instant) == (0, 1)
    assert source.timestamp(0) == timestamp
