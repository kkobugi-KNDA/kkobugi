"""모델 검증용 분할 설계 도구.

1분 간격 시계열은 인접 행이 거의 같은 값이라 무작위 분할을 하면 학습·시험에 같은 사건의 앞뒤 행이
섞여 성능이 부풀려집니다. 여기서는 전체 기간을 **고장 사건 단위 전진 검증**으로 나눕니다. 고장마다 그
이전 자료로만 학습하고, 해당 고장을 포함한 구간을 시험합니다. 날짜 기준 단일 분할은 쓰지 않습니다.

모델링 담당자는 이 모듈의 결과(열 이름 `fold_*`)를 그대로 써서 행을 나누면 됩니다.
"""

import pandas as pd

from src.pump_missingness_audit import MINUTE


def failure_events(status):
    """고장 시작(BROKEN)과 그 뒤 처음 NORMAL로 돌아온 시각을 사건별로 정리합니다."""
    starts = status.index[status.eq("BROKEN")]
    normal_index = status.index[status.eq("NORMAL")]
    rows = []
    for number, start in enumerate(starts, start=1):
        later = normal_index[normal_index > start]
        end = later.min() if len(later) else status.index[-1]
        rows.append({
            "event": number, "start": start, "recovery_end": end,
            "recovery_minutes": int((end - start) // MINUTE),
        })
    return pd.DataFrame(rows)


def event_folds(events, index, min_train_events=2):
    """고장 사건 단위 전진 검증 구간표.

    k번째 사건의 시험 구간은 (k−1번째 사건의 회복 종료, k번째 사건의 회복 종료]이고, 학습 구간은
    그 이전 전체입니다. 학습 구간에 고장이 min_train_events건 이상일 때만 폴드를 만듭니다. 마지막
    사건 이후 구간은 고장이 없는 시험 구간(오경보 확인용)으로 추가합니다.
    """
    rows = []
    for position, event in events.iterrows():
        if position < min_train_events:
            continue
        test_begin = events.loc[position - 1, "recovery_end"] + MINUTE
        rows.append({
            "fold": f"fold_event_{event['event']}", "test_failure": event["start"],
            "train_begin": index[0], "train_end": test_begin - MINUTE,
            "test_begin": test_begin, "test_end": event["recovery_end"],
            "train_failures": int(position),
        })
    last_end = events["recovery_end"].iloc[-1]
    rows.append({
        "fold": "fold_after_last", "test_failure": pd.NaT,
        "train_begin": index[0], "train_end": last_end,
        "test_begin": last_end + MINUTE, "test_end": index[-1],
        "train_failures": int(len(events)),
    })
    return pd.DataFrame(rows)


def assign_folds(index, folds, purge_minutes=0):
    """시각마다 폴드별 역할(train / test / none)을 붙인 표.

    purge_minutes를 주면 시험 구간 시작 직전 그 분량을 학습에서 제외합니다. rolling 피처의 창이 시험
    구간 직전 값을 포함해도 과거 값이므로 누수는 아니지만, 더 보수적으로 나누고 싶을 때 씁니다.
    """
    table = pd.DataFrame(index=index)
    for _, fold in folds.iterrows():
        role = pd.Series("none", index=index)
        train_end = fold["train_end"] - purge_minutes * MINUTE
        role[(index >= fold["train_begin"]) & (index <= train_end)] = "train"
        role[(index >= fold["test_begin"]) & (index <= fold["test_end"])] = "test"
        table[fold["fold"]] = role
    return table


def count_by_group(groups, status, events):
    """분할·폴드별 행 수와 상태별 행 수, 그 안에서 시작한 고장 건수를 셉니다."""
    frame = pd.DataFrame({"group": groups, "status": status})
    counts = pd.crosstab(frame["group"], frame["status"])
    counts["rows"] = counts.sum(axis=1)
    failures = pd.Series(groups.loc[events["start"]].to_numpy()).value_counts()
    counts["failures_started"] = failures.reindex(counts.index).fillna(0).astype(int)
    return counts
