"""펌프 센서 CSV의 결측 현황을 확인합니다. 원본 데이터는 읽기만 합니다."""

import argparse
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import pandas as pd


MINUTE = pd.Timedelta(minutes=1)
SPLIT_DATES = ["2018-04-01", "2018-06-01", "2018-07-05", "2018-09-01"]
SPLIT_NAMES = ["train", "valid", "test"]


def default_source():
    # 실행 위치와 무관하게 이 파일의 상위 저장소에 있는 data/를 기준으로 찾습니다.
    data_dir = Path(__file__).resolve().parents[1] / "data"
    for filename in ("sensor.csv", "archive.zip"):
        candidate = data_dir / filename
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"{data_dir}에 sensor.csv 또는 archive.zip을 넣어주세요.")


def read_sensor_data(path):
    # Kaggle 원본 ZIP과 압축을 푼 CSV를 모두 지원합니다.
    if path.suffix.lower() == ".zip":
        with ZipFile(path) as archive, archive.open("sensor.csv") as member:
            return pd.read_csv(member)
    return pd.read_csv(path)


def missing_runs(is_missing, break_before):
    # 값이 비어 있는 첫 행과 마지막 행을 짝지어 연속 결측 구간을 구합니다.
    # 시각 자체가 빠졌다면 앞뒤 행의 결측을 서로 다른 구간으로 셉니다.
    starts = is_missing & (~is_missing.shift(fill_value=False) | break_before)
    ends = is_missing & (
        ~is_missing.shift(-1, fill_value=False) | break_before.shift(-1, fill_value=False)
    )
    start_times = is_missing.index[starts]
    end_times = is_missing.index[ends]
    return pd.DataFrame({
        "시작": start_times,
        "종료": end_times,
        "연속 결측(분)": (end_times - start_times) // MINUTE + 1,
    })


def audit_missingness(path=None, min_gap=60, *, split_by_period=False, excluded_sensors=()):
    """전체 기간과 원본 센서 전체의 결측을 집계합니다.

    excluded_sensors를 지정하면 센서별 상세 표에서 해당 열을 제외합니다.
    """
    if min_gap < 1:
        raise ValueError("min_gap은 1 이상이어야 합니다.")
    source = default_source() if path is None else Path(path)
    data = read_sensor_data(source)
    sensors = [column for column in data if column.startswith("sensor_")]
    if not sensors or not {"timestamp", "machine_status"}.issubset(data.columns):
        raise ValueError("timestamp, machine_status, sensor_* 열이 필요합니다.")
    if data.empty:
        raise ValueError("데이터 행이 없습니다.")

    # 헤더가 1번이므로 첫 데이터 레코드는 2번입니다. 정렬 전에 번호를 보관합니다.
    data["CSV 레코드 번호"] = range(2, len(data) + 2)
    data["timestamp"] = pd.to_datetime(data["timestamp"], errors="coerce")
    if data["timestamp"].isna().any() or data["timestamp"].duplicated().any():
        raise ValueError("비어 있거나 해석할 수 없는 시각, 또는 중복 시각이 있습니다.")
    data = data.sort_values("timestamp").set_index("timestamp")
    if not data.index.equals(data.index.floor("min")):
        raise ValueError("timestamp는 분 단위로 기록되어 있어야 합니다.")

    expected_minutes = (data.index[-1] - data.index[0]) // MINUTE + 1
    break_before = data.index.to_series().diff().ne(MINUTE)

    if split_by_period:
        # 기획서의 날짜 경계를 적용합니다. 종료일은 다음 분할에 포함합니다.
        split = pd.cut(
            data.index, pd.to_datetime(SPLIT_DATES), labels=SPLIT_NAMES, right=False
        )
        data["split"] = split.add_categories(["분할 외"]).fillna("분할 외")

    # 상태 라벨이나 행 번호를 섞지 않고, 실제 센서 열만 결측 판정에 사용합니다.
    missing = data[sensors].isna()
    all_missing = missing.all(axis=1)
    any_missing = missing.any(axis=1)
    partial_missing = any_missing & ~all_missing
    # sensor_15가 있으면 전 행이 일부 결측으로 집계되므로 별도 집계도 제공합니다.
    available_sensors = missing.loc[:, ~missing.all(axis=0)]
    partial_available = available_sensors.any(axis=1) & ~all_missing

    # 노트북과 다른 코드에서 결과 표를 바로 사용할 수 있도록 출력과 계산을 분리합니다.
    columns = ["CSV 레코드 번호", "machine_status"]
    if split_by_period:
        columns.insert(1, "split")
    if "Unnamed: 0" in data.columns:
        columns.insert(1, "Unnamed: 0")
    all_missing_rows = data.loc[all_missing, columns].rename(
        columns={"Unnamed: 0": "원본 행 번호"}
    )

    counts = pd.DataFrame({
        "상태": data["machine_status"],
        "전체 행": 1,
        "센서 전체 결측": all_missing,
        "일부 결측(전 구간 결측 센서 제외)": partial_available,
    })
    by_status = counts.groupby("상태", dropna=False).sum()

    sensor_summary = pd.DataFrame({
        "결측 건수": missing.sum(),
        "결측률(%)": 100 * missing.mean(),
    })
    if split_by_period:
        counts["split"] = data["split"]
        by_split_status = counts.groupby(["split", "상태"], observed=True, dropna=False).sum()
        per_split = missing.groupby(data["split"], observed=True).sum().T
        sensor_summary = sensor_summary.join(per_split)
    long_gaps = []
    for sensor in sensors:
        gaps = missing_runs(missing[sensor], break_before)
        sensor_summary.loc[sensor, "최장 결측(분)"] = (
            0 if gaps.empty else gaps["연속 결측(분)"].max()
        )
        long_gaps.append(gaps.loc[gaps["연속 결측(분)"] >= min_gap].assign(센서=sensor))

    sensor_summary["최장 결측(분)"] = sensor_summary["최장 결측(분)"].astype(int)
    # 기본으로 원본 센서를 모두 번호순으로 표시합니다.
    sensor_details = sensor_summary.drop(index=list(excluded_sensors), errors="ignore").sort_index()
    selected_missing = missing[sensor_details.index]
    detail = pd.concat(long_gaps, ignore_index=True)
    return {
        "summary": {
            "source": source.resolve(),
            "row_count": len(data),
            "sensor_count": len(sensors),
            "selected_sensor_count": len(sensor_details),
            "selected_missing_rows": int(selected_missing.any(axis=1).sum()),
            "start": data.index[0],
            "end": data.index[-1],
            "missing_timestamps": int(expected_minutes - len(data)),
            "all_missing_count": int(all_missing.sum()),
            "partial_missing_count": int(partial_missing.sum()),
            "partial_missing_excluding_empty_sensors": int(partial_available.sum()),
            "min_gap": min_gap,
        },
        "all_missing_rows": all_missing_rows,
        "by_status": by_status,
        **({"by_split_status": by_split_status} if split_by_period else {}),
        "by_sensor": sensor_summary.sort_values("결측 건수", ascending=False),
        "sensor_details": sensor_details,
        "long_gaps": detail.sort_values("연속 결측(분)", ascending=False).reset_index(drop=True),
    }


def print_audit(report):
    # 터미널 실행 시에만 반환된 표를 화면에 출력합니다.
    summary = report["summary"]
    print(f"기록 {summary['row_count']:,}행 · 센서 {summary['sensor_count']}개")
    print(f"기간 {summary['start']} ~ {summary['end']}")
    print(f"시각 자체가 빠진 분 {summary['missing_timestamps']:,}개")
    print(f"전체 센서 결측 {summary['all_missing_count']:,}행")
    print(f"일부 센서 결측 {summary['partial_missing_count']:,}행")
    print(f"전 구간 결측 센서를 뺀 뒤 일부 결측 {summary['partial_missing_excluding_empty_sensors']:,}행")

    print("\n[전체 센서 결측 행]")
    rows = report["all_missing_rows"]
    print("없음" if rows.empty else rows.to_string())
    if "by_split_status" in report:
        print("\n[분할·상태별 결측 행 수]")
        print(report["by_split_status"].to_string())
    else:
        print("\n[전체 기간 상태별 결측 행 수]")
        print(report["by_status"].to_string())
    print(f"\n[분석 대상 {summary['selected_sensor_count']}개 센서의 결측]")
    print(f"결측이 하나라도 있는 행 {summary['selected_missing_rows']:,} / {summary['row_count']:,}행")
    print(report["sensor_details"].round(3).to_string())

    print(f"\n[{summary['min_gap']}분 이상 연속 결측 구간]")
    gaps = report["long_gaps"]
    columns = ["센서", "시작", "종료", "연속 결측(분)"]
    print("없음" if gaps.empty else gaps[columns].to_string(index=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?", type=Path, help="생략 시 data/sensor.csv 또는 data/archive.zip")
    parser.add_argument("--min-gap", type=int, default=60, help="상세 출력할 최소 연속 결측 분 수")
    period_options = parser.add_mutually_exclusive_group()
    period_options.add_argument("--by-period", action="store_true", dest="split_by_period",
                                help="학습·검증·시험 구간별 집계 추가")
    period_options.add_argument("--overall", action="store_false", dest="split_by_period",
                                help="전체 기간 집계만 표시 (기본값)")
    parser.set_defaults(split_by_period=False)
    args = parser.parse_args()
    try:
        print_audit(audit_missingness(args.source, args.min_gap, split_by_period=args.split_by_period))
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        parser.error(str(error))
