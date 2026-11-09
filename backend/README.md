# 백엔드

Python 3.12와 uv를 사용한다.

```powershell
cd backend
uv sync --group dev
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 서버 확인: http://127.0.0.1:8000/api/v1/health
- API 문서: http://127.0.0.1:8000/docs
- 프런트엔드 연결 기준: [API.md](API.md)
- 설정 변경: `.env.example`을 `.env`로 복사해 수정
- 검사: `uv run pytest` / `uv run ruff check .`

계정은 관리 명령으로 만들고, 비밀번호는 두 번 직접 입력한다. 공개 회원가입은 없다.

```powershell
uv run python -m app.cli create-user --username minho --display-name 박민호
```

- 아이디: 영문·숫자·`_.-` 3~64자, 대소문자 구분 없음
- 비밀번호: 12~128자, Argon2id 해시로 저장
- DB: `backend/.runtime/kkobugi.sqlite3`. 실행 위치가 바뀌어도 같은 파일을 사용
- 업로드 CSV: `backend/.runtime/datasets`. 원본은 그대로 두고 검사 결과를 DB에 저장
- 학습 모델: `backend/.runtime/models`. 입력·분할·특징 순서와 패키지 버전을 함께 저장

| API | 동작 |
| --- | --- |
| `POST /api/v1/auth/login` | `username`, `password`로 로그인. HttpOnly 쿠키 발급 |
| `GET /api/v1/auth/me` | 로그인 사용자와 남은 세션 시간 확인 |
| `POST /api/v1/auth/logout` | 현재 브라우저 세션 삭제, 쿠키 해제 |

세션은 12시간 후 만료된다. DB에는 토큰 해시만 저장하며, 서버 재시작 후에도 유지된다.
같은 계정·접속 IP에서 15분 안에 5회 실패하면 남은 시간 동안 로그인을 제한한다.
로그아웃은 다른 브라우저의 세션을 지우지 않는다.

프런트엔드는 요청에 `credentials: "include"`를 넣는다. 변경 요청에는 허용된 `Origin`과
`X-Requested-With: kkobugi-web`이 필요하고, 로그인은 `Content-Type: application/json`을 사용한다.
오류는 `{"error":{"code":"...","message":"..."}}` 형식이다.
보호할 API에는 `Depends(app.api.auth.get_current_user)`를 연결한다.

운영 시 `KKOBUGI_ENVIRONMENT=production`, `KKOBUGI_COOKIE_SECURE=true`로 설정한다.

Render에서는 루트 `Dockerfile`로 프런트 빌드와 API를 함께 실행한다. 프런트 API 주소는
`/api/v1`이며, `KKOBUGI_FRONTEND_DIST_PATH`로 지정한 빌드 폴더만 공개한다.
`KKOBUGI_TRUSTED_ORIGINS`에는 실제 접속 주소를 JSON 배열로 지정한다.
계정 DB·업로드 CSV·학습 모델은 `/var/data/kkobugi` 영구 디스크에 보관한다.
기존 자료는 이미지나 Git에 넣지 않고 백업본으로 이전한다. API 프로세스는 하나로 실행한다.

로그인 검증·CSV 검사·그래프/예측 생성·학습/평가는 메모리를 나눠 쓰도록 하나씩 실행한다.
동시에 최대 16개 작업이 입장하며 60초를 넘게 기다리면 `503`과 `Retry-After: 3`을 반환한다.
대기 중에도 화면·내 정보·작업 상태는 조회할 수 있다. 데이터·모델 설정·암호 해시 강도는 같다.
CSV 업로드 한도는 그대로이며 로그인 JSON은 16KiB, 다른 API 요청 본문은 1MiB까지 받는다.

모델 비교는 `GET /api/v1/models` → `POST /api/v1/runs` → Valid 결과 비교 → 사용자 선택 → Test 평가 순서다.
시간 분할 경계는 사용자가 직접 지정한다. 이 로컬 실행은 API 프로세스 하나에서 작업을 차례로 처리한다.
입력과 실행 예시는 [API.md](API.md)를 따른다.

새 학습 모델은 XGBoost·LightGBM·AutoEncoder다. 이전 Dummy 실행은 그대로 읽을 수 있다.
구간 그래프·원본 라벨·예측 구간은 조회 API로 연결한다. 현장 관찰은 원본과 분리해 DB에 저장하고,
수정 번호와 이력을 남긴다. 전체 주소와 요청 형식은 [API.md](API.md)에 정리했다.

검토는 `/api/v1/reviews`에서 저장하고 완료한다. 모델 결과와 관찰의 확인한 버전을 근거로 남긴다.
완료 후에는 다시 열어야 수정할 수 있고, 모든 변경은 수정 이력에 보관한다.

다른 worktree에서 같은 로컬 자료를 사용할 때는 `.env`의 `KKOBUGI_DATABASE_PATH`,
`KKOBUGI_DATASET_STORAGE_PATH`, `KKOBUGI_MODEL_STORAGE_PATH`를 기존 저장소의 절대 경로로 맞춘다.
DB만 옮기고 CSV·모델 폴더를 빼면 기록에 연결된 파일을 읽을 수 없다. `.env`와 실제 자료는 커밋하지 않는다.
