"""전처리된 CSV를 한 행씩 검사한다. 보간·정렬·라벨 변경은 하지 않는다."""

import csv
import math
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from fastapi import HTTPException

from app.schemas.datasets import CsvInspection, InspectionIssue

METADATA_COLUMNS = frozenset({"machine_status", "all_sensors_missing"})


def _invalid_csv(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": "INVALID_CSV", "message": message})


def _validate_columns(
    columns: list[str] | None,
    timestamp_column: str,
    label_column: str,
    max_columns: int,
) -> list[str]:
    if not columns or any(not column.strip() for column in columns):
        raise _invalid_csv("CSV에 비어 있지 않은 컬럼명이 필요합니다.")
    if len(columns) > max_columns:
        raise _invalid_csv(f"CSV는 최대 {max_columns}개 컬럼까지 등록할 수 있습니다.")
    if len(columns) != len(set(columns)):
        raise _invalid_csv("CSV에 중복된 컬럼명이 있습니다.")
    if timestamp_column not in columns or label_column not in columns:
        raise _invalid_csv("선택한 시간 컬럼과 라벨 컬럼이 CSV에 모두 있어야 합니다.")

    channels = [
        column
        for column in columns
        if column not in {timestamp_column, label_column} and column not in METADATA_COLUMNS
    ]

    if not channels:
        raise _invalid_csv("시간과 라벨 외에 숫자 채널이 한 개 이상 필요합니다.")
    return channels


def inspect_csv(
    file_path: Path,
    timestamp_column: str = "timestamp",
    label_column: str = "label",
    normal_label: str = "normal",
    abnormal_label: str = "abnormal",
    max_rows: int = 1_000_000,
    max_columns: int = 256,
) -> CsvInspection:
    """읽을 수 없는 구조는 거부하고, 데이터 품질 문제는 검사 결과로 돌려준다."""

    if not timestamp_column.strip() or not label_column.strip() or timestamp_column == label_column:
        raise _invalid_csv("시간 컬럼과 라벨 컬럼은 서로 다른 이름으로 지정하세요.")
    if (
        not normal_label
        or not abnormal_label
        or normal_label != normal_label.strip()
        or abnormal_label != abnormal_label.strip()
        or normal_label == abnormal_label
    ):
        raise _invalid_csv("정상·이상 라벨은 앞뒤 공백 없이 서로 다른 값으로 지정하세요.")

    try:
        # utf-8-sig는 BOM이 있는 UTF-8과 일반 UTF-8을 모두 읽는다.
        with file_path.open("r", encoding="utf-8-sig", newline="") as csv_file:
            csv_rows = csv.reader(csv_file, strict=True)

            columns = next(csv_rows, None)

            channels = _validate_columns(columns, timestamp_column, label_column, max_columns)

            return _inspect_rows(
                csv_rows,
                columns,
                channels,
                timestamp_column,
                label_column,
                normal_label,
                abnormal_label,
                max_rows,
            )
    except UnicodeDecodeError:
        raise _invalid_csv("CSV는 UTF-8 인코딩으로 저장해서 등록하세요.") from None
    except csv.Error:
        # 파서의 원문 오류는 셀 내용을 포함할 수 있어 고정된 설명만 반환한다.
        raise _invalid_csv("CSV의 따옴표, 구분자 또는 셀 길이를 확인하세요.") from None


def _inspect_rows(
    csv_rows: Iterator[list[str]],
    columns: list[str],
    channels: list[str],
    timestamp_column: str,
    label_column: str,
    normal_label: str,
    abnormal_label: str,
    max_rows: int,
) -> CsvInspection:
    row_count = 0

    missing_counts = dict.fromkeys(columns, 0)

    invalid_numeric_counts = dict.fromkeys(channels, 0)

    label_counts = {normal_label: 0, abnormal_label: 0}

    invalid_label_count = 0

    invalid_timestamp_count = 0

    duplicate_timestamp_count = 0

    out_of_order_count = 0

    timestamp_modes: set[str] = set()

    seen_timestamps: set[datetime] = set()

    previous_timestamp: datetime | None = None

    earliest_timestamp: datetime | None = None

    latest_timestamp: datetime | None = None

    preview: list[dict[str, str]] = []

    preview_truncated = False

    for csv_row in csv_rows:
        row_count += 1

        if row_count > max_rows:
            raise HTTPException(
                status_code=413,
                detail={
                    "code": "DATASET_TOO_LARGE",
                    "message": f"CSV는 최대 {max_rows}개 데이터 행까지 등록할 수 있습니다.",
                },
            )
        if len(csv_row) != len(columns):
            raise _invalid_csv(f"{row_count}번째 데이터 행의 셀 개수가 컬럼 수와 다릅니다.")

        row_values = dict(zip(columns, csv_row, strict=True))

        # 표 미리보기는 5행만 보관한다. 긴 셀은 표시 제한 여부를 함께 알린다.
        if row_count <= 5:
            preview.append({column: value[:128] for column, value in row_values.items()})
            if any(len(value) > 128 for value in csv_row):
                preview_truncated = True

        for column, raw_value in row_values.items():
            cell_value = raw_value.strip()

            if not cell_value:
                missing_counts[column] += 1

                continue
            if column in invalid_numeric_counts:
                try:
                    numeric_value = float(cell_value)

                    if not math.isfinite(numeric_value):
                        invalid_numeric_counts[column] += 1

                except ValueError:
                    invalid_numeric_counts[column] += 1

            elif column == label_column:
                if cell_value in label_counts:
                    label_counts[cell_value] += 1

                else:
                    invalid_label_count += 1

            elif column == timestamp_column:
                try:
                    timestamp = datetime.fromisoformat(cell_value)

                    # 시간대가 명시된 값끼리만 UTC로 맞춰 같은 순간인지 비교한다.
                    timestamp_mode = "aware" if timestamp.tzinfo is not None else "naive"

                    if timestamp_mode == "aware":
                        timestamp = timestamp.astimezone(UTC)

                except (ValueError, OverflowError):
                    invalid_timestamp_count += 1

                    continue

                timestamp_modes.add(timestamp_mode)
                if timestamp in seen_timestamps:
                    duplicate_timestamp_count += 1

                seen_timestamps.add(timestamp)
                if (
                    previous_timestamp is not None
                    and (timestamp.tzinfo is None) == (previous_timestamp.tzinfo is None)
                    and timestamp < previous_timestamp
                ):
                    out_of_order_count += 1

                previous_timestamp = timestamp

                if earliest_timestamp is None:
                    earliest_timestamp = timestamp

                    latest_timestamp = timestamp

                elif (timestamp.tzinfo is None) == (earliest_timestamp.tzinfo is None):
                    earliest_timestamp = min(earliest_timestamp, timestamp)

                    latest_timestamp = max(latest_timestamp, timestamp)

    if row_count == 0:
        raise _invalid_csv("컬럼명 외에 데이터 행이 한 개 이상 필요합니다.")

    issues: list[InspectionIssue] = []

    ignored_columns = [
        column
        for column in columns
        if column in METADATA_COLUMNS and column not in {timestamp_column, label_column}
    ]

    for column, missing_count in missing_counts.items():
        if missing_count:
            issues.append(
                InspectionIssue(
                    code="MISSING_VALUES",
                    message="비어 있는 값이 있습니다.",
                    column=column,
                    count=missing_count,
                    severity="warning" if column in ignored_columns else "error",
                )
            )
    for column, invalid_count in invalid_numeric_counts.items():
        if invalid_count:
            issues.append(
                InspectionIssue(
                    code="INVALID_NUMERIC_VALUES",
                    message="유한한 숫자로 읽을 수 없는 값이 있습니다.",
                    column=column,
                    count=invalid_count,
                )
            )

    if ignored_columns:
        issues.append(
            InspectionIssue(
                code="METADATA_EXCLUDED",
                message="조업 상태·결측 표시 열은 원본에 보관하고 학습 입력에서 제외합니다.",
                count=len(ignored_columns),
                severity="warning",
            )
        )

    # 원본 행은 유지하고, 사용자가 고쳐야 할 항목과 개수만 정리한다.
    timestamp_checks = [
        (
            "INVALID_TIMESTAMP",
            "날짜와 시각으로 읽을 수 없는 값이 있습니다.",
            invalid_timestamp_count,
        ),
        ("DUPLICATE_TIMESTAMP", "같은 시각이 반복됩니다.", duplicate_timestamp_count),
        ("OUT_OF_ORDER_TIMESTAMP", "앞 행보다 이른 시각이 있습니다.", out_of_order_count),
    ]

    for issue_code, issue_message, issue_count in timestamp_checks:
        if issue_count:
            issues.append(
                InspectionIssue(
                    code=issue_code,
                    message=issue_message,
                    column=timestamp_column,
                    count=issue_count,
                )
            )
    if invalid_label_count:
        issues.append(
            InspectionIssue(
                code="INVALID_LABELS",
                message="지정한 정상·이상 라벨에 해당하지 않는 값이 있습니다.",
                column=label_column,
                count=invalid_label_count,
            )
        )

    timezone_mode = next(iter(timestamp_modes)) if timestamp_modes else None

    if len(timestamp_modes) > 1:
        timezone_mode = "mixed"

        # 두 시간대의 선후 관계를 추정하지 않고 시간 범위를 비워 둔다.
        earliest_timestamp = None

        latest_timestamp = None

        issues.append(
            InspectionIssue(
                code="MIXED_TIMEZONES",
                message="시간대가 있는 시각과 없는 시각이 섞여 있습니다.",
                column=timestamp_column,
            )
        )

    return CsvInspection(
        row_count=row_count,
        column_count=len(columns),
        columns=columns,
        channels=channels,
        ignored_columns=ignored_columns,
        timestamp_column=timestamp_column,
        label_column=label_column,
        time_start=earliest_timestamp.isoformat() if earliest_timestamp is not None else None,
        time_end=latest_timestamp.isoformat() if latest_timestamp is not None else None,
        timezone_mode=timezone_mode,
        invalid_timestamp_count=invalid_timestamp_count,
        duplicate_timestamp_count=duplicate_timestamp_count,
        out_of_order_count=out_of_order_count,
        missing_counts=missing_counts,
        invalid_numeric_counts=invalid_numeric_counts,
        label_counts=label_counts,
        invalid_label_count=invalid_label_count,
        issues=issues,
        preview=preview,
        preview_truncated=preview_truncated,
        is_valid=not any(issue.severity == "error" for issue in issues),
    )
