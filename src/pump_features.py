"""펌프 센서 시계열에서 시간 순서를 지키는 피처를 만듭니다.

모든 계산은 각 시각까지 확보할 수 있는 값만 사용합니다. 결측은 직전 관측값으로 채우고(전방 채움),
rolling 통계는 창의 끝이 현재 시각이며, 변화율은 과거 값과의 차이입니다.
"""

from pathlib import Path

import numpy as np
import pandas as pd

from src.pump_missingness_audit import MINUTE, default_source, read_sensor_data

EXCLUDED_SENSORS = ("sensor_15", "sensor_50", "sensor_51")
WINDOWS = (15, 60, 360)
ROLLING_STATS = ("mean", "std", "min", "max")
DIFF_LAGS = (1, 5, 15, 60)
ZSCORE_WINDOW = 360
LABEL_MAP = {"NORMAL": 0, "BROKEN": 1, "RECOVERING": 1}


def load_prepared(source=None, excluded=EXCLUDED_SENSORS):
    """원본을 읽어 시각 인덱스의 센서 값(전방 채움), 상태, 라벨을 돌려줍니다."""
    source = default_source() if source is None else Path(source)
    raw = read_sensor_data(source)
    timestamps = pd.to_datetime(raw["timestamp"], errors="raise")
    if raw.empty or timestamps.isna().any() or not timestamps.diff().iloc[1:].eq(MINUTE).all():
        raise ValueError("원본의 시각이 비어 있지 않고 1분 간격인지 확인하세요.")
    index = pd.DatetimeIndex(timestamps, name="timestamp")

    sensors = [column for column in raw if column.startswith("sensor_") and column not in excluded]
    values = raw[sensors].astype("float64").set_axis(index)
    missing = values.isna()
    filled = values.ffill()
    if filled.isna().any().any():
        raise ValueError("시계열 맨 앞에 결측이 있어 전방 채움만으로 채울 수 없습니다.")

    status = raw["machine_status"].set_axis(index).rename("machine_status")
    label = status.map(LABEL_MAP)
    if label.isna().any():
        raise ValueError(f"분류할 수 없는 상태값 {status[label.isna()].unique()!r}")

    return {
        "source": source,
        "values": filled,
        "missing": missing,
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
        "time_order": "모든 피처는 해당 시각 이전 값만 사용. 결측은 직전 관측값으로 전방 채움",
        "sensors": list(sensors),
        "raw": {"pattern": "{sensor}", "description": "전방 채움한 원본 센서 값"},
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
