# API 연결 기준

Figma의 데이터 선택·CSV 검사 화면부터 연결한다. 실행 중인 서버의 `/openapi.json`이
요청·응답의 기준이며, `/docs`에서 같은 명세를 볼 수 있다.

- 주소: `/api/v1`. 쿠키 인증은 `credentials: "include"` 사용.
- 변경 요청: 허용된 `Origin`과 `X-Requested-With: kkobugi-web` 필요.
- 오류: `{"error":{"code":"...","message":"..."}}`. 입력 오류에는 `fields`도 포함.
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

나머지 열은 숫자 채널이다. 라벨이 `0/1`이면 두 라벨 값을 직접 지정한다.
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

## 다음 단계의 연결 단위

아래 기능은 아직 구현하지 않았다. CSV 등록 API와 별도로 이어서 개발한다.

| Figma 기능 | API 연결 단위 |
| --- | --- |
| 모델 선택·학습·비교 | `/models`, `/runs`: 데이터셋 ID·선택 모델·설정·평가지표·실행 상태 |
| 채널 그래프·구간 확대 | `/datasets/{id}/series`: 채널·실제 시작/종료 시각 |
| 현장 관찰 추가·수정 | `/observations`: 데이터셋·구간·관찰 내용·작성 계정 |
| 검토 완료 | `/reviews`: 사람 판단과 검토 완료 상태를 각각 저장 |
| RAG·보고서·문서 근거 | `/reports`, `/sources`: 실행 결과·관찰 기록·문서명·페이지·원문 |

구간은 픽셀이나 배열 번호로 저장하지 않는다. 모델 결과는 실행 ID로 연결하고,
사람 판단·모델 라벨·검토 완료 상태는 합치지 않는다.
