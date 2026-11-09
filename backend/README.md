# 백엔드

Python 3.12와 uv를 사용한다.

```powershell
cd backend
uv sync --group dev
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 서버 확인: http://127.0.0.1:8000/api/v1/health
- API 문서: http://127.0.0.1:8000/docs
- 설정 변경: `.env.example`을 `.env`로 복사해 수정
- 검사: `uv run pytest` / `uv run ruff check .`

계정은 관리 명령으로 만들고, 비밀번호는 두 번 직접 입력한다. 공개 회원가입은 없다.

```powershell
uv run python -m app.cli create-user --username minho --display-name 박민호
```

- 아이디: 영문·숫자·`_.-` 3~64자, 대소문자 구분 없음
- 비밀번호: 12~128자, Argon2id 해시로 저장
- DB: `backend/.runtime/kkobugi.sqlite3`. 실행 위치가 바뀌어도 같은 파일을 사용

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
프런트엔드 주소는 `KKOBUGI_CORS_ORIGINS`에 지정한다. 같은 출처 프록시 주소는
`KKOBUGI_TRUSTED_ORIGINS`에도 지정할 수 있다. Vercel → Render는 같은 출처의 `/api` 프록시를
사용할 예정이며, DB 경로는 영구 디스크에 둬야 한다. 배포는 아직 포함하지 않았다.
