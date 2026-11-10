# API 연결 기준

Figma의 데이터 선택·CSV 검사 화면부터 연결한다. 실행 중인 서버의 `/openapi.json`이
요청·응답의 기준이며, `/docs`에서 같은 명세를 볼 수 있다.

- 주소: `/api/v1`. 쿠키 인증은 `credentials: "include"` 사용.
- 변경 요청: 허용된 `Origin`과 `X-Requested-With: kkobugi-web` 필요.
- 오류: `{"error":{"code":"...","message":"..."}}`. 입력 오류에는 `fields`도 포함.
- `created_at`, `updated_at`은 Unix 초 단위다. CSV의 측정 시각과 구분한다.
- 화면 표시명과 저장값은 구분한다. CSV의 `normal/abnormal`을 화면에서 `Normal/UnNormal`로 표시해도 됨.
- 메뉴·모달·확대 상태는 프런트엔드에서 관리한다. 기존 응답 필드의 의미를 바꾸지 않고 추가한다.

## 이번 단계에서 연결할 API

| 메서드·주소 | 요청 | 응답 |
| --- | --- | --- |
| `POST /auth/login` | JSON `username`, `password` | 사용자·남은 세션 시간, 쿠키 |
| `GET /auth/me` | 쿠키 | 사용자·남은 세션 시간 |
| `POST /auth/logout` | 쿠키 | `204` |
| `POST /datasets` | 아래 multipart 항목 | `201`, 동일 파일·설정은 기존 자료로 `200` |
| `GET /datasets` | `limit=20`, `offset=0` | `items`, `total`, `limit`, `offset` |
| `GET /datasets/{dataset_id}` | 쿠키 | `dataset`, `inspection` |
| `POST /datasets/{dataset_id}/reinspect` | 쿠키·변경 요청 헤더 | 원본을 다시 검사한 `dataset`, `inspection` |
| `GET /datasets/{dataset_id}/file` | 쿠키 | 업로드한 원본 CSV |

CSV는 로그인한 계정별로 저장·조회한다. 다른 계정의 자료와 없는 자료는 모두 `404`다.
목록은 최근 등록순이며 `limit`은 최대 100이다. 내부 파일 경로는 응답하지 않는다.

### CSV 등록

`multipart/form-data`로 아래 항목을 보낸다. 브라우저가 경계를 넣도록 `Content-Type`을 직접 지정하지 않는다.

| 항목 | 기본값 | 의미 |
| --- | --- | --- |
| `file` | 필수 | 전처리된 UTF-8 CSV. BOM 허용 |
| `timestamp_column` | `timestamp` | 시각 열 |
| `label_column` | `label` | 정답 라벨 열 |
| `normal_label` | `normal` | 정상 라벨 값 |
| `abnormal_label` | `abnormal` | 비정상 라벨 값 |

`machine_status`, `all_sensors_missing`는 상태 정보로 보존하고 숫자 채널에서 제외한다.
제외한 이름은 `inspection.ignored_columns`에 담는다. 나머지 열은 숫자 채널이다.
라벨이 `0/1`이면 두 라벨 값을 직접 지정한다.
설정 항목을 생략하면 기본값을 쓴다. 명시적으로 빈 문자열을 보내면 `422`로 거부한다.
역할 열·라벨 값은 서로 달라야 하며, 라벨 설정의 앞뒤 공백은 허용하지 않는다.
업로드 셀 값은 앞뒤 공백을 제외해 검사하되 원본 바이트는 변경하지 않는다.

```javascript
const uploadForm = new FormData();

uploadForm.append("file", selectedFile);

const response = await fetch("/api/v1/datasets", {
  method: "POST",
  credentials: "include",
  headers: { "X-Requested-With": "kkobugi-web" },
  body: uploadForm,
});

const result = await response.json();

// 다음 화면의 선택값으로 result.dataset.id를 사용한다.
```

### 등록 결과

- `dataset`: ID·파일명·크기·SHA256·작성 계정·등록 시각·행/열 수·채널·라벨 설정·상태.
- `inspection`: 열 목록, 결측/숫자 오류 수, 라벨 분포, 시각 범위·중복·역순 수, 문제 목록, 미리보기.
- `dataset.status`: 검사 오류가 없으면 `valid`, 확인할 값이 있으면 `needs_review`.
- `inspection.issues`: `code`, `message`, `column`, `count`, `severity`로 문제 위치와 이유를 표시.
- `inspection.preview`: 처음 5행. 셀은 128자까지 표시하며 잘렸으면 `preview_truncated=true`.

구조가 읽히는 파일은 품질 문제가 있어도 저장하고 검사 결과를 보여준다.
결측을 채우거나 행을 지우거나 정렬하지 않는다. `valid`는 입력 검사 결과이며 모델 성능을 보장하지 않는다.
시간대가 없는 시각에는 UTC나 한국 시간을 붙이지 않는다. 시간대가 섞이면 확인 대상으로 남긴다.

빈 파일·중복/빈 헤더·필수 열 누락·잘못된 행 길이·읽을 수 없는 CSV는 `422`로 거부하고 저장하지 않는다.
CSV가 아닌 파일명은 `415`, 크기·행 수 초과는 `413`이다. 기본 제한은 파일 200 MiB·100만 행·256열이며
환경설정으로 바꿀 수 있다. 요청 전체는 multipart 항목을 포함해 파일 제한보다 1 MiB 큰 크기까지 받는다.
같은 계정·파일 SHA256·네 가지 설정이 같으면 기존 ID를 돌려준다. 수정한 CSV는 새 자료로 등록한다.

이전 검사에서 상태 열이 숫자로 잡혔다면 `POST /datasets/{id}/reinspect`로 갱신한다.
등록 ID·시각·원본 바이트·SHA256은 유지하고 검사 결과만 바꾼다. 검사 전후 해시가 다르면 갱신하지 않는다.
단순 조회로는 기존 검사 결과를 바꾸지 않는다.

## 모델 학습·비교·선택

모델 목록은 API에서 받아 표시한다. `xgboost`, `lightgbm`, `autoencoder` key로 선택한다.
Dummy는 새 학습 목록에서 제외한다. 이미 저장한 Dummy 실행·모델·결과는 계속 조회한다.

| 메서드·주소 | 요청 | 응답 |
| --- | --- | --- |
| `GET /models` | 쿠키 | 선택 가능한 모델·설명·고정 학습 설정 |
| `POST /runs` | 아래 JSON | `202`, 실행 ID·상태·설정 |
| `GET /runs` | `limit=20`, `offset=0` | 내 실행 기록·전체 개수 |
| `GET /runs/{run_id}` | 쿠키 | 상태·설정·분할·입력 SHA256·라이브러리 버전 |
| `GET /runs/{run_id}/results` | `sort_by=f1` 등 | Valid 지표 순위·클래스별 지표·혼동행렬 |
| `POST /runs/{run_id}/selection` | `{"model_key":"xgboost"}` | 사용자가 선택한 모델과 실행 정보 |
| `POST /runs/{run_id}/evaluation` | 쿠키 | `202`, 선택한 모델의 Test 평가 시작 |
| `GET /runs/{run_id}/evaluation` | 쿠키 | Test 평가 상태·지표 |

기록과 결과는 로그인한 계정만 조회한다. 다른 계정의 실행과 없는 ID는 모두 `404`다.

### 학습 요청 예시

```json
{
  "dataset_id": "CSV 등록 응답의 dataset.id",
  "feature_columns": ["sensor_00", "sensor_04"],
  "models": ["xgboost", "lightgbm", "autoencoder"],
  "train_end": "2018-06-30T23:59:00",
  "validation_end": "2018-07-31T23:59:00",
  "ranking_metric": "f1",
  "random_seed": 42
}
```

날짜는 예시다. 특징·모델·분할 경계는 사용자가 지정한다. `dataset_id`는 실제 등록된 32자리 ID다.

- Train: `시각 <= train_end`, Valid: `train_end < 시각 <= validation_end`, Test: 나머지 이후 행.
- 세 구간에 각각 데이터가 있어야 한다. 시간대 표기는 CSV와 일치해야 한다.
- 서버는 행을 섞거나 stratify·보간·PCA·특징 추가·오버샘플링을 수행하지 않는다.
- XGBoost·LightGBM은 Train에 두 라벨이 필요하다. AutoEncoder는 정상 Train이 두 행 이상 필요하다.
- AutoEncoder의 스케일러·재구성 신경망은 정상 Train만 학습한다. 기준은 정상 Train 오차의 99분위다.
- Valid·Test에서는 신경망과 기준값을 바꾸지 않는다. 재구성 오차는 고장 확률로 표시하지 않는다.

검사를 통과한 CSV와 숫자 채널만 학습할 수 있다. 시간·라벨 열을 특징으로 지정하면 `422`다.
구간별 라벨 조건 등 실제 CSV를 읽어야 확인되는 오류는 비동기 실행의 `failed` 상태와 설명으로 표시한다.

### 비교·선택·시험 평가 순서

1. `POST /runs`로 요청하고 `GET /runs/{run_id}`에서 완료를 확인한다.
2. `GET /runs/{run_id}/results`로 Valid 지표를 비교한다. 모델을 자동 선택하지 않는다.
3. 사용자가 `POST /selection`으로 모델을 고른다. 이 요청만으로 Test 평가를 시작하지 않는다.
4. `POST /evaluation`으로 선택한 모델의 Test를 평가하고 `GET /evaluation`으로 결과를 확인한다.

학습 상태는 `queued/running/completed/failed`다. 평가 상태는 처음 `not_started`이며 같은 상태 순서로 진행한다.
완료한 평가를 다시 요청하면 저장된 결과를 `200`으로 반환한다. 대기·실행 중인 평가는 중복 실행하지 않는다.
Test 평가를 시작하면 모델 선택이 잠긴다. 바꾸려는 요청은 `409`다. 평가 시 모델을 다시 학습하지 않는다.

정렬 기준은 `f1`, `precision`, `recall`, `accuracy`, `balanced_accuracy`, `roc_auc`, `average_precision`이다.
기본은 등록한 `ranking_metric`이며 높은 값부터 정렬한다. 계산할 수 없는 값은 `null`로 뒤에 표시한다.
지표의 양성은 CSV 등록 때 지정한 `abnormal_label`이다. 클래스별 support와 지표도 함께 반환한다.
혼동행렬은 행이 실제값, 열이 예측값이며 순서는 모두 `[normal, abnormal]`이다.
수렴·한 클래스 구간 등 주의할 조건은 `warnings`로 전달한다.

모델과 실행 설정·입력 파일 해시·특징 순서·패키지 버전을 서버에 보관한다.
평가는 업로드된 CSV 기준이다. 업로드 전에 전체 기간을 사용한 보간·전처리가 있었는지는 별도 확인이 필요하다.

로컬 단일 API 프로세스에서 학습·평가 작업을 한 번에 하나씩 처리한다.
기본 대기 한도는 실행 중 작업 포함 8개이며 초과하면 `429`다. 기본 학습 제한은 25만 행·128개 특징이다.
완료한 결과는 재시작 후 유지하고, 강제 종료로 끝내지 못한 작업은 다음 시작 때 `failed`로 표시한다.

## 구간 그래프·예측 조회

아래 주소도 `/api/v1` 뒤에 붙인다. 조회는 원본 CSV·학습 모델을 수정하지 않는다.

| 메서드·주소 | 요청 | 응답 |
| --- | --- | --- |
| `GET /datasets/{dataset_id}/series` | `channels` 반복, `start_time`, `end_time`, `max_points=2000` | 같은 시각에 맞춘 채널값·원본 라벨 |
| `GET /datasets/{dataset_id}/label-intervals` | `code=1`, 시각 범위, `limit=100`, `offset=0` | 원본 라벨이 1인 구간 |
| `GET /runs/{run_id}/predictions` | `split=validation`, `model_key`, 시각 범위, `limit=1000`, `offset=0` | 행별 실제 라벨·예측 라벨·점수 |
| `GET /runs/{run_id}/prediction-intervals` | 같은 실행 조건, `predicted_code=1`, `limit=100`, `offset=0` | 예측값이 1인 구간 |

```text
/api/v1/datasets/{dataset_id}/series?channels=sensor_00&channels=sensor_04&start_time=2018-06-01T00:00:00&end_time=2018-06-01T01:00:00
/api/v1/runs/{run_id}/predictions?model_key=lightgbm&split=validation
```

- 채널은 1~8개를 지정한다. `max_points` 범위는 64~10,000이다.
- 많은 행은 공통 시간 묶음의 채널별 최솟값·최댓값 위치와 양끝을 남긴다. 평균·보간값을 만들지 않는다.
- 응답의 `matched_count`는 원본 행 수, `returned_count`는 표시할 행 수다. `downsampled`로 축약 여부를 확인한다.
- 원본 라벨 구간과 예측 구간은 그래프 축약과 별도로 계산한다. 짧은 1 구간도 조회할 수 있다.
- 시각 범위는 양끝을 포함하며 한쪽만 지정할 수도 있다. 시간대가 있는 시각은 UTC로 맞추고, 없는 시각에는 시간대를 붙이지 않는다.
- `row_index`는 원본 CSV의 0부터 시작하는 데이터 행 번호다. 구간의 행 범위는 `[start_row, end_row)`다.
- 반복 관측 간격이 확인될 때만 연속 구간으로 묶는다. 기록이 비는 시간은 연결하지 않는다. `cadence_seconds=null`이면 각각의 관측으로 표시한다.
- 입력 검사를 통과한 CSV만 조회한다. 확인할 값이 있으면 검사 결과를 먼저 확인한다.

Valid는 해당 실행에서 학습한 모델을 지정해 비교할 수 있다. `model_key`를 생략하면 사용자가 선택한 모델을 사용하며, 아직 선택하지 않았으면 `409`다.
Test 예측은 **선택한 모델의 Test 평가가 완료된 뒤**에만 조회한다. 조회 요청으로 학습·평가·모델 선택을 시작하지 않는다.
분할 밖의 시각을 요청하면 해당 분할 안에서만 조회한다.

XGBoost·LightGBM의 `score_type`은 `probability`이며, 점수는 등록한 이상 라벨의 모델 확률이다.
AutoEncoder는 `reconstruction_error`와 학습 당시의 `threshold`를 반환한다. 고장 확률로 표시하지 않는다.
예측은 저장한 특징 순서와 모델을 사용한다. CSV·모델의 해시나 실행 환경이 달라졌으면 오류로 반환한다.

## 현장 관찰

| 메서드·주소 | 요청 | 응답 |
| --- | --- | --- |
| `POST /observations` | 아래 JSON | `201`, 저장된 관찰·작성자·수정 번호 |
| `GET /observations` | `dataset_id`, `run_id`, `channel`, 시각 범위, `limit=20`, `offset=0` | 내 관찰 목록·전체 개수 |
| `GET /observations/{observation_id}` | 쿠키 | 관찰 내용 |
| `PATCH /observations/{observation_id}` | 현재 `revision`과 수정할 항목 | 수정 내용·증가한 `revision` |
| `GET /observations/{observation_id}/history` | `limit=20`, `offset=0` | 작성·수정 이력과 당시 내용 |

```json
{
  "dataset_id": "CSV 등록 응답의 dataset.id",
  "channel": "sensor_04",
  "start_time": "2018-06-01T00:10:00",
  "end_time": "2018-06-01T00:15:00",
  "location": "현장에서 확인한 위치",
  "content": "같은 시간대에 누수가 관찰됨. 원인은 추가 확인 필요.",
  "judgment": "needs_check"
}
```

모델 결과를 함께 남기려면 `run_id`와 선택적으로 `model_key`를 넣는다.
연결할 실행은 본인 자료의 완료된 실행이어야 한다. 작성자·수정자는 로그인 계정으로 정한다.
채널·구간은 원본에 있어야 하며, 관측값이 없는 시간만 선택하거나 자료 밖으로 벗어나면 `422`다.

`judgment`는 `needs_check`(확인 필요), `anomaly_candidate`(이상 후보), `normal`(정상으로 판단)이다.
사람의 판단을 원본 CSV 라벨이나 모델 예측으로 덮어쓰지 않는다. 검토 완료 상태도 별도 기능이다.

```json
{"revision": 1, "content": "현장 재확인: 누수 위치를 기록함.", "judgment": "anomaly_candidate"}
```

수정할 때는 마지막으로 조회한 `revision`을 보낸다. 먼저 다른 수정이 저장됐으면 `409 OBSERVATION_CONFLICT`다.
최신 내용을 다시 읽고 수정한다. 데이터셋·연결 실행·모델은 생성 후 바꾸지 않는다.
내용은 5,000자, 위치는 200자까지다. 생성과 수정은 각각 이력으로 남고 서버를 재시작해도 유지한다.

목록의 채널·시각 필터에는 `dataset_id`도 지정한다. 시각 필터와 겹치는 관찰을 반환한다.
관찰은 본인 계정에서만 조회·수정한다. 삭제·공동 편집 권한·알림은 이번 단계에 포함하지 않는다.

## 검토 기록·완료 처리

현장 관찰을 남기는 것과 검토를 완료하는 것은 별도 작업이다.
검토에는 선택한 모델 결과와 관찰의 특정 수정 버전을 근거로 연결한다.

| 메서드·주소 | 요청 | 응답 |
| --- | --- | --- |
| `POST /reviews` | 아래 JSON | `201`, 검토 중 기록과 근거 |
| `GET /reviews` | 자료·실행·채널·상태·판단·시각 필터, `limit=20`, `offset=0` | 내 검토 목록 |
| `GET /reviews/{review_id}` | 쿠키 | 검토 내용·상태·저장된 근거 |
| `PATCH /reviews/{review_id}` | 현재 `revision`과 수정 항목 | 수정 내용·증가한 수정 번호 |
| `POST /reviews/{review_id}/complete` | `{"revision":1}` | 완료 상태·완료자·완료 시각 |
| `POST /reviews/{review_id}/reopen` | `revision`, `reason` | 검토 중 상태로 다시 열기 |
| `GET /reviews/{review_id}/history` | `limit=20`, `offset=0` | 작성·수정·완료·다시 열기 이력 |

```json
{
  "dataset_id": "CSV 등록 응답의 dataset.id",
  "channel": "sensor_04",
  "start_time": "2018-06-01T00:10:00",
  "end_time": "2018-06-01T00:15:00",
  "conclusion": "채널값 변화와 현장 누수 흔적을 함께 확인함. 원인은 추가 확인 필요.",
  "judgment": "needs_check",
  "model_result": {
    "run_id": "학습 실행 ID",
    "model_key": "lightgbm",
    "split": "validation"
  },
  "observations": [{"observation_id":"현장 관찰 ID","revision":1}]
}
```

주소 앞에는 `/api/v1`이 붙는다. ID는 실제 등록된 32자리 값으로 바꾼다.
처음 상태는 `in_progress`다. 근거 없이 초안부터 저장할 수도 있다.
완료하려면 공백이 아닌 `conclusion`과 모델 결과 또는 관찰 중 하나 이상의 근거가 필요하다.
`judgment=needs_check`로 판단을 보류한 채 검토를 완료할 수도 있다. 완료 상태는 고장 확정을 뜻하지 않는다.

모델은 본인의 같은 CSV 실행에서 학습한 모델을 지정한다. 선택한 구간도 해당 Valid 또는 Test 안에 있어야 한다.
Test 근거는 선택 모델의 Test 평가가 완료된 뒤에만 연결한다. 이 API는 학습·평가·모델 선택을 실행하지 않는다.
`evidence.model_result.partition_metrics`는 **선택한 분할 전체의 지표**다. 현재 선택한 짧은 구간의 지표로 표시하지 않는다.
입력·모델 해시, 특징 순서와 실행 당시 설정도 근거에 함께 보관한다.

관찰은 같은 자료·채널이고 검토 구간과 겹치는 기록을 지정한다. 관찰은 한 번에 50개까지 연결한다.
`revision`은 확인했던 관찰의 수정 번호다. 해당 버전의 내용을 그대로 저장하며 최신 내용으로 자동 교체하지 않는다.
이후 관찰이 바뀌어도 완료된 검토의 근거는 유지한다. 원본 라벨·모델 예측·관찰 내용도 이 API로 변경하지 않는다.

수정 가능한 항목은 채널·시각·결론·판단·연결 근거다. 데이터셋은 바꾸지 않는다.
`model_result=null`은 모델 연결 해제, `observations=[]`는 관찰 연결 해제다. 두 항목을 생략하면 기존 연결을 유지한다.
모든 변경 요청에 현재 수정 번호를 보낸다. 번호가 오래됐으면 `409 REVIEW_CONFLICT`다.
완료된 기록은 직접 수정할 수 없다. 사유를 적어 다시 열고 수정한 뒤 다시 완료한다.
동일한 현재 수정 번호로 완료를 다시 요청하면 이력을 중복해서 만들지 않는다.

이력에는 작업 종류·작성 계정·시각과 당시 전체 검토 내용이 남는다. 서버 재시작 후에도 유지한다.
목록의 `status`는 `in_progress/completed`, `judgment`는 관찰과 같은 세 값을 사용한다.
채널·시각 검색에는 `dataset_id`를 함께 지정한다. 모든 기록은 본인 계정에서만 조회·변경한다.

## 학습에서 점검 보고서까지

모든 경로 앞에 `/api/v1`을 붙인다. 기존 로그인 세션과 계정별 접근 범위를 유지한다.

| 요청 | 역할 |
| --- | --- |
| `POST /training/plan` | 전처리한 CSV에서 단일 XGBoost·AutoEncoder 설정, 시간순 분할·라벨 분포 제안 |
| `POST /runs`, `GET /runs/{id}` | 학습 시작, 실제 단계별 `training_progress`와 결과 조회 |
| `POST /replays` | 전체 원본 또는 Test에서 최대 230,000행 합성 재생 CSV 생성 |
| `GET /replays`, `GET /replays/{id}` | 생성 기록·원본 범위·출처 확인 |
| `GET /replays/{id}/batch` | `cursor`, `limit`, `channel`로 요청한 행만 저장 모델로 추론 |
| `GET /replays/{id}/file` | 생성 CSV 다운로드 |
| `POST /assistant/messages`, `GET /assistant/messages/{id}` | 실제 모델 결과·학습 과정·현장 관찰·문헌·입력 비용을 고정해 저장 |
| `POST /reports`, `GET /reports`, `GET /reports/{id}` | 저장한 답변으로 Word·PDF 생성, 상태·미리보기·목록 조회 |
| `GET /reports/{id}/download.docx`, `GET /reports/{id}/download.pdf` | 작성 완료 파일 다운로드 |
| `POST /simulations` | multipart `file`, `run_id`, `model_key`로 생성 CSV를 학습 모델에 연결 |
| `GET /simulations`, `GET /simulations/{id}` | 본인의 시뮬레이션 파일·기간·채널 조회 |
| `GET /simulations/{id}/batch` | `cursor`, `limit`(최대 1,000), `channel`로 도착할 행만 추론 |

Pro 점수는 해당 평가 구간의 비정상 F1 × 100이며 고장 확률이 아니다. 계산 불가능하면 점수를 만들지 않는다.
Pro+는 같은 결과를 상세 지표와 옵션으로 표시한다. 설명 방식은 권한을 바꾸지 않는다.
학습 과정은 서버의 실제 시작·완료·실패 기록이다. 과거 실행에 없는 기록은 생성하지 않는다.

재생은 실제 새 측정값·독립 성능 평가가 아니다. 전체 원본 재생에는 학습 구간이 포함된다.
부품 원인·교체 필요·현재 단가는 모델 출력으로 확정하지 않는다. 비용은 확인한 입력값만 계산한다.
외부 AI 키·모델을 서버 환경에 설정하지 않으면 문헌 검색 요약을 사용한다.

시뮬레이션 CSV는 원본 그대로 별도 저장한다. `timestamp`와 학습한 채널이 필요하며 라벨은 없어도 된다.
부가 컬럼과 CSV 라벨은 추론 입력에 넣지 않고, 저장한 모델의 채널 순서를 따른다. 재학습하지 않는다.
부품 잔여시간은 사용자가 넣은 기준수명에서 누적 운전시간을 뺀 값이다. 센서 기반 잔여수명 예측은 제공하지 않는다.

구간은 픽셀이나 배열 번호로 저장하지 않는다. 모델 결과는 실행 ID로 연결하고,
사람 판단·모델 라벨·검토 완료 상태는 합치지 않는다.

## 포석호 대화

`POST /api/v1/assistant/chat`은 질문과 앞선 대화를 받아 답한다. 비용과 모델 선택은 필수가 아니다.

```json
{
  "question": "지금 시뮬레이션 상태를 설명해줘.",
  "history": [{"role":"user","content":"펌프를 확인하고 있어."}],
  "expertise": "pro",
  "simulation_context": {
    "status": "playing", "cursor": 120, "total_rows": 43200,
    "signal_count": 2, "timestamp": "2026-11-01T01:59:00"
  }
}
```

- `history`는 최근 20개까지, 역할은 `user/assistant`만 받는다.
- `dataset_id`는 현재 선택한 본인의 CSV ID다. 학습 전 CSV도 질문할 수 있으며 서버가 저장한 검사 요약을 읽는다.
- `run_id`, `model_key`는 둘 다 생략하거나 본인의 같은 실행으로 함께 지정한다. `dataset_id`도 보내면 해당 실행의 CSV와 일치해야 한다. 다르면 `422 DATASET_CONTEXT_MISMATCH`다.
- 새 CSV를 묻는 화면에서는 이전 선택 실행을 자동으로 붙이지 않는다. 모델 결과를 묻는 화면에서는 해당 실행의 CSV를 연결한다.
- CSV 이름·행/채널 수·시간 범위·라벨 분포·결측/검사 항목만 제한된 크기로 AI에 전달한다. 원본 전체 셀을 읽었다고 안내하지 않는다.
- `observation`, `cost_inputs`, `simulation_context`는 선택이다. 빈 비용은 0원으로 만들지 않는다.
- 응답은 `answer`, `citations`, `limitations`, `source_mode`, 선택한 모델·입력 비용을 담는다.
- 외부 AI가 응답하면 `source_mode=llm`이다. 설정·잔액·통신 오류 때는 실제 원인에 맞는 오류를 반환하며 정해진 답변으로 성공을 가장하지 않는다.
- 모델 근거가 있으면 `report_message_id`를 반환해 기존 보고서 API에 연결한다. 일반 대화만으로 모델 보고서를 만들지 않는다.

대화 기록은 계정별로 저장한다. 전송된 시뮬레이션 상태는 브라우저에서 읽은 재생 상태이며 설비 실측값을 인증하는 정보는 아니다.
10분 안내는 시뮬레이션 화면에 있는 동안 최신 재생 상태를 요약한다. 이 타이머는 외부 AI를 호출하지 않는다.

## CSV 삭제와 복원

| API | 동작 |
| --- | --- |
| `DELETE /api/v1/datasets/{id}` | `204`. 본인 CSV를 휴지통으로 이동. 반복 요청 가능. |
| `GET /api/v1/datasets` | 활성 CSV만 조회. 기존 `limit`, `offset` 유지. |
| `GET /api/v1/datasets?deleted=true` | 휴지통 CSV만 조회. 응답 형식은 기존 목록과 동일. |
| `POST /api/v1/datasets/{id}/restore` | `200 DatasetDetail`. 기존 ID로 복원. 반복 요청 가능. |

삭제는 복원 가능한 목록 삭제다. 원본 파일, 데이터셋 ID, 계정, 기존 학습·예측·관찰·검토·보고서는 보존한다.
기존 실행 조회·평가에서 필요한 `GET /datasets/{id}`와 원본 다운로드는 소유자에게 계속 제공한다.
휴지통 자료의 새 학습, 자동 학습 설정, 모델 없이 새 CSV를 지정한 대화는 `409 DATASET_DELETED`다.
기존 모델과 같은 CSV를 지정한 결과 대화는 계속 가능하다. 같은 파일과 컬럼 설정을 다시 업로드하면 기존 ID로 복원한다.
새 `dataset_deletions` 테이블만 생성하며 기존 테이블의 컬럼·행·파일을 변경하지 않는다. 모든 쓰기에 기존 세션 인증과 요청 출처 검증을 적용한다.
