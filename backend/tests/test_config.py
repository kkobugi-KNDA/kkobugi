from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import Settings


def test_production_rejects_insecure_session_cookie():
    with pytest.raises(ValidationError, match="COOKIE_SECURE"):
        Settings(_env_file=None, environment="production", cookie_secure=False)
    assert Settings(_env_file=None, environment="production", cookie_secure=True).cookie_secure


def test_relative_database_path_does_not_depend_on_working_directory(tmp_path, monkeypatch):
    expected = Path(__file__).resolve().parents[1] / ".runtime" / "accounts.sqlite3"
    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None, database_path=Path(".runtime/accounts.sqlite3"))
    assert settings.database_path == expected


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
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **{field: [origin]})
