import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import Settings, create_app


@pytest.fixture
def client():
    settings = Settings(_env_file=None, cors_origins=["http://localhost:5173"])
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
    schema = client.get("/openapi.json").json()
    operation = schema["paths"]["/api/v1/health"]["get"]
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HealthResponse"
    }
    assert client.get("/docs").status_code == 200


def test_cors_accepts_configured_frontend(client):
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
