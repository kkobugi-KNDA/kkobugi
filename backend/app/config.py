"""실행 위치와 관계없이 backend/.env에서 설정을 읽는다."""

from pathlib import Path

from pydantic import field_validator
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

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, origins: list[str]) -> list[str]:
        if "*" in origins:
            raise ValueError("CORS에는 프런트엔드 주소를 직접 지정하세요.")
        return [origin.rstrip("/") for origin in origins]
