"""CSV를 바꾸지 않고 같은 시간축의 그래프·라벨·모델 예측을 읽는다."""

from bisect import bisect_left, bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np
import pandas as pd
from fastapi import HTTPException
from pydantic import ValidationError
from threadpoolctl import threadpool_limits

from app.config import Settings
from app.models import Dataset, ModelRun
from app.schemas.runs import ModelKey, RunCreate, SplitInfo
from app.schemas.series import (
    LabelIntervals,
    PredictionContext,
    PredictionIntervals,
    PredictionPoint,
    PredictionResponse,
    PredictionSplit,
    SeriesPoint,
    SeriesResponse,
    TimeInterval,
)
from app.services import datasets as dataset_service
from app.services import modeling


@dataclass
class SourceSeries:
    timestamps: list[datetime]

    values: np.ndarray

    raw_labels: list[str]

    codes: np.ndarray


def _series_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def format_timestamp(timestamp: datetime) -> str:
    # 시간대가 없는 원본을 한국 시각이나 UTC로 임의 해석하지 않는다.
    if timestamp.tzinfo is not None:
        timestamp = timestamp.astimezone(UTC)

    return timestamp.isoformat(timespec="microseconds")


def normalize_time_bounds(
    timezone_mode: str, start_time: datetime | None, end_time: datetime | None
) -> tuple[datetime | None, datetime | None]:
    if timezone_mode not in {"naive", "aware"}:
        raise _series_error(422, "DATASET_NEEDS_REVIEW", "CSV의 시각 검사 결과를 확인하세요.")
    for timestamp in (start_time, end_time):
        if timestamp is not None and (timestamp.tzinfo is not None) != (timezone_mode == "aware"):
            raise _series_error(
                422, "TIMEZONE_MISMATCH", "CSV와 조회 시각의 시간대 표기를 맞추세요."
            )
    if timezone_mode == "aware":
        try:
            start_time = start_time.astimezone(UTC) if start_time is not None else None

            end_time = end_time.astimezone(UTC) if end_time is not None else None

        except (OverflowError, ValueError):
            # ISO 형식이어도 UTC 변환 후 지원하는 연도 범위를 벗어날 수 있다.
            raise _series_error(
                422, "INVALID_TIME_RANGE", "지원하는 날짜 범위 안의 시각을 입력하세요."
            ) from None

    if start_time is not None and end_time is not None and start_time > end_time:
        raise _series_error(
            422, "INVALID_TIME_RANGE", "시작 시각은 종료 시각보다 늦을 수 없습니다."
        )
    return start_time, end_time


def _load_source(dataset: Dataset, settings: Settings, channels: list[str]) -> SourceSeries:
    inspection = dataset_service.dataset_detail(dataset).inspection

    if not inspection.is_valid:
        raise _series_error(422, "DATASET_NEEDS_REVIEW", "CSV 검사 항목을 먼저 확인하세요.")
    if (
        not channels
        or len(channels) != len(set(channels))
        or any(channel not in inspection.channels for channel in channels)
    ):
        raise _series_error(422, "INVALID_CHANNEL", "중복 없이 등록된 숫자 채널을 선택하세요.")
    try:
        source_path = dataset_service.dataset_file_path(dataset, settings)

        if modeling._file_sha256(source_path) != dataset.sha256:
            raise _series_error(409, "DATASET_CHANGED", "등록 당시와 CSV 내용이 다릅니다.")
        source_frame = pd.read_csv(
            source_path,
            encoding="utf-8-sig",
            usecols=[dataset.timestamp_column, dataset.label_column, *channels],
            dtype={dataset.timestamp_column: str, dataset.label_column: str},
            keep_default_na=False,
        )

        timestamps = [
            datetime.fromisoformat(str(value).strip())
            for value in source_frame[dataset.timestamp_column]
        ]

        if not timestamps or len(timestamps) != inspection.row_count:
            raise ValueError("시각·행 개수 오류")
        if any(
            (timestamp.tzinfo is not None) != (inspection.timezone_mode == "aware")
            for timestamp in timestamps
        ):
            raise ValueError("시간대 오류")
        if inspection.timezone_mode == "aware":
            timestamps = [timestamp.astimezone(UTC) for timestamp in timestamps]

        if any(left >= right for left, right in zip(timestamps, timestamps[1:])):
            raise ValueError("시각 순서 오류")
        values = source_frame[channels].to_numpy(dtype=float)

        raw_labels = source_frame[dataset.label_column].astype(str).tolist()

        label_mapping = {dataset.normal_label: 0, dataset.abnormal_label: 1}

        codes = np.array([label_mapping[label.strip()] for label in raw_labels], dtype=int)

        if not np.isfinite(values).all():
            raise ValueError("채널 값 오류")
        return SourceSeries(
            timestamps=timestamps, values=values, raw_labels=raw_labels, codes=codes
        )
    except (OSError, KeyError, ValueError, OverflowError, pd.errors.ParserError):
        # 내부 파일 경로나 역직렬화 오류 원문은 응답에 넣지 않는다.
        raise _series_error(503, "SERIES_UNAVAILABLE", "CSV 시계열을 읽지 못했습니다.") from None


def _row_bounds(
    timestamps: list[datetime], start_time: datetime | None, end_time: datetime | None
) -> tuple[int, int]:
    return (
        bisect_left(timestamps, start_time) if start_time is not None else 0,
        bisect_right(timestamps, end_time) if end_time is not None else len(timestamps),
    )


def _sample_rows(values: np.ndarray, start_row: int, end_row: int, max_points: int) -> list[int]:
    if end_row - start_row <= max_points:
        return list(range(start_row, end_row))
    # 모든 채널이 같은 원본 행들을 쓰므로 세로로 맞춘 그래프의 시각도 일치한다.
    channel_count = values.shape[1]

    bucket_count = (max_points - 2) // (2 * channel_count)

    boundaries = np.linspace(start_row + 1, end_row - 1, bucket_count + 1, dtype=int)

    selected_rows = {start_row, end_row - 1}

    for left_row, right_row in zip(boundaries, boundaries[1:]):
        if right_row <= left_row:
            continue
        bucket_values = values[left_row:right_row]

        for channel_index in range(channel_count):
            selected_rows.add(left_row + int(np.argmin(bucket_values[:, channel_index])))
            selected_rows.add(left_row + int(np.argmax(bucket_values[:, channel_index])))
    return sorted(selected_rows)


def get_series(
    dataset: Dataset,
    settings: Settings,
    channels: list[str],
    start_time: datetime | None,
    end_time: datetime | None,
    max_points: int,
) -> SeriesResponse:
    inspection = dataset_service.dataset_detail(dataset).inspection

    start_time, end_time = normalize_time_bounds(inspection.timezone_mode, start_time, end_time)

    source = _load_source(dataset, settings, channels)

    start_row, end_row = _row_bounds(source.timestamps, start_time, end_time)

    selected_rows = _sample_rows(source.values, start_row, end_row, max_points)

    matched_count = end_row - start_row

    return SeriesResponse(
        dataset_id=dataset.id,
        channels=channels,
        timestamp_column=dataset.timestamp_column,
        normal_label=dataset.normal_label,
        abnormal_label=dataset.abnormal_label,
        timezone_mode=inspection.timezone_mode,
        start_time=format_timestamp(source.timestamps[start_row]) if matched_count else None,
        end_time=format_timestamp(source.timestamps[end_row - 1]) if matched_count else None,
        matched_count=matched_count,
        returned_count=len(selected_rows),
        downsampled=matched_count > len(selected_rows),
        sampling_method="min_max" if matched_count > len(selected_rows) else "none",
        points=[
            SeriesPoint(
                row_index=row_index,
                timestamp=format_timestamp(source.timestamps[row_index]),
                values=dict(zip(channels, source.values[row_index].tolist(), strict=True)),
                actual_label=source.raw_labels[row_index],
                actual_code=int(source.codes[row_index]),
            )
            for row_index in selected_rows
        ],
    )


def _cadence_seconds(timestamps: list[datetime]) -> float | None:
    # 한 번 나타난 간격이나 동률인 간격을 정상 주기로 단정하지 않는다.
    delta_counts = Counter(
        (right - left).total_seconds() for left, right in zip(timestamps, timestamps[1:])
    )

    common_deltas = delta_counts.most_common(2)

    if not common_deltas or common_deltas[0][1] < 2:
        return None
    if len(common_deltas) > 1 and common_deltas[0][1] == common_deltas[1][1]:
        return None
    return common_deltas[0][0]


def _intervals(
    timestamps: list[datetime], row_indices: list[int], codes: np.ndarray, code: int
) -> tuple[list[TimeInterval], float | None]:
    cadence = _cadence_seconds(timestamps)

    intervals = []

    selected_rows = [row for row, value in zip(row_indices, codes, strict=True) if value == code]

    for row in selected_rows:
        if (
            intervals
            and cadence is not None
            and intervals[-1].end_row == row
            and (timestamps[row] - timestamps[row - 1]).total_seconds() == cadence
        ):
            intervals[-1].end_row = row + 1

            intervals[-1].end_time = format_timestamp(timestamps[row])

            intervals[-1].row_count += 1

        else:
            intervals.append(
                TimeInterval(
                    start_time=format_timestamp(timestamps[row]),
                    end_time=format_timestamp(timestamps[row]),
                    start_row=row,
                    end_row=row + 1,
                    row_count=1,
                )
            )
    return intervals, cadence


def get_label_intervals(
    dataset: Dataset,
    settings: Settings,
    start_time: datetime | None,
    end_time: datetime | None,
    code: int,
    limit: int,
    offset: int,
) -> LabelIntervals:
    inspection = dataset_service.dataset_detail(dataset).inspection

    start_time, end_time = normalize_time_bounds(inspection.timezone_mode, start_time, end_time)

    # 구간 표시는 그래프 축약과 별도로 모든 라벨을 읽어 한 관측짜리 이상도 남긴다.
    source = _load_source(dataset, settings, inspection.channels[:1])

    start_row, end_row = _row_bounds(source.timestamps, start_time, end_time)

    intervals, cadence = _intervals(
        source.timestamps, list(range(start_row, end_row)), source.codes[start_row:end_row], code
    )

    return LabelIntervals(
        dataset_id=dataset.id,
        code=code,
        normal_label=dataset.normal_label,
        abnormal_label=dataset.abnormal_label,
        timezone_mode=inspection.timezone_mode,
        cadence_seconds=cadence,
        items=intervals[offset : offset + limit],
        total=len(intervals),
        limit=limit,
        offset=offset,
    )


def validate_observation_interval(
    dataset: Dataset,
    settings: Settings,
    channel: str,
    start_time: datetime,
    end_time: datetime,
) -> tuple[str, str]:
    inspection = dataset_service.dataset_detail(dataset).inspection

    start_time, end_time = normalize_time_bounds(inspection.timezone_mode, start_time, end_time)

    source = _load_source(dataset, settings, [channel])

    if start_time < source.timestamps[0] or end_time > source.timestamps[-1]:
        raise _series_error(
            422, "OBSERVATION_OUTSIDE_DATA", "관찰 구간을 CSV 관측 기간 안에 지정하세요."
        )
    start_row, end_row = _row_bounds(source.timestamps, start_time, end_time)

    if start_row == end_row:
        raise _series_error(
            422, "EMPTY_OBSERVATION_INTERVAL", "실제 관측값이 있는 구간을 선택하세요."
        )
    return format_timestamp(start_time), format_timestamp(end_time)


def _prediction_source(
    model_run: ModelRun,
    dataset: Dataset,
    settings: Settings,
    split_name: PredictionSplit,
    model_key: ModelKey | None,
    start_time: datetime | None,
    end_time: datetime | None,
) -> tuple[PredictionContext, SourceSeries, object, int, int]:
    if model_run.status != "completed":
        raise _series_error(409, "RUN_NOT_COMPLETED", "모델 학습이 완료된 뒤 예측을 조회하세요.")
    selected_key = model_key or model_run.selected_model

    if selected_key is None:
        raise _series_error(409, "MODEL_NOT_SELECTED", "예측을 볼 모델을 지정하거나 선택하세요.")
    # Test를 읽는 GET이 평가를 시작하거나 모델 선택을 우회하지 않도록 먼저 막는다.
    if split_name == "test" and (
        model_run.evaluation_status != "completed" or selected_key != model_run.selected_model
    ):
        raise _series_error(409, "TEST_NOT_EVALUATED", "선택한 모델의 Test 평가를 먼저 완료하세요.")
    try:
        configuration = RunCreate.model_validate(model_run.configuration)

        training_report = model_run.training_report or {}

        model_report = next(
            (
                result
                for result in training_report.get("models", [])
                if result["model_key"] == selected_key
            ),
            None,
        )

        if selected_key not in configuration.models or model_report is None:
            raise _series_error(422, "MODEL_NOT_TRAINED", "이 실행에서 학습한 모델을 선택하세요.")
        if dataset.sha256 != model_run.input_sha256:
            raise ValueError("원본 정보 불일치")
        inspection = dataset_service.dataset_detail(dataset).inspection

        start_time, end_time = normalize_time_bounds(inspection.timezone_mode, start_time, end_time)

        source = _load_source(dataset, settings, configuration.feature_columns)

        partition = getattr(SplitInfo.model_validate(training_report["split"]), split_name)

        # 저장된 분할이 사용자 경계와 일치하는지 확인하고 그 분할 밖의 행은 보내지 않는다.
        train_end = bisect_right(source.timestamps, configuration.train_end)

        validation_end = bisect_right(source.timestamps, configuration.validation_end)

        expected_bounds = (
            (train_end, validation_end)
            if split_name == "validation"
            else (validation_end, len(source.timestamps))
        )

        if (partition.start_row, partition.end_row) != expected_bounds:
            raise ValueError("저장된 분할 정보 불일치")
        query_start, query_end = _row_bounds(source.timestamps, start_time, end_time)

        start_row = max(partition.start_row, query_start)

        end_row = max(start_row, min(partition.end_row, query_end))

        model_directory = (settings.model_storage_path.resolve() / model_run.id).resolve()

        if model_directory.parent != settings.model_storage_path.resolve():
            raise ValueError("모델 위치 오류")
        estimator = modeling.load_trained_model(
            dataset_service.dataset_file_path(dataset, settings),
            configuration,
            normal_label=dataset.normal_label,
            abnormal_label=dataset.abnormal_label,
            expected_sha256=model_run.input_sha256,
            artifact_directory=model_directory,
            model_key=selected_key,
            expected_artifact_sha256=model_report["artifact_sha256"],
            timestamp_column=dataset.timestamp_column,
            label_column=dataset.label_column,
        )

        context = PredictionContext(
            run_id=model_run.id,
            dataset_id=dataset.id,
            model_key=selected_key,
            split=split_name,
            score_type="reconstruction_error" if selected_key == "autoencoder" else "probability",
            threshold=float(estimator.threshold_) if selected_key == "autoencoder" else None,
            input_sha256=model_run.input_sha256,
            artifact_sha256=model_report["artifact_sha256"],
        )

        return context, source, estimator, start_row, end_row
    except (OSError, ValueError, KeyError, TypeError, ValidationError):
        raise _series_error(
            503, "PREDICTION_UNAVAILABLE", "저장된 모델과 CSV를 확인하지 못했습니다."
        ) from None


def _predict(estimator, features: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    if len(features) == 0:
        return np.array([], dtype=int), np.array([], dtype=float)
    try:
        with threadpool_limits(limits=1):
            predicted_codes = np.asarray(estimator.predict(features), dtype=int)

            scores = np.asarray(modeling._anomaly_scores(estimator, features), dtype=float)

    except (ValueError, TypeError, OverflowError):
        raise _series_error(
            503, "PREDICTION_UNAVAILABLE", "모델 예측값을 확인하지 못했습니다."
        ) from None
    if not np.isfinite(scores).all() or not np.isin(predicted_codes, [0, 1]).all():
        raise _series_error(503, "PREDICTION_UNAVAILABLE", "모델 예측값을 확인하지 못했습니다.")
    return predicted_codes, scores


def get_predictions(
    model_run: ModelRun,
    dataset: Dataset,
    settings: Settings,
    split_name: PredictionSplit,
    model_key: ModelKey | None,
    start_time: datetime | None,
    end_time: datetime | None,
    limit: int,
    offset: int,
) -> PredictionResponse:
    context, source, estimator, start_row, end_row = _prediction_source(
        model_run, dataset, settings, split_name, model_key, start_time, end_time
    )

    page_start = min(start_row + offset, end_row)

    page_end = min(page_start + limit, end_row)

    predicted_codes, scores = _predict(estimator, source.values[page_start:page_end])

    return PredictionResponse(
        **context.model_dump(),
        total=end_row - start_row,
        limit=limit,
        offset=offset,
        items=[
            PredictionPoint(
                row_index=row_index,
                timestamp=format_timestamp(source.timestamps[row_index]),
                actual_label=source.raw_labels[row_index],
                actual_code=int(source.codes[row_index]),
                predicted_label=dataset.abnormal_label
                if predicted_codes[page_index]
                else dataset.normal_label,
                predicted_code=int(predicted_codes[page_index]),
                score=float(scores[page_index]),
            )
            for page_index, row_index in enumerate(range(page_start, page_end))
        ],
    )


def get_prediction_intervals(
    model_run: ModelRun,
    dataset: Dataset,
    settings: Settings,
    split_name: PredictionSplit,
    model_key: ModelKey | None,
    start_time: datetime | None,
    end_time: datetime | None,
    predicted_code: int,
    limit: int,
    offset: int,
) -> PredictionIntervals:
    context, source, estimator, start_row, end_row = _prediction_source(
        model_run, dataset, settings, split_name, model_key, start_time, end_time
    )

    predicted_codes, _ = _predict(estimator, source.values[start_row:end_row])

    intervals, cadence = _intervals(
        source.timestamps, list(range(start_row, end_row)), predicted_codes, predicted_code
    )

    return PredictionIntervals(
        **context.model_dump(),
        predicted_code=predicted_code,
        cadence_seconds=cadence,
        items=intervals[offset : offset + limit],
        total=len(intervals),
        limit=limit,
        offset=offset,
    )
