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

현재 구현 범위는 기본 서버·설정·CORS·상태 확인 API다.
