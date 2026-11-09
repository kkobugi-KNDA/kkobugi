"""원본 CSV를 바꾸지 않고 작은 시각 인덱스와 제한된 숫자 배치만 읽는다."""

import csv
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from fastapi import HTTPException

from app.config import Settings
from app.models import Dataset
from app.services import datasets as dataset_service
from app.services import modeling

BATCH_ROWS = 1000


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _stamp(path: Path) -> tuple[int, int, int, int]:
    attributes = path.stat()

    return attributes.st_mtime_ns, attributes.st_ctime_ns, attributes.st_size, attributes.st_ino


def time_number(timestamp: datetime) -> int:
    # 명시된 시간대만 UTC로 맞춘다. naive 시각을 현지 시간대로 추정하지 않는다.
    if timestamp.tzinfo is not None:
        timestamp = timestamp.astimezone(UTC)
    delta = timestamp.replace(tzinfo=None) - datetime.min

    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


@dataclass
class SourceIndex:
    times: np.ndarray

    codes: np.ndarray

    timezone_mode: str

    stamp: tuple[int, int, int, int]

    def timestamp(self, row: int) -> datetime:
        timestamp = datetime.min + timedelta(microseconds=int(self.times[row]))

        return timestamp.replace(tzinfo=UTC) if self.timezone_mode == "aware" else timestamp

    def bounds(self, start_time: datetime | None, end_time: datetime | None) -> tuple[int, int]:
        return (
            int(np.searchsorted(self.times, time_number(start_time), side="left"))
            if start_time is not None
            else 0,
            int(np.searchsorted(self.times, time_number(end_time), side="right"))
            if end_time is not None
            else len(self.times),
        )


@dataclass
class ValueBatch:
    start_row: int

    values: np.ndarray

    raw_labels: list[str]


def validate_channels(dataset: Dataset, channels: list[str]) -> None:
    inspection = dataset_service.dataset_detail(dataset).inspection

    if not inspection.is_valid:
        raise _error(422, "DATASET_NEEDS_REVIEW", "CSV 검사 항목을 먼저 확인하세요.")
    if (
        not channels
        or len(channels) != len(set(channels))
        or any(channel not in inspection.channels for channel in channels)
    ):
        raise _error(422, "INVALID_CHANNEL", "중복 없이 등록된 숫자 채널을 선택하세요.")


def load_index(dataset: Dataset, settings: Settings) -> SourceIndex:
    inspection = dataset_service.dataset_detail(dataset).inspection

    if not inspection.is_valid:
        raise _error(422, "DATASET_NEEDS_REVIEW", "CSV 검사 항목을 먼저 확인하세요.")
    try:
        source_path = dataset_service.dataset_file_path(dataset, settings)

        source_stamp = _stamp(source_path)

        if modeling._file_sha256(source_path) != dataset.sha256:
            raise _error(409, "DATASET_CHANGED", "등록 당시와 CSV 내용이 다릅니다.")
        # 49채널 float64 전체 배열 대신 행당 9바이트의 시각·라벨만 보관한다.
        times = np.empty(inspection.row_count, dtype=np.int64)

        codes = np.empty(inspection.row_count, dtype=np.uint8)

        label_mapping = {dataset.normal_label: 0, dataset.abnormal_label: 1}

        row_count = 0

        with source_path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, strict=True)

            columns = next(reader)

            timestamp_position = columns.index(dataset.timestamp_column)

            label_position = columns.index(dataset.label_column)

            for row in reader:
                if row_count >= len(times) or len(row) != len(columns):
                    raise ValueError("행 개수 오류")
                timestamp = datetime.fromisoformat(row[timestamp_position].strip())

                if (timestamp.tzinfo is not None) != (inspection.timezone_mode == "aware"):
                    raise ValueError("시간대 오류")
                if timestamp.tzinfo is not None:
                    timestamp = timestamp.astimezone(UTC)
                number = time_number(timestamp)

                if row_count and times[row_count - 1] >= number:
                    raise ValueError("시각 순서 오류")
                times[row_count] = number
                codes[row_count] = label_mapping[row[label_position].strip()]
                row_count += 1
        if not row_count or row_count != len(times):
            raise ValueError("시각·행 개수 오류")
        if _stamp(source_path) != source_stamp:
            raise _error(409, "DATASET_CHANGED", "CSV 확인 도중 원본이 변경됐습니다.")
        return SourceIndex(times, codes, inspection.timezone_mode, source_stamp)
    except (OSError, KeyError, ValueError, OverflowError, csv.Error, StopIteration):
        raise _error(503, "SERIES_UNAVAILABLE", "CSV 시계열을 읽지 못했습니다.") from None


def value_batches(
    dataset: Dataset,
    settings: Settings,
    source: SourceIndex,
    channels: list[str],
    start_row: int,
    end_row: int,
) -> Iterator[ValueBatch]:
    """조회 범위의 숫자만 최대 1,000행씩 변환하며 저장된 채널 순서를 유지한다."""
    if start_row >= end_row:
        return
    validate_channels(dataset, channels)
    try:
        source_path = dataset_service.dataset_file_path(dataset, settings)

        if _stamp(source_path) != source.stamp:
            raise _error(409, "DATASET_CHANGED", "등록 당시와 CSV 내용이 다릅니다.")
        with source_path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.reader(stream, strict=True)

            columns = next(reader)

            channel_positions = [columns.index(channel) for channel in channels]

            label_position = columns.index(dataset.label_column)

            values = np.empty((min(BATCH_ROWS, end_row - start_row), len(channels)), dtype=float)

            labels = []

            batch_start = start_row

            for row_index, row in enumerate(reader):
                if row_index < start_row:
                    continue
                if row_index >= end_row:
                    break
                if len(row) != len(columns):
                    raise ValueError("행 길이 오류")
                values[len(labels)] = [float(row[position]) for position in channel_positions]
                labels.append(row[label_position])
                if len(labels) == len(values):
                    if not np.isfinite(values).all():
                        raise ValueError("채널 값 오류")
                    yield ValueBatch(batch_start, values, labels)
                    batch_start += len(labels)
                    labels = []
                    values = np.empty(
                        (min(BATCH_ROWS, end_row - batch_start), len(channels)), dtype=float
                    )
            if labels:
                if not np.isfinite(values[: len(labels)]).all():
                    raise ValueError("채널 값 오류")
                yield ValueBatch(batch_start, values[: len(labels)], labels)
                batch_start += len(labels)
            if batch_start != end_row:
                raise ValueError("행 개수 오류")
        if _stamp(source_path) != source.stamp:
            raise _error(409, "DATASET_CHANGED", "CSV 확인 도중 원본이 변경됐습니다.")
    except (OSError, KeyError, ValueError, OverflowError, csv.Error, StopIteration):
        raise _error(503, "SERIES_UNAVAILABLE", "CSV 시계열을 읽지 못했습니다.") from None


def cadence_seconds(source: SourceIndex) -> float | None:
    if len(source.times) < 3:
        return None
    deltas, counts = np.unique(np.diff(source.times), return_counts=True)

    maximum = int(counts.max())

    if maximum < 2 or np.count_nonzero(counts == maximum) != 1:
        return None
    return int(deltas[int(np.argmax(counts))]) / 1_000_000
