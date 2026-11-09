"""전체 CSV 검사 결과와 원본 보존, 시간대·라벨 해석 규칙을 확인한다."""

import csv
import io

import pytest
from fastapi import HTTPException

from app.services.csv_inspection import inspect_csv


@pytest.fixture
def write_csv(tmp_path):
    def create_csv(rows, *, encoding="utf-8"):
        output = io.StringIO(newline="")

        csv.writer(output).writerows(rows)
        csv_path = tmp_path / "prepared.csv"

        csv_path.write_bytes(output.getvalue().encode(encoding))
        return csv_path

    return create_csv


def test_inspection_preserves_original_bytes_and_reports_all_columns(write_csv):
    csv_path = write_csv(
        [
            ["timestamp", "sensor_00", "sensor_01", "label"],
            ["2026-11-09 01:00:00", "10.0", "20", "normal"],
            ["2026-11-09 01:01:00", "11.0", "21", "abnormal"],
        ]
    )

    original_bytes = csv_path.read_bytes()

    inspection = inspect_csv(csv_path)

    assert inspection.is_valid
    assert inspection.row_count == 2
    assert inspection.column_count == 4
    assert inspection.channels == ["sensor_00", "sensor_01"]
    assert inspection.missing_counts == dict.fromkeys(inspection.columns, 0)
    assert inspection.invalid_numeric_counts == {"sensor_00": 0, "sensor_01": 0}
    assert inspection.label_counts == {"normal": 1, "abnormal": 1}
    assert inspection.timezone_mode == "naive"
    assert inspection.time_start == "2026-11-09T01:00:00"
    assert inspection.time_end == "2026-11-09T01:01:00"
    assert inspection.preview[0]["sensor_00"] == "10.0"
    assert inspection.issues == []
    assert csv_path.read_bytes() == original_bytes


def test_utf8_bom_and_quoted_korean_column_are_supported(write_csv):
    csv_path = write_csv(
        [["timestamp", "압력,채널", "label"], ["2026-11-09T01:00:00", "10", "normal"]],
        encoding="utf-8-sig",
    )

    inspection = inspect_csv(csv_path)

    assert inspection.is_valid
    assert inspection.columns == ["timestamp", "압력,채널", "label"]
    assert inspection.label_counts == {"normal": 1, "abnormal": 0}


def test_column_roles_and_binary_labels_are_explicitly_configurable(write_csv):
    csv_path = write_csv([["time", "pressure", "target"], ["2026-11-09T01:00:00", "10", "0"]])

    inspection = inspect_csv(
        csv_path,
        timestamp_column="time",
        label_column="target",
        normal_label="0",
        abnormal_label="1",
    )

    assert inspection.is_valid
    assert inspection.channels == ["pressure"]
    assert inspection.label_counts == {"0": 1, "1": 0}
    assert inspection.timestamp_column == "time"
    assert inspection.label_column == "target"


def test_numeric_labels_are_not_silently_treated_as_normal_abnormal(write_csv):
    csv_path = write_csv([["timestamp", "sensor", "label"], ["2026-11-09T01:00:00", "10", "1"]])

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.invalid_label_count == 1
    assert inspection.label_counts == {"normal": 0, "abnormal": 0}


def test_missing_and_invalid_values_are_distinct_and_rows_are_kept(write_csv):
    csv_path = write_csv(
        [
            ["timestamp", "sensor_00", "sensor_01", "label"],
            ["not-a-time", "NaN", "", "BROKEN"],
            ["", "", "text", ""],
        ]
    )

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.row_count == 2
    assert inspection.invalid_timestamp_count == 1
    assert inspection.invalid_numeric_counts == {"sensor_00": 1, "sensor_01": 1}
    assert inspection.invalid_label_count == 1
    assert inspection.missing_counts == {
        "timestamp": 1,
        "sensor_00": 1,
        "sensor_01": 1,
        "label": 1,
    }
    assert inspection.preview[0]["sensor_00"] == "NaN"
    assert inspection.timezone_mode is None
    assert inspection.time_start is None
    assert inspection.time_end is None


@pytest.mark.parametrize("invalid_value", ["NaN", "nan", "inf", "-inf", "Infinity", "text", "1,2"])
def test_nonfinite_and_non_numeric_channel_values_need_review(write_csv, invalid_value):
    csv_path = write_csv(
        [["timestamp", "sensor", "label"], ["2026-11-09T01:00:00", invalid_value, "normal"]]
    )

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.invalid_numeric_counts == {"sensor": 1}
    assert inspection.missing_counts["sensor"] == 0


def test_duplicates_and_backward_time_are_counted_without_sorting(write_csv):
    csv_path = write_csv(
        [
            ["timestamp", "sensor", "label"],
            ["2026-11-09T01:10:00", "1", "normal"],
            ["2026-11-09T01:10:00", "2", "normal"],
            ["2026-11-09T01:09:00", "3", "abnormal"],
        ]
    )

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.duplicate_timestamp_count == 1
    assert inspection.out_of_order_count == 1
    assert inspection.time_start == "2026-11-09T01:09:00"
    assert inspection.time_end == "2026-11-09T01:10:00"
    assert [row["sensor"] for row in inspection.preview] == ["1", "2", "3"]


def test_offsets_are_compared_as_the_same_instant(write_csv):
    # +09:00과 Z는 같은 순간일 수 있지만, 원본의 문자열 자체는 수정하지 않는다.
    csv_path = write_csv(
        [
            ["timestamp", "sensor", "label"],
            ["2026-11-09T09:00:00+09:00", "1", "normal"],
            ["2026-11-09T00:00:00Z", "2", "normal"],
            ["2026-11-08T23:59:00Z", "3", "abnormal"],
        ]
    )

    inspection = inspect_csv(csv_path)

    assert inspection.timezone_mode == "aware"
    assert inspection.duplicate_timestamp_count == 1
    assert inspection.out_of_order_count == 1
    assert inspection.time_start == "2026-11-08T23:59:00+00:00"
    assert inspection.time_end == "2026-11-09T00:00:00+00:00"
    assert inspection.preview[0]["timestamp"] == "2026-11-09T09:00:00+09:00"


def test_mixed_timezone_does_not_invent_a_common_time_range(write_csv):
    csv_path = write_csv(
        [
            ["timestamp", "sensor", "label"],
            ["2026-11-09T01:00:00", "1", "normal"],
            ["2026-11-09T01:01:00Z", "2", "abnormal"],
        ]
    )

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.timezone_mode == "mixed"
    assert inspection.time_start is None
    assert inspection.time_end is None
    assert "MIXED_TIMEZONES" in {issue.code for issue in inspection.issues}


@pytest.mark.parametrize(
    "invalid_timestamp", ["not-a-time", "2026-99-99", "9999-12-31T23:59:59-23:59"]
)
def test_invalid_or_overflowing_timestamps_are_reported(write_csv, invalid_timestamp):
    csv_path = write_csv([["timestamp", "sensor", "label"], [invalid_timestamp, "1", "normal"]])

    inspection = inspect_csv(csv_path)

    assert not inspection.is_valid
    assert inspection.invalid_timestamp_count == 1
    assert inspection.timezone_mode is None


@pytest.mark.parametrize(
    "contents",
    [
        "",
        "timestamp,sensor,label\n",
        ",sensor,label\n2026-11-09,1,normal\n",
        "timestamp,sensor,sensor,label\n2026-11-09,1,2,normal\n",
        "time,sensor,label\n2026-11-09,1,normal\n",
        "timestamp,label\n2026-11-09,normal\n",
        "timestamp,sensor,label\n2026-11-09,1\n",
        "timestamp,sensor,label\n2026-11-09,1,normal,extra\n",
        'timestamp,sensor,label\n2026-11-09,"not closed,normal\n',
        "timestamp,sensor,label\n\n",
    ],
)
def test_unreadable_csv_structure_is_rejected(tmp_path, contents):
    csv_path = tmp_path / "invalid.csv"

    csv_path.write_text(contents, encoding="utf-8")
    with pytest.raises(HTTPException) as error:
        inspect_csv(csv_path)
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "INVALID_CSV"


def test_non_utf8_csv_is_rejected(tmp_path):
    csv_path = tmp_path / "cp949.csv"

    csv_path.write_bytes("timestamp,압력,label\n2026-11-09,1,normal\n".encode("cp949"))
    with pytest.raises(HTTPException) as error:
        inspect_csv(csv_path)
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "INVALID_CSV"


@pytest.mark.parametrize(
    "options",
    [
        {"timestamp_column": "label"},
        {"timestamp_column": " "},
        {"label_column": ""},
        {"normal_label": "abnormal"},
        {"normal_label": ""},
        {"abnormal_label": " "},
        {"normal_label": " normal"},
    ],
)
def test_column_roles_and_label_mapping_must_be_unambiguous(write_csv, options):
    csv_path = write_csv([["timestamp", "sensor", "label"], ["2026-11-09T01:00:00", "1", "normal"]])

    with pytest.raises(HTTPException) as error:
        inspect_csv(csv_path, **options)
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "INVALID_CSV"


def test_row_and_column_limits_are_enforced(write_csv):
    csv_path = write_csv(
        [
            ["timestamp", "sensor", "label"],
            ["2026-11-09T01:00:00", "1", "normal"],
            ["2026-11-09T01:01:00", "2", "abnormal"],
        ]
    )

    with pytest.raises(HTTPException) as row_error:
        inspect_csv(csv_path, max_rows=1)
    assert row_error.value.status_code == 413
    assert row_error.value.detail["code"] == "DATASET_TOO_LARGE"
    with pytest.raises(HTTPException) as column_error:
        inspect_csv(csv_path, max_columns=2)
    assert column_error.value.status_code == 422


def test_only_preview_is_truncated_and_full_row_count_is_kept(write_csv):
    rows = [["timestamp", "sensor", "label"]]

    rows.extend([[f"2026-11-09T01:0{minute}:00", "1" * 160, "normal"] for minute in range(7)])
    csv_path = write_csv(rows)

    original_bytes = csv_path.read_bytes()

    inspection = inspect_csv(csv_path)

    assert inspection.is_valid
    assert inspection.row_count == 7
    assert len(inspection.preview) == 5
    assert len(inspection.preview[0]["sensor"]) == 128
    assert inspection.preview_truncated
    assert csv_path.read_bytes() == original_bytes


def test_csv_parser_field_length_limit_is_reported_as_invalid_csv(tmp_path):
    # 파서가 허용한 셀 길이를 넘으면 내부 예외나 셀 원문을 응답으로 노출하지 않는다.
    csv_path = tmp_path / "large-cell.csv"

    csv_path.write_text(
        "timestamp,sensor,label\n2026-11-09," + "1" * (csv.field_size_limit() + 1) + ",normal\n",
        encoding="utf-8",
    )
    with pytest.raises(HTTPException) as error:
        inspect_csv(csv_path)
    assert error.value.status_code == 422
    assert "1" * 100 not in error.value.detail["message"]


def test_large_input_is_counted_beyond_the_preview(write_csv):
    rows = [["timestamp", "sensor", "label"]]

    rows.extend([[f"2026-11-{day:02d}T00:00:00", str(day), "normal"] for day in range(1, 30)])
    csv_path = write_csv(rows)

    inspection = inspect_csv(csv_path)

    assert inspection.row_count == 29
    assert inspection.label_counts == {"normal": 29, "abnormal": 0}
    assert inspection.time_end == "2026-11-29T00:00:00"
    assert len(inspection.preview) == 5
