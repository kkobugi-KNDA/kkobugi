"""서버 상태와 문서, 허용된 프런트엔드 연결을 확인한다."""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import Settings, create_app


@pytest.fixture
def client(tmp_path):
    # 테스트 계정과 파일이 실제 실행 환경에 남지 않도록 임시 DB를 사용한다.
    settings = Settings(
        _env_file=None,
        database_path=tmp_path / "health.sqlite3",
        cors_origins=["http://localhost:5173"],
    )

    with TestClient(create_app(settings)) as test_client:
        yield test_client


def test_health_returns_service_version(client):
    response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "kkobugi-backend",
        "version": "0.1.0",
    }


def test_api_documentation_exposes_health_schema(client):
    # API 문서가 실제 응답 모델과 연결되는지 함께 확인한다.
    schema = client.get("/openapi.json").json()

    operation = schema["paths"]["/api/v1/health"]["get"]

    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HealthResponse"
    }
    assert client.get("/docs").status_code == 200


def test_cors_accepts_configured_frontend(client):
    # 브라우저가 실제 요청 전에 보내는 사전 요청을 재현한다.
    response = client.options(
        "/api/v1/health",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert response.headers["access-control-allow-credentials"] == "true"


def test_cors_rejects_other_frontend(client):
    # 등록되지 않은 사이트에는 쿠키를 사용하는 연결을 허용하지 않는다.
    response = client.options(
        "/api/v1/health",
        headers={
            "Origin": "https://unlisted.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers


def test_wildcard_cors_is_rejected():
    with pytest.raises(ValidationError, match="프런트엔드 주소"):
        Settings(_env_file=None, cors_origins=["*"])
