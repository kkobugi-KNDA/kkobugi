"""펌프 센서 시계열에서 시간 순서를 지키는 피처를 만듭니다.

입력은 05 노트북이 저장한 최종 전처리 CSV(시간 기준 선형보간 값, 원본 machine_status, label)입니다.
rolling 통계는 창의 끝이 현재 시각이며, 변화율은 과거 값과의 차이입니다. 보간값은 결측 앞뒤 관측값으로
만들므로 결측 구간 안의 값에는 결측이 끝난 뒤 첫 관측값이 반영됩니다.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from src.pump_missingness_audit import MINUTE, read_csv_exact

EXCLUDED_SENSORS = ("sensor_15", "sensor_50", "sensor_51")
WINDOWS = (15, 60, 360)
ROLLING_STATS = ("mean", "std", "min", "max")
DIFF_LAGS = (1, 5, 15, 60)
ZSCORE_WINDOW = 360
LABEL_MAP = {"NORMAL": 0, "BROKEN": 1, "RECOVERING": 1}
# 05_pump_binary_labels 노트북이 만드는 최종 전처리 CSV입니다.
PREPARED_CSV = Path(__file__).resolve().parents[1] / "data/processed/sensor_linear_interpolation_labeled.csv"


def load_prepared(source=None, excluded=EXCLUDED_SENSORS):
    """05의 최종 전처리 CSV를 읽어 시각 인덱스의 센서 값(선형보간), 원본 상태, 라벨을 돌려줍니다."""
    source = PREPARED_CSV if source is None else Path(source)
    if not source.is_file():
        raise FileNotFoundError(f"{source}가 없습니다. 05_pump_binary_labels 노트북을 먼저 실행하세요.")
    data = read_csv_exact(source)
    if not {"timestamp", "machine_status", "label"}.issubset(data.columns):
        raise ValueError("timestamp·machine_status·label 열이 필요합니다. 05 노트북을 다시 실행해 CSV를 새로 만드세요.")
    timestamps = pd.to_datetime(data["timestamp"], errors="raise")
    if data.empty or timestamps.isna().any() or not timestamps.diff().iloc[1:].eq(MINUTE).all():
        raise ValueError("시각이 비어 있지 않고 1분 간격인지 확인하세요.")
    index = pd.DatetimeIndex(timestamps, name="timestamp")

    sensors = [column for column in data if column.startswith("sensor_") and column not in excluded]
    values = data[sensors].astype("float64").set_axis(index)
    if not np.isfinite(values.to_numpy()).all():
        raise ValueError("센서 값에 결측이나 무한대가 있습니다. 05 노트북의 선형보간 결과를 확인하세요.")

    status = data["machine_status"].set_axis(index).rename("machine_status")
    label = status.map(LABEL_MAP)
    if label.isna().any():
        raise ValueError(f"분류할 수 없는 상태값 {status[label.isna()].unique()!r}")
    # 05가 저장한 normal/abnormal 라벨과 원본 상태가 서로 맞는지 확인합니다.
    saved_label = data["label"].map({"normal": 0, "abnormal": 1}).set_axis(index)
    if not saved_label.eq(label).all():
        raise ValueError("CSV의 label과 machine_status가 서로 맞지 않습니다.")

    return {
        "source": source,
        "values": values,
        "status": status,
        "label": label.astype("int64").rename("label"),
    }


def failure_starts(status):
    """원본 machine_status에서 BROKEN으로 기록된 고장 시작 시각을 돌려줍니다."""
    return status.index[status.eq("BROKEN")]


def analysis_state(status, starts, horizon=60):
    """상태에 고장 직전 구간을 더한 분석용 구분을 만듭니다.

    고장 시작 전 horizon분 동안의 NORMAL 행은 pre_failure로 표시합니다. 나머지는 원본 상태를
    소문자로 둡니다(normal, broken, recovering).
    """
    state = status.str.lower().copy()
    for start in starts:
        window = (state.index >= start - horizon * MINUTE) & (state.index < start)
        state.loc[window & state.eq("normal")] = "pre_failure"
    return state.rename("state")


def rolling_features(values, windows=WINDOWS, stats=ROLLING_STATS, dtype="float32"):
    """센서별 rolling 통계. 창은 현재 시각에서 끝나며 창이 다 차기 전에는 NaN입니다."""
    frames = []
    for window in windows:
        roller = values.rolling(window, min_periods=window)
        for stat in stats:
            frame = getattr(roller, stat)()
            frame.columns = [f"{column}__roll{window}_{stat}" for column in values.columns]
            frames.append(frame.astype(dtype))
    return pd.concat(frames, axis=1)


def diff_features(values, lags=DIFF_LAGS, dtype="float32"):
    """과거 값과의 차이(변화량). 양수면 lag분 전보다 올랐다는 뜻입니다."""
    frames = []
    for lag in lags:
        frame = values - values.shift(lag)
        frame.columns = [f"{column}__diff{lag}" for column in values.columns]
        frames.append(frame.astype(dtype))
    return pd.concat(frames, axis=1)


def zscore_features(values, window=ZSCORE_WINDOW, dtype="float32"):
    """직전 window분의 평균·표준편차 기준 z-score. 표준편차가 0이면 0으로 둡니다."""
    roller = values.rolling(window, min_periods=window)
    mean, std = roller.mean(), roller.std()
    z = (values - mean) / std.replace(0, np.nan)
    z = z.where(std.ne(0), 0.0)
    z.columns = [f"{column}__z{window}" for column in values.columns]
    return z.astype(dtype)


def build_features(values, windows=WINDOWS, stats=ROLLING_STATS, lags=DIFF_LAGS,
                   zscore_window=ZSCORE_WINDOW, dtype="float32"):
    """원본 센서 값에 rolling 통계, 변화량, z-score를 붙인 피처 표를 돌려줍니다."""
    return pd.concat(
        [
            values.astype(dtype),
            rolling_features(values, windows, stats, dtype),
            diff_features(values, lags, dtype),
            zscore_features(values, zscore_window, dtype),
        ],
        axis=1,
    )


def feature_spec(sensors, windows=WINDOWS, stats=ROLLING_STATS, lags=DIFF_LAGS,
                 zscore_window=ZSCORE_WINDOW):
    """피처 이름 규칙과 계산식을 설정 파일용 사전으로 돌려줍니다."""
    return {
        "time_order": "rolling·변화량·z-score는 해당 시각 이전 값만 사용. 센서 값은 05 최종 전처리 CSV(시간 기준 선형보간)",
        "sensors": list(sensors),
        "raw": {"pattern": "{sensor}", "description": "05 최종 전처리 CSV의 센서 값(선형보간)"},
        "rolling": {
            "pattern": "{sensor}__roll{window}_{stat}",
            "windows_minutes": list(windows),
            "stats": list(stats),
            "description": "현재 시각에서 끝나는 window분 창의 통계. 창이 다 차기 전 NaN",
        },
        "diff": {
            "pattern": "{sensor}__diff{lag}",
            "lags_minutes": list(lags),
            "description": "현재 값 − lag분 전 값. 앞부분 lag행은 NaN",
        },
        "zscore": {
            "pattern": "{sensor}__z{window}",
            "window_minutes": zscore_window,
            "description": "(현재 값 − 직전 window분 평균) / 직전 window분 표준편차. 표준편차 0이면 0",
        },
    }
