"""CSV 원본 파일과 검사 결과를 계정별로 저장하고 조회한다."""

import hashlib
import re
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Dataset, User
from app.schemas.datasets import CsvInspection, DatasetDetail, DatasetList, DatasetSummary
from app.services.csv_inspection import inspect_csv

_UPLOAD_CHUNK_BYTES = 1024 * 1024

_DATASET_ID_PATTERN = re.compile(r"[a-f0-9]{32}")


def _storage_unavailable() -> HTTPException:
    # 내부 경로나 DB 쿼리 인자는 사용자에게 공개하지 않는다.
    return HTTPException(
        status_code=503,
        detail={"code": "DATASET_UNAVAILABLE", "message": "CSV 처리를 완료하지 못했습니다."},
    )


def _dataset_not_found() -> HTTPException:
    # 다른 계정의 자료인지, 존재하지 않는 ID인지 구분해서 알려주지 않는다.
    return HTTPException(
        status_code=404,
        detail={"code": "DATASET_NOT_FOUND", "message": "등록한 CSV를 찾을 수 없습니다."},
    )


def _display_filename(upload_file: UploadFile) -> str:
    # 브라우저가 Windows 경로를 보내도 마지막 파일 이름만 표시한다.
    filename = (upload_file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]

    if not filename or len(filename) > 255 or any(ord(character) < 32 for character in filename):
        raise HTTPException(
            status_code=422,
            detail={"code": "INVALID_FILENAME", "message": "CSV 파일 이름을 확인해 주세요."},
        )
    if not filename.lower().endswith(".csv"):
        raise HTTPException(
            status_code=415,
            detail={"code": "UNSUPPORTED_FILE_TYPE", "message": "CSV 파일을 선택해 주세요."},
        )
    return filename


def _stored_file_path(dataset_id: str, settings: Settings) -> Path:
    if not _DATASET_ID_PATTERN.fullmatch(dataset_id):
        raise _dataset_not_found()

    storage_directory = settings.dataset_storage_path.resolve()

    file_path = (storage_directory / f"{dataset_id}.csv").resolve()

    # 저장 폴더 밖의 경로나 다른 위치를 가리키는 링크는 사용하지 않는다.
    if file_path.parent != storage_directory:
        raise _storage_unavailable()
    return file_path


def _find_duplicate(
    database_session: Session,
    owner_id: int,
    file_hash: str,
    timestamp_column: str,
    label_column: str,
    normal_label: str,
    abnormal_label: str,
) -> Dataset | None:
    return database_session.scalar(
        select(Dataset).where(
            Dataset.owner_id == owner_id,
            Dataset.sha256 == file_hash,
            Dataset.timestamp_column == timestamp_column,
            Dataset.label_column == label_column,
            Dataset.normal_label == normal_label,
            Dataset.abnormal_label == abnormal_label,
        )
    )


def upload_dataset(
    database_session: Session,
    upload_file: UploadFile,
    current_user: User,
    settings: Settings,
    *,
    timestamp_column: str = "timestamp",
    label_column: str = "label",
    normal_label: str = "normal",
    abnormal_label: str = "abnormal",
) -> tuple[Dataset, bool]:
    filename = _display_filename(upload_file)

    temporary_path: Path | None = None

    published_path: Path | None = None

    try:
        storage_directory = settings.dataset_storage_path.resolve()

        storage_directory.mkdir(parents=True, exist_ok=True)

        file_hasher = hashlib.sha256()

        size_bytes = 0

        # 원본을 한꺼번에 메모리에 올리지 않고 작은 청크로 복사한다.
        with tempfile.NamedTemporaryFile(
            dir=storage_directory, prefix=".upload-", suffix=".tmp", delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)

            upload_file.file.seek(0)
            while True:
                chunk = upload_file.file.read(_UPLOAD_CHUNK_BYTES)

                if not chunk:
                    break
                size_bytes += len(chunk)

                if size_bytes > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "code": "DATASET_TOO_LARGE",
                            "message": "CSV 파일이 업로드 가능한 크기를 초과했습니다.",
                        },
                    )
                temporary_file.write(chunk)
                file_hasher.update(chunk)

        file_hash = file_hasher.hexdigest()

        existing_dataset = _find_duplicate(
            database_session,
            current_user.id,
            file_hash,
            timestamp_column,
            label_column,
            normal_label,
            abnormal_label,
        )

        if existing_dataset is not None:
            dataset_file_path(existing_dataset, settings)
            return existing_dataset, False

        # 검사는 읽기만 수행한다. 결측·정렬·라벨 값을 여기서 고치지 않는다.
        inspection = inspect_csv(
            temporary_path,
            timestamp_column=timestamp_column,
            label_column=label_column,
            normal_label=normal_label,
            abnormal_label=abnormal_label,
            max_rows=settings.max_dataset_rows,
            max_columns=settings.max_dataset_columns,
        )

        dataset_id = uuid4().hex

        file_path = _stored_file_path(dataset_id, settings)

        # 서버가 만든 ID여도 기존 파일이 있으면 덮어쓰지 않는다.
        if file_path.exists():
            raise _storage_unavailable()
        temporary_path.replace(file_path)

        published_path = file_path

        dataset = Dataset(
            id=dataset_id,
            owner_id=current_user.id,
            filename=filename,
            size_bytes=size_bytes,
            sha256=file_hash,
            timestamp_column=timestamp_column,
            label_column=label_column,
            normal_label=normal_label,
            abnormal_label=abnormal_label,
            inspection=inspection.model_dump(),
        )

        database_session.add(dataset)
        try:
            database_session.commit()
        except IntegrityError:
            database_session.rollback()
            # 동시에 같은 파일을 등록한 요청 중 먼저 저장된 자료를 사용한다.
            existing_dataset = _find_duplicate(
                database_session,
                current_user.id,
                file_hash,
                timestamp_column,
                label_column,
                normal_label,
                abnormal_label,
            )

            if existing_dataset is None:
                raise _storage_unavailable() from None
            dataset_file_path(existing_dataset, settings)
            return existing_dataset, False

        # DB 저장이 끝난 파일은 아래 정리 과정에서 지우지 않는다.
        published_path = None

        return dataset, True
    except (OSError, SQLAlchemyError):
        database_session.rollback()
        raise _storage_unavailable() from None
    finally:
        # 요청이 실패하거나 중복이었다면 이 요청이 만든 파일만 정리한다.
        try:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            if published_path is not None:
                published_path.unlink(missing_ok=True)
        except OSError:
            raise _storage_unavailable() from None


def get_dataset(database_session: Session, dataset_id: str, owner_id: int) -> Dataset:
    try:
        dataset = database_session.scalar(
            select(Dataset).where(Dataset.id == dataset_id, Dataset.owner_id == owner_id)
        )

    except SQLAlchemyError:
        raise _storage_unavailable() from None
    if dataset is None:
        raise _dataset_not_found()
    return dataset


def _dataset_summary(dataset: Dataset, inspection: CsvInspection) -> DatasetSummary:
    return DatasetSummary(
        id=dataset.id,
        filename=dataset.filename,
        size_bytes=dataset.size_bytes,
        sha256=dataset.sha256,
        status="valid" if inspection.is_valid else "needs_review",
        created_at=dataset.created_at,
        owner_id=dataset.owner_id,
        row_count=inspection.row_count,
        column_count=inspection.column_count,
        timestamp_column=dataset.timestamp_column,
        label_column=dataset.label_column,
        normal_label=dataset.normal_label,
        abnormal_label=dataset.abnormal_label,
        channels=inspection.channels,
    )


def dataset_detail(dataset: Dataset) -> DatasetDetail:
    try:
        inspection = CsvInspection.model_validate(dataset.inspection)

    except ValidationError:
        raise _storage_unavailable() from None
    return DatasetDetail(dataset=_dataset_summary(dataset, inspection), inspection=inspection)


def list_datasets(database_session: Session, owner_id: int, limit: int, offset: int) -> DatasetList:
    try:
        total = database_session.scalar(
            select(func.count()).select_from(Dataset).where(Dataset.owner_id == owner_id)
        )

        datasets = database_session.scalars(
            select(Dataset)
            .where(Dataset.owner_id == owner_id)
            .order_by(Dataset.created_at.desc(), Dataset.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()

    except SQLAlchemyError:
        raise _storage_unavailable() from None
    return DatasetList(
        items=[dataset_detail(dataset).dataset for dataset in datasets],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


def dataset_file_path(dataset: Dataset, settings: Settings) -> Path:
    try:
        file_path = _stored_file_path(dataset.id, settings)

        if not file_path.is_file():
            raise _storage_unavailable()
        return file_path
    except OSError:
        raise _storage_unavailable() from None
