"""프런트 배포가 API 응답·비공개 파일 경계를 바꾸지 않는지 확인한다."""

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def deployed_client(tmp_path):
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html>kkobugi frontend</html>", encoding="utf-8")
    (assets / "app.js").write_text("console.log('kkobugi');", encoding="utf-8")
    (dist / ".env").write_text("PRIVATE=do-not-serve", encoding="utf-8")
    (tmp_path / "private.txt").write_text("outside-build", encoding="utf-8")
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "test.sqlite3",
        frontend_dist_path=dist,
    )
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.mark.parametrize("path", ["/", "/data", "/models", "/review", "/reports", "/costs"])
def test_page_refresh_returns_frontend(deployed_client, path):
    response = deployed_client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["cache-control"] == "no-cache"
    assert "kkobugi frontend" in response.text


def test_static_asset_and_head_request(deployed_client):
    response = deployed_client.get("/assets/app.js")
    assert response.status_code == 200
    assert "console.log" in response.text
    response = deployed_client.head("/review")
    assert response.status_code == 200
    assert response.content == b""


def test_api_health_and_auth_stay_on_backend(deployed_client):
    response = deployed_client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["service"] == "kkobugi-backend"
    assert deployed_client.get("/api/v1/auth/me").status_code == 401


@pytest.mark.parametrize(
    "path",
    [
        "/api",
        "/api/missing",
        "/api/v1/missing",
        "/api/%2e%2e/data",
        "/assets/missing.js",
        "/missing",
    ],
)
def test_missing_api_and_files_do_not_become_html(deployed_client, path):
    response = deployed_client.get(path)
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
    assert "kkobugi frontend" not in response.text


@pytest.mark.parametrize("path", ["/.env", "/%2e%2e/private.txt", "/assets/%2e%2e/.env"])
def test_private_and_outside_files_are_not_served(deployed_client, path):
    response = deployed_client.get(path)
    assert response.status_code == 404
    assert "do-not-serve" not in response.text
    assert "outside-build" not in response.text


def test_frontend_does_not_accept_post(deployed_client):
    assert deployed_client.post("/data").status_code == 405


def test_configured_missing_build_fails_before_serving(tmp_path):
    settings = Settings(_env_file=None, frontend_dist_path=tmp_path / "missing")
    with pytest.raises(RuntimeError, match="index.html"):
        create_app(settings)
