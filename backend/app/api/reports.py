"""계정별 보고서 생성 상태, 미리보기 및 Word·PDF 다운로드."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse

from app.api.auth import get_current_user
from app.models import User
from app.schemas.assistant import ReportCreate, ReportList, ReportResponse

router = APIRouter(prefix="/api/v1/reports", tags=["점검 보고서"])

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("", response_model=ReportResponse, status_code=202)
def create_report(
    body: ReportCreate, request: Request, current_user: CurrentUser
) -> ReportResponse:
    return request.app.state.report_manager.create(current_user.id, body)


@router.get("", response_model=ReportList)
def list_reports(
    request: Request,
    current_user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ReportList:
    return request.app.state.report_manager.list(current_user.id, limit, offset)


@router.get("/{report_id}", response_model=ReportResponse)
def get_report(report_id: str, request: Request, current_user: CurrentUser) -> ReportResponse:
    return request.app.state.report_manager.get(current_user.id, report_id)


@router.get("/{report_id}/download.docx")
def download_docx(report_id: str, request: Request, current_user: CurrentUser) -> FileResponse:
    path = request.app.state.report_manager.download(current_user.id, report_id, "docx")

    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"pump-report-{report_id}.docx",
    )


@router.get("/{report_id}/download.pdf")
def download_pdf(report_id: str, request: Request, current_user: CurrentUser) -> FileResponse:
    path = request.app.state.report_manager.download(current_user.id, report_id, "pdf")

    return FileResponse(path, media_type="application/pdf", filename=f"pump-report-{report_id}.pdf")
