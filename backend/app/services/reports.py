"""저장한 설명을 고정해 계정별 Word·PDF 보고서를 순서대로 생성한다."""

import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from xml.sax.saxutils import escape

from pydantic import ValidationError

from app.config import Settings
from app.memory_work import MemoryWorkBusy, MemoryWorkGate
from app.schemas.assistant import (
    AssistantRequest,
    AssistantResponse,
    ReportCreate,
    ReportList,
    ReportPreview,
    ReportResponse,
    ReportSection,
)
from app.services.assistant import (
    assistant_error,
    get_message,
    load_json,
    private_path,
    save_json,
    training_process_paragraphs,
)


def _clean_text(value: str) -> str:
    # XML 문서에서 허용되지 않는 제어문자는 내용이 아니라 표시 불가능한 문자다.
    return "".join(character for character in value if ord(character) >= 32 or character in "\n\t")


def build_preview(title: str, saved_message: dict) -> ReportPreview:
    answer = AssistantResponse.model_validate(saved_message["response"])

    question = AssistantRequest.model_validate(saved_message["request"])

    snapshot = answer.model_snapshot

    metrics = snapshot.metrics

    split_name = "Test" if snapshot.split == "test" else "Valid"

    score = "평가 불가" if snapshot.score_100 is None else f"{snapshot.score_100:g}/100점"

    paragraphs = [
        f"데이터: {snapshot.dataset_name}. 모델: {snapshot.model_name}. "
        f"평가 범위: {split_name} 전체 {metrics.sample_count:,}행.",
        f"점수: {score}. 계산식: {snapshot.score_formula}. "
        "고장 확률 또는 현재 짧은 구간의 점수가 아니다.",
    ]

    if question.expertise == "pro-plus":
        paragraphs.extend(
            [
                f"실행 ID: {snapshot.run_id}. 학습 원본 SHA256: {snapshot.input_sha256}.",
                f"모델 파일 SHA256: {snapshot.artifact_sha256}.",
            ]
        )
        paragraphs.append(
            f"Recall {metrics.recall}, Precision {metrics.precision}, "
            f"F1 {metrics.f1}, Accuracy {metrics.accuracy}."
        )
    cost = answer.cost

    cost_lines = [
        "입력된 원화 금액에 따른 1회 점검·정비 시나리오이며 확정 견적이 아니다.",
    ]

    for label, value in (
        ("부품비", cost.parts_cost),
        ("점검비", cost.inspection_cost),
        ("작업비", cost.labor_cost),
        ("생산 중단 손실", cost.downtime_cost),
    ):
        cost_lines.append(f"{label}: {'미입력' if value is None else f'{value:,.0f}원'}")
    has_cost_values = question.cost_inputs is not None and any(
        getattr(question.cost_inputs, field) is not None
        for field in (
            "parts_cost",
            "inspection_cost",
            "labor_hours",
            "labor_hourly_rate",
            "downtime_hours",
            "downtime_loss_per_hour",
        )
    )

    cost_lines.append(
        f"입력 항목 소계: {cost.known_subtotal:,.0f}원"
        if has_cost_values
        else "계산할 입력값이 없어 소계는 미정이다."
    )
    cost_lines.append(f"합계: {'미정' if cost.total is None else f'{cost.total:,.0f}원'}")
    if cost.missing:
        cost_lines.append(f"추가 입력 필요: {', '.join(cost.missing)}")
    cost_lines.extend(cost.assumptions)
    generated_time = datetime.fromtimestamp(answer.created_at, UTC).astimezone(
        timezone(timedelta(hours=9))
    )

    sections = [
        ReportSection(
            heading="검토 목적",
            paragraphs=[
                "모델 결과, 입력한 현장 관찰, 문헌과 비용 가정을 검토하는 초안이다. "
                "최종 정비 지시나 고장 확정서는 아니다.",
                f"설명 저장 시각: {generated_time.strftime('%Y-%m-%d %H:%M:%S')} KST. "
                "모델이나 관찰이 바뀌어도 보고서는 당시 근거를 유지한다.",
                f"검토 질문: {question.question}",
            ],
        ),
        ReportSection(heading="모델 결과", paragraphs=paragraphs),
        ReportSection(
            heading="모델을 만든 과정",
            paragraphs=training_process_paragraphs(snapshot, question.expertise),
        ),
        ReportSection(
            heading="현장 관찰",
            paragraphs=[question.observation.strip() or "현장 관찰이 입력되지 않았다."],
        ),
        ReportSection(heading="근거를 연결한 설명", paragraphs=answer.answer.split("\n\n")),
        ReportSection(heading="다음 확인 사항", paragraphs=answer.suggested_checks),
        ReportSection(heading="비용 시나리오", paragraphs=cost_lines),
        ReportSection(heading="확인하지 못한 사항", paragraphs=answer.limitations),
    ]

    return ReportPreview(
        title=title.strip(),
        sections=sections,
        citations=answer.citations,
        model_snapshot=snapshot,
        cost=cost,
    )


def _write_docx(preview: ReportPreview, destination: Path) -> None:
    # 런타임에 문서를 만들 때만 라이브러리를 읽어 기본 API의 시작 메모리를 줄인다.
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Mm, Pt, RGBColor

    document = Document()

    section = document.sections[0]

    section.top_margin = Mm(20)
    section.bottom_margin = Mm(20)
    section.left_margin = Mm(22)
    section.right_margin = Mm(22)
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    for style_name in ("Normal", "Title", "Heading 1", "Heading 2"):
        style = document.styles[style_name]

        style.font.name = "Malgun Gothic"
        fonts = style._element.get_or_add_rPr().rFonts

        # 기본 Word 서식의 테마 글꼴이 명시한 한글 글꼴을 덮어쓰지 않게 한다.
        for attribute in ("asciiTheme", "eastAsiaTheme", "hAnsiTheme", "cstheme"):
            fonts.attrib.pop(qn(f"w:{attribute}"), None)
        fonts.set(qn("w:eastAsia"), "맑은 고딕")
        style.font.color.rgb = RGBColor(0, 0, 0)
        paragraph_properties = style._element.get_or_add_pPr()

        # python-docx 기본 Title에 남아 있는 파란 밑줄도 실제 Word에서 보인다.
        for border in list(paragraph_properties.findall(qn("w:pBdr"))):
            paragraph_properties.remove(border)
    document.styles["Normal"].font.size = Pt(10)
    document.styles["Normal"].paragraph_format.space_after = Pt(6)
    document.styles["Normal"].paragraph_format.line_spacing = 1.2
    document.styles["Title"].font.size = Pt(22)
    document.styles["Heading 1"].font.size = Pt(13)
    document.core_properties.title = preview.title
    document.core_properties.author = "팀 꼬부기"
    document.core_properties.last_modified_by = "팀 꼬부기"
    document.core_properties.comments = ""
    document.add_paragraph(_clean_text(preview.title), "Title")
    for item in preview.sections:
        document.add_heading(item.heading, level=1)
        for paragraph in item.paragraphs:
            document.add_paragraph(_clean_text(paragraph))
    document.add_heading("참고 문헌", level=1)
    for citation in preview.citations:
        document.add_paragraph(f"[{citation.id}] {citation.title}. {citation.pages}.")
        document.add_paragraph(citation.url)
    footer = section.footer.paragraphs[0]

    footer.alignment = 2
    field = OxmlElement("w:fldSimple")

    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)
    document.save(destination)


def _font_path(settings: Settings) -> Path:
    configured = getattr(settings, "report_font_path", None) or os.environ.get(
        "KKOBUGI_REPORT_FONT_PATH"
    )

    candidates = [Path(configured)] if configured else []

    candidates.extend(
        [
            Path("C:/Windows/Fonts/malgun.ttf"),
            Path("/usr/share/fonts/truetype/nanum/NanumGothic.ttf"),
            Path("/usr/share/fonts/truetype/nanum/NanumGothicCoding.ttf"),
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise ValueError("한글 PDF 글꼴이 설치되지 않았습니다.")


def _write_pdf(preview: ReportPreview, destination: Path, settings: Settings) -> None:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    font_path = _font_path(settings)

    font_name = "PumpKorean" + hashlib.sha256(str(font_path).encode()).hexdigest()[:8]

    if font_name not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(font_name, str(font_path)))
    body = ParagraphStyle(
        "PumpBody",
        fontName=font_name,
        fontSize=9.5,
        leading=15,
        spaceAfter=6,
        wordWrap="CJK",
        splitLongWords=True,
    )

    heading = ParagraphStyle(
        "PumpHeading",
        parent=body,
        fontSize=12,
        leading=18,
        spaceBefore=14,
        spaceAfter=7,
        keepWithNext=True,
        textColor=colors.black,
    )

    title_style = ParagraphStyle(
        "PumpTitle",
        parent=body,
        fontSize=21,
        leading=29,
        spaceAfter=16,
        alignment=TA_LEFT,
        textColor=colors.black,
    )

    story = [Paragraph(escape(_clean_text(preview.title)), title_style)]

    for section in preview.sections:
        story.append(Paragraph(escape(section.heading), heading))
        for text in section.paragraphs:
            story.append(Paragraph(escape(_clean_text(text)).replace("\n", "<br/>"), body))
    story.append(Paragraph("참고 문헌", heading))
    for citation in preview.citations:
        story.append(
            Paragraph(escape(f"[{citation.id}] {citation.title}. {citation.pages}."), body)
        )
        story.append(Paragraph(escape(citation.url), body))
        story.append(Spacer(1, 4))

    def page_number(canvas, document):
        canvas.saveState()
        canvas.setFont(font_name, 8)
        canvas.drawRightString(A4[0] - 22 * mm, 12 * mm, str(document.page))
        canvas.restoreState()

    pdf = SimpleDocTemplate(
        str(destination),
        pagesize=A4,
        leftMargin=22 * mm,
        rightMargin=22 * mm,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        title=preview.title,
        author="팀 꼬부기",
    )

    pdf.build(story, onFirstPage=page_number, onLaterPages=page_number)


class ReportManager:
    """같은 설명의 재요청은 기존 보고서를 돌려주고, 파일 작업은 한 개씩 처리한다."""

    def __init__(self, settings: Settings, *, memory_gate: MemoryWorkGate | None = None):
        self.settings = settings

        self.memory_gate = memory_gate if memory_gate is not None else MemoryWorkGate()

        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kkobugi-report")

        self._lock = threading.Lock()

        self._pending = threading.BoundedSemaphore(8)

        self._closed = False

    def recover_interrupted(self) -> None:
        folder = self.settings.dataset_storage_path.parent / "reports"

        for path in folder.glob("*/*.json"):
            content = load_json(path)

            if content.get("response", {}).get("status") in {"queued", "generating"}:
                content["response"]["status"] = "failed"
                content["response"]["updated_at"] = int(time.time())
                content["response"]["error_message"] = (
                    "서버가 다시 시작되어 보고서 생성을 완료하지 못했습니다. 다시 요청하세요."
                )
                save_json(path, content)

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
        self._executor.shutdown(wait=True, cancel_futures=False)

    def create(self, owner_id: int, body: ReportCreate) -> ReportResponse:
        message = get_message(self.settings, owner_id, body.message_id)

        # 한 설명당 보고서 하나를 만들기 때문에 네트워크 재시도가 중복 파일을 만들지 않는다.
        identifier = hashlib.sha256(body.message_id.encode()).hexdigest()[:32]

        path = private_path(self.settings, "reports", owner_id, identifier)

        with self._lock:
            if self._closed:
                raise assistant_error(
                    503, "REPORT_UNAVAILABLE", "보고서 생성을 시작하지 못했습니다."
                )
            if path.exists():
                existing = self.get(owner_id, identifier)

                if existing.status != "failed":
                    return existing
            if not self._pending.acquire(blocking=False):
                raise assistant_error(
                    429, "REPORT_QUEUE_FULL", "보고서 대기열이 찼습니다. 잠시 후 다시 요청하세요."
                )
            now = int(time.time())

            report = ReportResponse(
                id=identifier,
                message_id=body.message_id,
                title=body.title.strip(),
                status="queued",
                created_at=now,
                updated_at=now,
                preview=build_preview(body.title, message),
            )

            try:
                save_json(path, {"owner_id": owner_id, "response": report.model_dump(mode="json")})
                self._executor.submit(self._generate, owner_id, report)
            except Exception:
                self._pending.release()
                raise
            return report

    def _generate(self, owner_id: int, report: ReportResponse) -> None:
        path = private_path(self.settings, "reports", owner_id, report.id)

        try:
            # PDF 글꼴·Word 생성이 학습이나 큰 CSV 조회와 동시에 메모리를 점유하지 않는다.
            with self.memory_gate.sync_slot():
                report.status = "generating"
                report.updated_at = int(time.time())
                save_json(path, {"owner_id": owner_id, "response": report.model_dump(mode="json")})
                docx_path = path.with_suffix(".docx")

                pdf_path = path.with_suffix(".pdf")

                _write_docx(report.preview, docx_path.with_suffix(".tmp.docx"))
                _write_pdf(report.preview, pdf_path.with_suffix(".tmp.pdf"), self.settings)
                docx_path.with_suffix(".tmp.docx").replace(docx_path)
                pdf_path.with_suffix(".tmp.pdf").replace(pdf_path)
                report.status = "completed"
                report.error_message = None
        except MemoryWorkBusy:
            report.status = "failed"
            report.error_message = (
                "다른 분석 작업이 진행 중이에요. 잠시 후 보고서를 다시 요청하세요."
            )
        except Exception:
            # 원본 사용자 자료는 건드리지 않으며 내부 경로와 예외 원문을 노출하지 않는다.
            report.status = "failed"
            report.error_message = (
                "보고서 파일을 완성하지 못했습니다. "
                "한글 글꼴과 문서 생성 설정을 확인한 뒤 다시 요청하세요."
            )
        finally:
            report.updated_at = int(time.time())
            try:
                save_json(path, {"owner_id": owner_id, "response": report.model_dump(mode="json")})
            finally:
                self._pending.release()

    def get(self, owner_id: int, identifier: str) -> ReportResponse:
        content = load_json(private_path(self.settings, "reports", owner_id, identifier))

        if content.get("owner_id") != owner_id:
            raise assistant_error(404, "DOCUMENT_NOT_FOUND", "저장한 문서를 찾을 수 없습니다.")
        try:
            return ReportResponse.model_validate(content["response"])
        except (ValidationError, KeyError, TypeError):
            raise assistant_error(
                503, "DOCUMENT_STORAGE_UNAVAILABLE", "저장한 보고서를 읽지 못했습니다."
            ) from None

    def list(self, owner_id: int, limit: int, offset: int) -> ReportList:
        directory = self.settings.dataset_storage_path.parent / "reports" / str(owner_id)

        reports = [self.get(owner_id, item.stem) for item in directory.glob("*.json")]

        reports.sort(key=lambda item: (item.created_at, item.id), reverse=True)
        return ReportList(
            items=reports[offset : offset + limit], total=len(reports), limit=limit, offset=offset
        )

    def download(self, owner_id: int, identifier: str, extension: str) -> Path:
        report = self.get(owner_id, identifier)

        if report.status != "completed":
            raise assistant_error(409, "REPORT_NOT_READY", "보고서 작성이 끝난 뒤 다운로드하세요.")
        if extension not in {"docx", "pdf"}:
            raise assistant_error(404, "DOCUMENT_NOT_FOUND", "지원하는 파일 형식이 아닙니다.")
        path = private_path(self.settings, "reports", owner_id, identifier).with_suffix(
            f".{extension}"
        )

        if not path.is_file():
            raise assistant_error(503, "REPORT_FILE_UNAVAILABLE", "보고서 파일을 읽지 못했습니다.")
        return path
