"""실행 위치와 관계없이 backend/.env에서 설정을 읽는다."""

from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 실행한 폴더가 달라도 설정 파일과 DB를 같은 위치에서 찾는다.
BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KKOBUGI_",
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "꼬부기 API"

    # 브라우저가 API를 호출할 수 있는 프런트엔드 주소다.
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    # 같은 출처의 /api 프록시 등 변경 요청을 허용할 주소를 추가한다.
    trusted_origins: list[str] = []

    environment: Literal["development", "production", "test"] = "development"

    database_path: Path = BACKEND_DIR / ".runtime" / "kkobugi.sqlite3"

    # 업로드 원본은 DB와 별도로 보관하고, API를 통해서만 접근한다.
    dataset_storage_path: Path = BACKEND_DIR / ".runtime" / "datasets"

    # 학습한 모델은 서버가 만든 파일만 이 폴더에서 읽는다.
    model_storage_path: Path = BACKEND_DIR / ".runtime" / "models"

    # 배포할 때만 프런트 빌드 폴더를 지정한다. 개발 API는 기존대로 단독 실행한다.
    frontend_dist_path: Path | None = None

    # 한 번에 한 모델 작업을 실행하고, 나머지는 제한된 대기열에 둔다.
    max_pending_runs: int = Field(default=8, ge=1, le=100)

    max_training_rows: int = Field(default=250_000, ge=3, le=1_000_000)

    max_training_features: int = Field(default=128, ge=1, le=128)

    # 파일 크기는 바이트, 행·열 제한은 CSV 검사에 사용한다.
    max_upload_bytes: int = Field(default=200 * 1024 * 1024, ge=1, le=1024 * 1024 * 1024)

    max_dataset_rows: int = Field(default=1_000_000, ge=1, le=10_000_000)

    max_dataset_columns: int = Field(default=256, ge=3, le=4096)

    # 기본 세션은 12시간이며, 모든 시간 설정의 단위는 초다.
    session_ttl_seconds: int = Field(default=43_200, ge=60, le=604_800)

    cookie_name: str = Field(default="kkobugi_session", pattern=r"^[A-Za-z0-9_-]+$")

    cookie_secure: bool = False

    # 같은 계정·접속 IP의 실패 횟수를 제한한다.
    login_max_attempts: int = Field(default=5, ge=1, le=100)

    login_window_seconds: int = Field(default=900, ge=1, le=86_400)

    @field_validator("cors_origins", "trusted_origins")
    @classmethod
    def validate_origins(cls, origins: list[str]) -> list[str]:
        # 경로나 와일드카드를 허용하지 않아 요청 출처를 정확히 비교한다.
        for origin in origins:
            parsed_origin = urlsplit(origin)

            if (
                parsed_origin.scheme not in {"http", "https"}
                or not parsed_origin.hostname
                or parsed_origin.username is not None
                or parsed_origin.password is not None
                or parsed_origin.path not in {"", "/"}
                or parsed_origin.query
                or parsed_origin.fragment
                or "*" in origin
            ):
                raise ValueError("프런트엔드 주소는 http(s)://호스트[:포트]로 직접 지정하세요.")
            # 잘못된 포트도 앱 시작 시 거부한다.
            _ = parsed_origin.port

        return [origin.rstrip("/") for origin in origins]

    @field_validator("database_path", "dataset_storage_path", "model_storage_path")
    @classmethod
    def resolve_local_path(cls, local_path: Path) -> Path:
        # 메모리 DB는 테스트에서 사용하며 파일 경로로 변환하지 않는다.
        if str(local_path) == ":memory:":
            return local_path
        local_path = local_path.expanduser()

        if not local_path.is_absolute():
            local_path = BACKEND_DIR / local_path

        return local_path.resolve()

    @field_validator("frontend_dist_path")
    @classmethod
    def resolve_frontend_path(cls, frontend_path: Path | None) -> Path | None:
        if frontend_path is None:
            return None
        frontend_path = frontend_path.expanduser()
        if not frontend_path.is_absolute():
            frontend_path = BACKEND_DIR / frontend_path
        return frontend_path.resolve()

    @model_validator(mode="after")
    def require_secure_cookie(self) -> "Settings":
        # 운영에서는 HTTPS 연결에만 세션 쿠키를 전달한다.
        if self.environment == "production" and not self.cookie_secure:
            raise ValueError("운영 환경에서는 KKOBUGI_COOKIE_SECURE=true가 필요합니다.")
        return self
