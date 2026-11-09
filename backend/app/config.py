"""실행 위치와 관계없이 backend/.env에서 설정을 읽는다."""

from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="KKOBUGI_",
        env_file=Path(__file__).resolve().parents[1] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "꼬부기 API"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    trusted_origins: list[str] = []
    environment: Literal["development", "production", "test"] = "development"
    database_path: Path = Path(__file__).resolve().parents[1] / ".runtime" / "kkobugi.sqlite3"
    session_ttl_seconds: int = Field(default=43_200, ge=60, le=604_800)
    cookie_name: str = Field(default="kkobugi_session", pattern=r"^[A-Za-z0-9_-]+$")
    cookie_secure: bool = False
    login_max_attempts: int = Field(default=5, ge=1, le=100)
    login_window_seconds: int = Field(default=900, ge=1, le=86_400)

    @field_validator("cors_origins", "trusted_origins")
    @classmethod
    def explicit_origins(cls, origins: list[str]) -> list[str]:
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.path not in {"", "/"}
                or parsed.query
                or parsed.fragment
                or "*" in origin
            ):
                raise ValueError("프런트엔드 주소는 http(s)://호스트[:포트]로 직접 지정하세요.")
            # 잘못된 포트도 앱 시작 시 거부한다.
            _ = parsed.port
        return [origin.rstrip("/") for origin in origins]

    @field_validator("database_path")
    @classmethod
    def stable_database_path(cls, path: Path) -> Path:
        if str(path) == ":memory:":
            return path
        path = path.expanduser()
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[1] / path
        return path.resolve()

    @model_validator(mode="after")
    def production_cookie(self) -> "Settings":
        if self.environment == "production" and not self.cookie_secure:
            raise ValueError("운영 환경에서는 KKOBUGI_COOKIE_SECURE=true가 필요합니다.")
        return self
