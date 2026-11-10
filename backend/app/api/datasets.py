"""로그인한 사용자의 CSV 등록·목록·검사 결과·원본 다운로드 API."""

from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
)
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.datasets import DatasetDetail, DatasetList
from app.schemas.errors import ErrorResponse
from app.services import datasets as dataset_service

# 프런트엔드는 모든 실패를 같은 error.code / error.message 형식으로 처리한다.
router = APIRouter(
    prefix="/api/v1/datasets",
    tags=["데이터셋"],
    responses={
        status_code: {"model": ErrorResponse} for status_code in (401, 403, 404, 413, 415, 422, 503)
    },
)

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


async def validate_upload_options(request: Request, _current_user: CurrentUser) -> None:
    # FastAPI는 빈 Form 값을 기본값으로 바꾸므로, 사용자가 비운 항목은 먼저 거부한다.
    form_data = await request.form()

    for field_name in ("timestamp_column", "label_column", "normal_label", "abnormal_label"):
        if field_name in form_data and form_data[field_name] == "":
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "INVALID_CSV",
                    "message": "컬럼·라벨 설정은 생략하거나 비어 있지 않은 값으로 지정하세요.",
                },
            )


@router.post(
    "",
    response_model=DatasetDetail,
    status_code=201,
    summary="전처리된 CSV 등록·검사",
    dependencies=[Depends(memory_guard), Depends(validate_upload_options)],
    responses={200: {"model": DatasetDetail, "description": "같은 파일·설정의 기존 자료 재사용"}},
)
def upload_dataset(
    request: Request,
    response: Response,
    database_session: DatabaseSession,
    current_user: CurrentUser,
    file: Annotated[UploadFile, File(description="UTF-8 CSV 원본 파일")],
    timestamp_column: Annotated[str, Form(min_length=1, max_length=128)] = "timestamp",
    label_column: Annotated[str, Form(min_length=1, max_length=128)] = "label",
    normal_label: Annotated[str, Form(min_length=1, max_length=128)] = "normal",
    abnormal_label: Annotated[str, Form(min_length=1, max_length=128)] = "abnormal",
) -> DatasetDetail:
    # 소유자는 폼의 입력값이 아닌 서버가 인증한 계정으로 정한다.
    dataset, is_new_dataset = dataset_service.upload_dataset(
        database_session,
        file,
        current_user,
        request.app.state.settings,
        timestamp_column=timestamp_column,
        label_column=label_column,
        normal_label=normal_label,
        abnormal_label=abnormal_label,
    )

    # 같은 파일·설정의 재등록은 새 버전을 만들지 않고 기존 자료를 돌려준다.
    response.status_code = 201 if is_new_dataset else 200

    return dataset_service.dataset_detail(dataset)


@router.get("", response_model=DatasetList, summary="내 CSV 목록")
def list_datasets(
    database_session: DatabaseSession,
    current_user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    deleted: Annotated[bool, Query(description="휴지통의 CSV만 조회")] = False,
) -> DatasetList:
    return dataset_service.list_datasets(
        database_session, current_user.id, limit, offset, deleted=deleted
    )


@router.delete("/{dataset_id}", status_code=204, summary="CSV를 복원 가능한 휴지통으로 이동")
def delete_dataset(
    dataset_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> Response:
    dataset_service.delete_dataset(database_session, dataset_id, current_user.id)
    return Response(status_code=204)


@router.post("/{dataset_id}/restore", response_model=DatasetDetail, summary="휴지통의 CSV 복원")
def restore_dataset(
    dataset_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> DatasetDetail:
    return dataset_service.restore_dataset(database_session, dataset_id, current_user.id)


@router.get("/{dataset_id}", response_model=DatasetDetail, summary="내 CSV 정보와 검사 결과")
def get_dataset(
    dataset_id: str, database_session: DatabaseSession, current_user: CurrentUser
) -> DatasetDetail:
    dataset = dataset_service.get_dataset(database_session, dataset_id, current_user.id)

    return dataset_service.dataset_detail(dataset)


@router.post(
    "/{dataset_id}/reinspect",
    response_model=DatasetDetail,
    summary="같은 CSV의 검사 결과 새로 확인",
    dependencies=[Depends(memory_guard)],
)
def reinspect_dataset(
    dataset_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> DatasetDetail:
    return dataset_service.reinspect_dataset(
        database_session, dataset_id, current_user.id, request.app.state.settings
    )


@router.get(
    "/{dataset_id}/file",
    summary="등록한 원본 CSV 다운로드",
    response_class=FileResponse,
    responses={
        200: {
            "description": "등록한 원본 CSV 바이트",
            "content": {"text/csv": {"schema": {"type": "string", "format": "binary"}}},
        }
    },
)
def download_dataset(
    dataset_id: str,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> FileResponse:
    dataset = dataset_service.get_dataset(database_session, dataset_id, current_user.id)

    file_path = dataset_service.dataset_file_path(dataset, request.app.state.settings)

    # 파일을 바꾸거나 공개 URL에 올리지 않고 인증된 요청에만 원본을 전달한다.
    return FileResponse(
        file_path,
        media_type="text/csv",
        filename=dataset.filename,
        headers={"Cache-Control": "no-store"},
    )
