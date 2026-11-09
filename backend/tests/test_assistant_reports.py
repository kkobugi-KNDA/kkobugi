"""실제 모델 결과, 문헌 검색, 입력 비용과 계정별 보고서 저장을 함께 확인한다."""

import io
import json
import time
from zipfile import ZipFile

import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import select
from test_runs import (
    WRITE_HEADERS,
    create_run,
    login_user,
    upload_dataset,
    wait_for_training,
)
from test_runs import run_client as run_client
from test_runs import run_password_hash as run_password_hash

from app.config import Settings
from app.models import ModelRun
from app.schemas.assistant import CostInputs
from app.services.assistant import calculate_cost, private_path, retrieve
from app.services.reports import ReportManager


@pytest.fixture
def run_settings(tmp_path):
    # 실제 .env나 OS 환경에 키가 있어도 단위 테스트는 유료 API를 호출하지 않는다.
    # LLM 경로는 아래 ProviderClient 모의 응답 테스트에서만 명시적으로 켠다.
    return Settings(
        _env_file=None,
        environment="test",
        database_path=tmp_path / "accounts.sqlite3",
        dataset_storage_path=tmp_path / "datasets",
        model_storage_path=tmp_path / "models",
        cors_origins=["http://localhost:5173"],
        anthropic_api_key=None,
        anthropic_model="",
    )


def test_missing_cost_is_unknown_instead_of_zero():
    estimate = calculate_cost(None)

    assert estimate.total is None
    assert estimate.known_subtotal == 0
    assert len(estimate.missing) == 4
    assert estimate.parts_cost is None


def test_cost_uses_only_explicit_inputs_with_reproducible_arithmetic():
    estimate = calculate_cost(
        CostInputs(
            component_name="사용자가 지정한 씰",
            quote_source="사내 견적 A",
            parts_cost=100000,
            inspection_cost=20000,
            labor_hours=2.5,
            labor_hourly_rate=40000,
            downtime_hours=1.5,
            downtime_loss_per_hour=200000,
            standby_available=True,
        )
    )

    assert estimate.total == 520000
    assert estimate.labor_cost == 100000
    assert estimate.downtime_cost == 300000
    assert estimate.missing == []
    assert any(
        "모델이 이 부품의 고장을 확정한 것은 아니다" in item for item in estimate.assumptions
    )
    assert any("진위" in item for item in estimate.assumptions)


def test_explicit_zero_is_retained_but_partial_labor_is_not_invented():
    complete = calculate_cost(
        CostInputs(
            parts_cost=0,
            inspection_cost=0,
            labor_hours=0,
            labor_hourly_rate=0,
            downtime_hours=0,
            downtime_loss_per_hour=0,
        )
    )

    assert complete.total == 0
    partial = calculate_cost(CostInputs(parts_cost=0, labor_hours=2))

    assert partial.labor_cost is None
    assert partial.total is None


@pytest.mark.parametrize("invalid", [-1, float("nan"), float("inf"), 1e20])
def test_cost_rejects_nonfinite_negative_and_unbounded_amounts(invalid):
    with pytest.raises(ValidationError):
        CostInputs(parts_cost=invalid)


def test_retrieval_matches_symptoms_and_keeps_primary_source_provenance():
    chunks = retrieve("축봉 누수가 보이는데 씰 교체 비용은?", "메카니컬 씰 부근에 물이 보임")

    assert "DOE-SEALS" in {item["id"] for item in chunks}
    assert "DOE-LCC-METHOD" in {item["id"] for item in chunks}
    assert all(
        item["url"].startswith(("https://www.energy.gov/", "https://www1.eere.energy.gov/"))
        for item in chunks
    )
    assert all(item["pages"].startswith("PDF") for item in chunks)
    assert "DOE-DATA-SCOPE" in {item["id"] for item in retrieve("안녕하세요")}


@pytest.fixture
def ready_model(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["xgboost"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    return run_client, run_id


def message_payload(run_id, **changes):
    body = {
        "run_id": run_id,
        "model_key": "xgboost",
        "question": "누수 흔적이 보임. 교체와 비용을 어떻게 확인할까?",
        "observation": "사용자가 축봉 부근에서 물을 관찰함.",
        "expertise": "pro",
    }

    body.update(changes)
    return body


def post_message(client, run_id, **changes):
    response = client.post(
        "/api/v1/assistant/messages", json=message_payload(run_id, **changes), headers=WRITE_HEADERS
    )

    assert response.status_code == 201, response.text
    return response.json()


def wait_report(client, report_id):
    # 첫 한글 글꼴 포함 작업은 병렬 빌드·학습이 실행 중인 PC에서 더 오래 걸릴 수 있다.
    deadline = time.monotonic() + 30

    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/reports/{report_id}")

        assert response.status_code == 200, response.text
        if response.json()["status"] in {"completed", "failed"}:
            return response.json()
        time.sleep(0.025)
    raise AssertionError("보고서 작성 대기 시간 초과")


def test_assistant_reads_owned_model_before_explanation_and_keeps_unknown_cost(ready_model):
    client, run_id = ready_model

    before = client.get(f"/api/v1/runs/{run_id}").json()

    message = post_message(client, run_id)

    assert message["source_mode"] == "retrieval"
    assert message["model_snapshot"]["metrics_scope"] == "full_partition"
    assert message["model_snapshot"]["metrics"]["sample_count"] == 15
    assert message["model_snapshot"]["score_formula"] == "UnNormal F1 × 100"
    assert (
        message["model_snapshot"]["score_100"] == message["model_snapshot"]["metrics"]["f1"] * 100
    )
    assert message["cost"]["total"] is None
    assert "비용을 계산할 입력값이 없다" in message["answer"]
    assert "소계: 0원" not in message["answer"]
    assert message["citations"]
    assert any("확정할 수 없다" in item for item in message["limitations"])
    assert client.get(f"/api/v1/runs/{run_id}").json() == before
    assert client.get(f"/api/v1/assistant/messages/{message['message_id']}").json() == message


def test_test_scope_requires_finished_explicit_evaluation_and_never_starts_it(ready_model):
    client, run_id = ready_model

    response = client.post(
        "/api/v1/assistant/messages",
        json=message_payload(run_id, split="test"),
        headers=WRITE_HEADERS,
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TEST_NOT_EVALUATED"
    assert client.get(f"/api/v1/runs/{run_id}").json()["run"]["evaluation_status"] == "not_started"


def test_process_explanation_captures_actual_saved_events_configuration_and_options(ready_model):
    client, run_id = ready_model

    run_detail = client.get(f"/api/v1/runs/{run_id}").json()

    message = post_message(
        client,
        run_id,
        question="어떤 전처리와 학습을 했고 데이터를 어떻게 분할했나?",
        expertise="pro-plus",
    )

    snapshot = message["model_snapshot"]

    assert snapshot["training_configuration"] == run_detail["configuration"]
    assert snapshot["training_progress"] == run_detail["training_progress"]
    assert snapshot["training_progress"]
    assert {event["stage"] for event in snapshot["training_progress"]} == {
        "data_check",
        "split",
        "input_preparation",
        "training",
        "validation",
        "saving",
        "completed",
    }
    assert snapshot["training_split"] == run_detail["split"]
    assert snapshot["model_parameters"]["n_estimators"] == 100
    assert "모델을 만든 과정" in message["answer"]
    assert "Train 30행" in message["answer"]
    assert "사용한 채널 순서: sensor_00, sensor_01" in message["answer"]
    assert "실제 모델 옵션" in message["answer"]
    report = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    process_section = next(
        section
        for section in report.json()["preview"]["sections"]
        if section["heading"] == "모델을 만든 과정"
    )

    assert "시간순 분할: Train 30행" in "\n".join(process_section["paragraphs"])


@pytest.mark.parametrize(
    "question",
    [
        "이 데이터로 모델을 만든 과정과 누수 점검 순서, 입력한 비용 계산을 정리해줘.",
        "이 모델 어떻게 만든 거야?",
        "만든 과정도 알려줘.",
    ],
)
def test_plain_language_process_questions_include_actual_model_steps(ready_model, question):
    client, run_id = ready_model

    message = post_message(client, run_id, question=question)

    assert "모델을 만든 과정" in message["answer"]
    assert "학습용 30행" in message["answer"]
    assert "선택한 2개 채널" in message["answer"]
    assert "사용한 채널 순서" not in message["answer"]
    assert message["model_snapshot"]["training_progress"]
    assert "모델 학습 · 완료" in message["answer"]


def test_pro_report_hides_technical_metadata_but_preserves_full_snapshot(ready_model):
    client, run_id = ready_model

    message = post_message(client, run_id, question="이 모델을 만든 과정을 알려줘.")

    created = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    assert created.status_code == 202
    preview = created.json()["preview"]

    text = "\n".join(
        paragraph for section in preview["sections"] for paragraph in section["paragraphs"]
    )

    snapshot = preview["model_snapshot"]

    assert "선택한 2개 채널" in text
    assert "학습용 30행" in text
    assert "학습에 사용한 마지막 시각" in text
    assert "SHA256" not in text
    assert "사용한 채널 순서" not in text
    assert "실제 모델 옵션" not in text
    assert snapshot["input_sha256"] == message["model_snapshot"]["input_sha256"]
    assert snapshot["artifact_sha256"] == message["model_snapshot"]["artifact_sha256"]
    assert snapshot["feature_columns"] == ["sensor_00", "sensor_01"]
    assert snapshot["model_parameters"]["n_estimators"] == 100


def test_old_run_without_process_log_keeps_saved_configuration_and_does_not_invent_events(
    ready_model,
):
    client, run_id = ready_model

    with client.app.state.database.session_factory() as session:
        model_run = session.scalar(select(ModelRun).where(ModelRun.id == run_id))

        report = dict(model_run.training_report)

        report.pop("training_progress", None)
        model_run.training_report = report
        session.commit()
    message = post_message(client, run_id, question="학습 과정과 전처리를 알려줘")

    assert message["model_snapshot"]["training_progress"] == []
    assert message["model_snapshot"]["training_configuration"]["train_end"]
    assert "상세 학습 과정 로그가 기록되지 않았다" in message["answer"]
    assert "중간 확인용 15행" in message["answer"]
    assert "실제 모델 옵션" not in message["answer"]


def test_autoencoder_process_uses_recorded_normal_train_scaler_and_threshold(run_client):
    dataset_id = upload_dataset(run_client)

    run_id = create_run(run_client, dataset_id, models=["autoencoder"])

    assert wait_for_training(run_client, run_id)["run"]["status"] == "completed"
    message = post_message(
        run_client,
        run_id,
        model_key="autoencoder",
        question="학습과 전처리 과정을 설명해줘",
        expertise="pro-plus",
    )

    parameters = message["model_snapshot"]["model_parameters"]

    assert parameters["training_scope"] == "normal_train_only"
    assert parameters["scaler"] == "StandardScaler"
    assert "정상으로 표시된 학습용 행만" in message["answer"]
    assert "정상 Train에 StandardScaler를 fit" in message["answer"]
    assert str(parameters["threshold"]) in message["answer"]


def test_completed_test_uses_test_metrics_without_retraining(ready_model):
    client, run_id = ready_model

    selected = client.post(
        f"/api/v1/runs/{run_id}/selection",
        json={"model_key": "xgboost"},
        headers=WRITE_HEADERS,
    )

    assert selected.status_code == 200
    response = client.post(f"/api/v1/runs/{run_id}/evaluation", headers=WRITE_HEADERS)

    assert response.status_code == 202, response.text
    deadline = time.monotonic() + 10

    while time.monotonic() < deadline:
        evaluation = client.get(f"/api/v1/runs/{run_id}/evaluation").json()

        if evaluation["status"] in {"completed", "failed"}:
            break
        time.sleep(0.025)
    assert evaluation["status"] == "completed"
    run_before = client.get(f"/api/v1/runs/{run_id}").json()

    message = post_message(client, run_id, split="test")

    assert message["model_snapshot"]["metrics"] == evaluation["metrics"]
    assert message["model_snapshot"]["split"] == "test"
    assert client.get(f"/api/v1/runs/{run_id}").json() == run_before


def test_reports_are_private_persistent_idempotent_and_real_word_pdf(ready_model):
    client, run_id = ready_model

    message = post_message(client, run_id, expertise="pro-plus")

    created = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    assert created.status_code == 202, created.text
    report_id = created.json()["id"]

    second = client.post(
        "/api/v1/reports",
        json={"message_id": message["message_id"], "title": "중복 제목"},
        headers=WRITE_HEADERS,
    )

    assert second.status_code == 202
    assert second.json()["id"] == report_id
    report = wait_report(client, report_id)

    assert report["status"] == "completed", report
    assert report["title"] == "펌프 점검 검토 보고서"
    assert report["preview"]["model_snapshot"] == message["model_snapshot"]
    preview_text = "\n".join(
        paragraph
        for section in report["preview"]["sections"]
        for paragraph in section["paragraphs"]
    )

    assert "계산할 입력값이 없어 소계는 미정" in preview_text
    assert "소계: 0원" not in preview_text
    pdf = client.get(f"/api/v1/reports/{report_id}/download.pdf")

    word = client.get(f"/api/v1/reports/{report_id}/download.docx")

    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF-")
    assert word.status_code == 200 and word.content.startswith(b"PK")
    with ZipFile(io.BytesIO(word.content)) as archive:
        assert "펌프 점검 검토 보고서" in archive.read("word/document.xml").decode()
        assert "고장 확정서는 아니다" in archive.read("word/document.xml").decode()
        from xml.etree import ElementTree

        styles = ElementTree.fromstring(archive.read("word/styles.xml"))

        namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}

        title_style = styles.find("w:style[@w:styleId='Title']", namespaces)

        assert title_style.find("w:pPr/w:pBdr", namespaces) is None
        fonts = title_style.find("w:rPr/w:rFonts", namespaces)

        assert not any("Theme" in attribute for attribute in fonts.attrib)
    restarted = ReportManager(client.app.state.settings)

    try:
        restarted.recover_interrupted()
        assert restarted.get(1, report_id).model_dump(mode="json") == report
    finally:
        restarted.shutdown()
    assert client.get("/api/v1/reports").json()["total"] == 1
    login_user(client, "bob")
    assert client.get(f"/api/v1/assistant/messages/{message['message_id']}").status_code == 404
    assert client.get(f"/api/v1/reports/{report_id}").status_code == 404
    assert client.get(f"/api/v1/reports/{report_id}/download.pdf").status_code == 404
    assert (
        client.post(
            "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
        ).status_code
        == 404
    )
    assert client.get("/api/v1/reports").json()["total"] == 0
    assert (
        client.post(
            "/api/v1/assistant/messages", json=message_payload(run_id), headers=WRITE_HEADERS
        ).status_code
        == 404
    )


def test_incomplete_report_cannot_download_and_interruption_is_visible(ready_model, monkeypatch):
    client, run_id = ready_model

    message = post_message(client, run_id)

    manager = client.app.state.report_manager

    monkeypatch.setattr(manager, "_generate", lambda *arguments: manager._pending.release())
    response = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    report_id = response.json()["id"]

    assert client.get(f"/api/v1/reports/{report_id}/download.pdf").status_code == 409
    manager.recover_interrupted()
    assert client.get(f"/api/v1/reports/{report_id}").json()["status"] == "failed"


def test_report_failure_has_no_internal_path_and_retry_reuses_identifier(ready_model, monkeypatch):
    client, run_id = ready_model

    message = post_message(client, run_id)

    import app.services.reports as report_service

    original = report_service._write_pdf

    def fail_pdf(*arguments):
        raise RuntimeError("secret /server/internal/file.pdf")

    monkeypatch.setattr(report_service, "_write_pdf", fail_pdf)
    response = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    report_id = response.json()["id"]

    failed = wait_report(client, report_id)

    assert failed["status"] == "failed"
    assert "secret" not in failed["error_message"]
    monkeypatch.setattr(report_service, "_write_pdf", original)
    retry = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    assert retry.json()["id"] == report_id
    assert wait_report(client, report_id)["status"] == "completed"


def test_assistant_and_report_routes_require_session_and_csrf(run_client):
    run_client.post("/api/v1/auth/logout", headers=WRITE_HEADERS)
    assert run_client.get("/api/v1/reports").status_code == 401
    assert run_client.get(f"/api/v1/reports/{'a' * 32}").status_code == 401
    assert run_client.post("/api/v1/reports", json={"message_id": "a" * 32}).status_code == 403


def test_frozen_message_is_not_regenerated_after_model_result_changes(ready_model):
    client, run_id = ready_model

    message = post_message(client, run_id)

    path = private_path(client.app.state.settings, "assistant", 1, message["message_id"])

    stored_before = path.read_bytes()

    response = client.post(
        "/api/v1/reports", json={"message_id": message["message_id"]}, headers=WRITE_HEADERS
    )

    report = wait_report(client, response.json()["id"])

    assert (
        report["preview"]["model_snapshot"]
        == json.loads(stored_before)["response"]["model_snapshot"]
    )
    assert path.read_bytes() == stored_before


@pytest.mark.parametrize(
    ("provider_answer", "expected_mode"),
    [
        ('{"note_ids":["N1"],"check_ids":["C1"]}', "llm"),
        ("AI 작성 참고 의견: 축봉 방식을 먼저 확인하세요.", "retrieval"),
        ("씰 교체비는 50000원이며 반드시 교체해야 합니다.", "retrieval"),
        ("메카니컬 씰이 파손됐습니다. 즉시 새 씰로 바꿔야 합니다.", "retrieval"),
        ('{"note_ids":["N999"],"check_ids":["C1"]}', "retrieval"),
        ('{"note_ids":["N1"],"check_ids":["C999"]}', "retrieval"),
        ('{"note_ids":["N1","N1"],"check_ids":["C1"]}', "retrieval"),
        ('{"note_ids":["N1"],"check_ids":["C1"],"diagnosis":"씰 파손"}', "retrieval"),
        ('{"note_ids":[true],"check_ids":["C1"]}', "retrieval"),
    ],
)
def test_optional_llm_can_only_select_prepared_sentences_by_identifier(
    ready_model, monkeypatch, provider_answer, expected_mode
):
    client, run_id = ready_model

    import httpx

    import app.services.assistant as assistant_service

    settings = client.app.state.settings

    settings.anthropic_api_key = SecretStr("test-server-key-never-persist")
    settings.anthropic_model = "test-only-model"
    calls = []

    class ProviderClient:
        def __init__(self, **options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            return None

        def post(self, url, **options):
            calls.append((url, options))
            return httpx.Response(
                200,
                json={"content": [{"type": "text", "text": provider_answer}]},
                request=httpx.Request("POST", url),
            )

    monkeypatch.setattr(assistant_service.httpx, "Client", ProviderClient)
    message = post_message(client, run_id)

    assert calls[0][0] == "https://api.anthropic.com/v1/messages"
    assert calls[0][1]["headers"]["x-api-key"] == "test-server-key-never-persist"
    assert "부품 특정" in calls[0][1]["json"]["system"]
    assert "temperature" not in calls[0][1]["json"]
    assert message["source_mode"] == expected_mode
    assert "50000" not in message["answer"]
    assert "파손됐습니다" not in message["answer"]
    assert "바꿔야 합니다" not in message["answer"]
    if expected_mode == "llm":
        assert "AI가 문헌에서 선택한 확인 순서" in message["answer"]
        sent_context = json.loads(calls[0][1]["json"]["messages"][0]["content"])

        assert sent_context["allowed_notes"]["N1"] in message["answer"]
        assert sent_context["allowed_checks"]["C1"] in message["answer"]
    stored = private_path(settings, "assistant", 1, message["message_id"]).read_text(
        encoding="utf-8"
    )

    assert "test-server-key" not in stored
    assert message["cost"]["total"] is None
