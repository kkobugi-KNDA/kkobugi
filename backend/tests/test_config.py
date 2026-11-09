"""실행 위치가 바뀌어도 DB 경로와 운영 인증 설정이 유지되는지 확인한다."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_production_rejects_insecure_session_cookie():
    # 운영 환경에서 HTTPS 전용 쿠키를 끄면 앱 시작 단계에서 거부해야 한다.
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings(_env_file=None, environment="production", cookie_secure=False)
    assert Settings(_env_file=None, environment="production", cookie_secure=True).cookie_secure


def test_relative_database_path_does_not_depend_on_working_directory(tmp_path, monkeypatch):
    # 다른 폴더에서 실행해도 backend 아래의 같은 DB 파일을 가리켜야 한다.
    expected_database_path = Path(__file__).resolve().parents[1] / ".runtime" / "accounts.sqlite3"

    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None, database_path=Path(".runtime/accounts.sqlite3"))

    assert settings.database_path == expected_database_path


def test_relative_upload_path_does_not_depend_on_working_directory(tmp_path, monkeypatch):
    # 실행 폴더가 달라져도 이미 등록한 CSV를 같은 폴더에서 찾는다.
    expected_storage_path = Path(__file__).resolve().parents[1] / ".runtime" / "datasets"

    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None, dataset_storage_path=Path(".runtime/datasets"))

    assert settings.dataset_storage_path == expected_storage_path


@pytest.mark.parametrize("field", ["cors_origins", "trusted_origins"])
@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "null",
        "https://*.example",
        "https://user:password@example.com",
        "https://example.com/path",
    ],
)
def test_origins_require_explicit_web_origin(field, origin):
    # 와일드카드, 로그인 정보, 경로를 포함한 주소를 허용 목록에 넣지 못하게 한다.
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: [origin]})
