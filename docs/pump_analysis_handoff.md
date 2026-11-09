# 꼬부기 해커톤 분석 인수인계

## 목표와 진행 범위

펌프 센서 시계열로 고장 시작을 미리 예측한다. 원본 결측 점검, 최종 선형보간과 상태 라벨 생성, 센서 분포·고장 전후·상관관계 EDA를 완료했다. 시계열 피처와 단일 센서 경보 규칙도 전체 기간에서 탐색했다.

팀 결정에 따라 개발기획서의 **사람이 확정할 데이터 준비 기준** 항목은 프로젝트의 고정 요건으로 적용하지 않는다. 기획서의 학습·검증·시험 날짜와 표본 수, 전처리 기준을 모델링 기본안으로 가져오지 않는다. 지금까지의 전처리·EDA·피처 탐색 범위는 전체 기간이다. 예측 타깃과 평가 방식은 모델링 단계에서 정한다.

## 확정한 데이터

- 원본은 `data/sensor.csv` 또는 `data/archive.zip`이다. 데이터는 2018년 4월 1일~8월 31일의 1분 기록 220,320행과 센서 52개다.
- 최종 상태 라벨 CSV는 `data/processed/sensor_linear_interpolation_labeled.csv`다. 05 노트북에서 `sensor_15`, `sensor_50`, `sensor_51`을 제외하고 센서 49개의 결측 31,854개를 시간 기준 선형보간한다. 저장 열은 `timestamp`, 센서 49개, `label`이다.
- `NORMAL`은 `normal` 205,836행, `BROKEN`과 `RECOVERING`은 `abnormal` 14,484행이다. 두 상태의 원래 행 수는 각각 7행, 14,477행이다. 실제 고장 시작 시각은 원본 `machine_status`에서 확인한다.
- `sensor_51`은 실제 고장이 포함된 15,356분의 연속 결측 양쪽 값이 모두 1,000이다. 선형보간 시 이 기간이 전부 1,000으로 채워지므로 최종 데이터에서는 제외했다.
- 전체 기간 MICE와 전체 기간 선형보간 CSV 두 개는 `sensor_51`이 포함된 비교 실험용이다. `sensor_lightgbm_mice.csv`는 삭제된 초기 결과이고, 현재 생성 노트북은 전체 기간 결과를 저장한다.

## 코드와 문서 최종본

| 파일 | 역할 |
|---|---|
| [01 결측 점검](../notebooks/01_pump_missingness_audit.ipynb) | 전체 기간 원본 52개 센서의 결측 현황 |
| [02 원본 시계열](../notebooks/02_pump_sensor_timeseries.ipynb) | 결측을 포함한 센서별 시계열 |
| [03 MICE](../notebooks/03_pump_lightgbm_mice.ipynb) | 전체 기간 LightGBM MICE 비교 실험 |
| [04 선형보간](../notebooks/04_pump_linear_interpolation.ipynb) | 전체 기간 선형보간 비교 실험 |
| [05 최종 전처리와 라벨](../notebooks/05_pump_binary_labels.ipynb) | 최종 상태 라벨 CSV를 원본에서 재생성 |
| [06 분포와 고장 패턴](../notebooks/06_pump_sensor_eda.ipynb) | 센서별 정상·회복 분포, 실제 고장 7건, 같은 시각의 정상 대조군 |
| [07 상관관계](../notebooks/07_pump_sensor_correlation.ipynb) | 센서 49개의 상태별 보간 전후 비교와 원본 52개 참고 히트맵 |
| [08 시계열 피처](../notebooks/08_pump_rolling_features.ipynb) | 전방 채움 기반 변화량, 이동 통계, z-score와 단일 센서 경보 규칙 탐색 |
| [피처 명세](feature_spec.json) | 피처 882개의 이름 규칙과 계산법, 탐색 결과 |
| [결측 점검 코드](../src/pump_missingness_audit.py) · [피처 계산 코드](../src/pump_features.py) · [실행 번호 초기화](../src/clear_execution_count.py) | 노트북에서 재사용하는 Python 코드 |

[EDA 그래프 9개](../figures/pump_eda)와 [피처 탐색 그래프](../figures/pump_features)를 참고한다. `data/`는 Git에서 제외된다. 08의 피처 parquet가 필요하면 원본으로 08을 실행해 `data/processed/pump_features.parquet`를 생성한다. 커밋과 푸시는 사용자가 진행한다.

## EDA 핵심 결과

- `sensor_04` 관측 중앙값은 정상 633.3, 회복 3.6이었다. 회복 중 센서가 하나라도 결측인 행은 74.4%였다. 6월 28일 고장 한 건이 전체 회복 시간의 58.0%를 차지하므로 분 단위 집계와 고장별 결과를 함께 본다.
- `sensor_03`과 `sensor_48`은 고장 직전 1시간에 기준 구간 대비 7건 중 5건에서 탐색 기준 이상 하락했다. 같은 시각의 정상 구간과 비교하면 `sensor_04`의 하락이 3건에서 정상 참고 범위를 벗어났다. 7건을 사용한 탐색 결과다.
- `sensor_19·20·21`은 정상과 회복 모두에서 상관이 높아 대표 센서로 줄여볼 후보다. 회복 중 `sensor_00–sensor_05`의 Pearson 상관은 원본 관측 +0.664, 보간 후 −0.354였다.
- 05의 선형보간 CSV와 08의 전방 채움 피처는 입력을 준비하는 방식이 다른 산출물이다. 08의 `pre_failure`는 탐색용으로 표시한 고장 직전 60분이며, 확정된 모델 타깃은 아니다.

## 남은 일

1. 원본의 `BROKEN` 시작점을 기준으로 고장 예고 목표와 예측 시간을 정한다. 현재 `normal/abnormal`은 설비 상태 라벨이다.
2. 05의 최종 데이터와 08의 피처 중 모델에 사용할 입력을 정하고, 고장 예고 목적에 맞는 평가 범위와 방식을 설계한다. 4~8월 고장 시작 건수는 2·2·1·2·0건이다.
3. 단일 센서 경보 규칙과 기준 모델을 비교한다. 고장 적중 건수, 경보 선행 시간, 정상 구간의 오경보를 확인하고, 후보 센서만 쓴 경우와 전체 센서를 쓴 경우를 비교한다.
