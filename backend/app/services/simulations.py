"""원본을 그대로 보관하고 저장한 모델로 현재 요청 배치만 예측한다."""

import csv
import hashlib
import json
import math
import re
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import numpy as np
from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.config import Settings
from app.schemas.simulations import (
    SimulationBatch,
    SimulationList,
    SimulationManifest,
    SimulationPoint,
)
from app.services import replays
from app.services.csv_format import detect_csv_delimiter
from app.services.series import _predict

_ID_PATTERN = re.compile(r"[a-f0-9]{32}")

_INDEX_STEP = 1000


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _directory(settings: Settings, owner_id: int) -> Path:
    storage = settings.dataset_storage_path.resolve()

    directory = (storage / "simulations" / str(owner_id)).resolve()

    if directory.parent.parent != storage or directory.name != str(owner_id):
        raise _error(503, "SIMULATION_UNAVAILABLE", "시뮬레이션 저장 위치를 확인하세요.")
    return directory


def _path(settings: Settings, owner_id: int, simulation_id: str, suffix: str) -> Path:
    if not _ID_PATTERN.fullmatch(simulation_id):
        raise _error(404, "SIMULATION_NOT_FOUND", "시뮬레이션 자료를 찾을 수 없습니다.")
    directory = _directory(settings, owner_id)

    path = (directory / f"{simulation_id}.{suffix}").resolve()

    if path.parent != directory:
        raise _error(503, "SIMULATION_UNAVAILABLE", "시뮬레이션 저장 위치를 확인하세요.")
    return path


def get_manifest(settings: Settings, simulation_id: str, owner_id: int) -> dict:
    try:
        manifest = json.loads(_path(settings, owner_id, simulation_id, "json").read_text("utf-8"))

        SimulationManifest.model_validate(manifest)
        if manifest.get("owner_id") != owner_id:
            raise _error(404, "SIMULATION_NOT_FOUND", "시뮬레이션 자료를 찾을 수 없습니다.")
        return manifest
    except FileNotFoundError:
        raise _error(404, "SIMULATION_NOT_FOUND", "시뮬레이션 자료를 찾을 수 없습니다.") from None
    except (OSError, ValueError, TypeError):
        raise _error(503, "SIMULATION_UNAVAILABLE", "시뮬레이션 정보를 읽지 못했습니다.") from None


def list_simulations(settings: Settings, owner_id: int) -> SimulationList:
    items = []

    for path in _directory(settings, owner_id).glob("*.json"):
        try:
            manifest = get_manifest(settings, path.stem, owner_id)

            items.append(SimulationManifest.model_validate(manifest))
        except HTTPException:
            continue
    items.sort(key=lambda item: (item.created_at, item.id), reverse=True)
    return SimulationList(items=items[:100], total=len(items))


def _inspect_csv(
    path: Path, timestamp_column: str, features: list[str], settings: Settings
) -> dict:
    offsets = []

    row_count = 0

    first_time = None

    previous_time = None

    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        # readline iterator는 여러 줄 CSV 필드도 처리하며 tell/seek 인덱스를 유지한다.
        reader = csv.reader(
            iter(stream.readline, ""), delimiter=detect_csv_delimiter(stream), strict=True
        )

        columns = next(reader, [])

        if (
            not columns
            or len(columns) != len(set(columns))
            or len(columns) > settings.max_dataset_columns
            or timestamp_column not in columns
            or not set(features).issubset(columns)
        ):
            raise _error(
                422,
                "SIMULATION_COLUMNS_MISMATCH",
                "시각열과 학습한 채널을 모두 포함한 CSV가 필요합니다.",
            )
        timestamp_index = columns.index(timestamp_column)

        feature_indices = [columns.index(column) for column in features]

        while True:
            offset = stream.tell()

            values = next(reader, None)

            if values is None:
                break
            if len(values) != len(columns):
                raise _error(
                    422, "INVALID_SIMULATION_CSV", "CSV의 각 행에 같은 개수의 값이 필요합니다."
                )
            timestamp = datetime.fromisoformat(values[timestamp_index].strip())

            if previous_time is not None and (
                (timestamp.tzinfo is None) != (previous_time.tzinfo is None)
                or timestamp <= previous_time
            ):
                raise _error(
                    422, "SIMULATION_TIME_ORDER", "중복 없이 시간순으로 정리한 CSV를 업로드하세요."
                )
            # 라벨과 추가 메타데이터는 입력에 넣지 않는다. 학습 당시 채널만 검사한다.
            if not all(math.isfinite(float(values[index])) for index in feature_indices):
                raise _error(
                    422,
                    "INVALID_SIMULATION_VALUES",
                    "학습 채널에 결측·무한대 없이 숫자가 필요합니다.",
                )
            if row_count % _INDEX_STEP == 0:
                offsets.append(offset)
            row_count += 1
            first_time = first_time or timestamp
            previous_time = timestamp
            if row_count > settings.max_dataset_rows:
                raise _error(413, "SIMULATION_TOO_LARGE", "시뮬레이션 행 수 한도를 초과했습니다.")
    if row_count == 0:
        raise _error(422, "EMPTY_SIMULATION", "시뮬레이션할 데이터 행이 필요합니다.")
    return {
        "columns": columns,
        "offsets": offsets,
        "total_rows": row_count,
        "start_time": first_time.isoformat(),
        "end_time": previous_time.isoformat(),
    }


def upload_simulation(
    database_session: Session,
    settings: Settings,
    owner_id: int,
    upload: UploadFile,
    run_id: str,
    model_key: str,
    timestamp_column: str = "timestamp",
) -> SimulationManifest:
    _, _, estimator, configuration = replays._load_model(
        database_session, settings, owner_id, run_id, model_key, use_batch_cache=True
    )

    del estimator
    if not upload.filename or Path(upload.filename).suffix.lower() != ".csv":
        raise _error(415, "CSV_REQUIRED", "UTF-8 CSV 파일을 선택하세요.")
    if timestamp_column in configuration.feature_columns:
        raise _error(422, "SIMULATION_COLUMNS_MISMATCH", "시각열과 모델 채널은 달라야 합니다.")
    directory = _directory(settings, owner_id)

    directory.mkdir(parents=True, exist_ok=True)
    temporary_id = uuid4().hex

    temporary_csv = directory / f".{temporary_id}.csv.tmp"

    temporary_manifest = directory / f".{temporary_id}.json.tmp"

    digest = hashlib.sha256()

    size_bytes = 0

    try:
        upload.file.seek(0)
        with temporary_csv.open("xb") as destination:
            while chunk := upload.file.read(1024 * 1024):
                size_bytes += len(chunk)
                if size_bytes > settings.max_upload_bytes:
                    raise _error(
                        413, "SIMULATION_TOO_LARGE", "업로드 파일 크기 한도를 초과했습니다."
                    )
                digest.update(chunk)
                destination.write(chunk)
        source_sha256 = digest.hexdigest()

        identity = f"{owner_id}:{run_id}:{model_key}:{timestamp_column}:{source_sha256}"

        simulation_id = hashlib.sha256(identity.encode()).hexdigest()[:32]

        manifest_path = _path(settings, owner_id, simulation_id, "json")

        if manifest_path.exists():
            return SimulationManifest.model_validate(
                get_manifest(settings, simulation_id, owner_id)
            )
        inspection = _inspect_csv(
            temporary_csv, timestamp_column, configuration.feature_columns, settings
        )

        manifest = {
            **inspection,
            "id": simulation_id,
            "owner_id": owner_id,
            "run_id": run_id,
            "model_key": model_key,
            "filename": upload.filename.replace("\\", "/").split("/")[-1][:255],
            "timestamp_column": timestamp_column,
            "feature_columns": configuration.feature_columns,
            "source_sha256": source_sha256,
            "size_bytes": size_bytes,
            "synthetic": True,
            "provenance": (
                "업로드한 시뮬레이션 CSV입니다. 새 현장 측정값이나 독립 성능 평가 자료가 아닙니다. "
                "라벨은 모델 입력과 예측에 사용하지 않습니다."
            ),
            "created_at": int(time.time()),
        }

        with temporary_manifest.open("x", encoding="utf-8") as stream:
            json.dump(manifest, stream, ensure_ascii=False, allow_nan=False)
        temporary_csv.replace(_path(settings, owner_id, simulation_id, "csv"))
        temporary_manifest.replace(manifest_path)
        return SimulationManifest.model_validate(manifest)
    except (UnicodeError, csv.Error, ValueError, OverflowError):
        raise _error(
            422, "INVALID_SIMULATION_CSV", "UTF-8 CSV의 시각과 학습 채널 숫자를 확인하세요."
        ) from None
    except OSError:
        raise _error(
            503, "SIMULATION_UNAVAILABLE", "시뮬레이션 파일을 저장하지 못했습니다."
        ) from None
    finally:
        temporary_csv.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)


def simulation_batch(
    database_session: Session,
    settings: Settings,
    owner_id: int,
    simulation_id: str,
    cursor: int,
    limit: int,
    channel: str,
) -> SimulationBatch:
    manifest = get_manifest(settings, simulation_id, owner_id)

    if channel not in manifest["feature_columns"]:
        raise _error(422, "INVALID_CHANNEL", "학습에 사용한 채널을 선택하세요.")
    if cursor > manifest["total_rows"]:
        raise _error(422, "INVALID_CURSOR", "시뮬레이션 범위 안에서 시작하세요.")
    _, _, estimator, configuration = replays._load_model(
        database_session,
        settings,
        owner_id,
        manifest["run_id"],
        manifest["model_key"],
        use_batch_cache=True,
    )

    if configuration.feature_columns != manifest["feature_columns"]:
        raise _error(
            409, "SIMULATION_MODEL_CHANGED", "학습 당시 채널과 시뮬레이션 설정이 다릅니다."
        )
    source_path = _path(settings, owner_id, simulation_id, "csv")

    rows = []

    try:
        replays._cached_generated_sha256(
            source_path, replays._file_stamp(source_path), manifest["source_sha256"]
        )
        if cursor < manifest["total_rows"]:
            block = cursor // _INDEX_STEP

            with source_path.open("r", encoding="utf-8-sig", newline="") as stream:
                delimiter = detect_csv_delimiter(stream)

                stream.seek(manifest["offsets"][block])
                reader = csv.DictReader(stream, fieldnames=manifest["columns"], delimiter=delimiter)

                for row_index, row in enumerate(reader, start=block * _INDEX_STEP):
                    if row_index < cursor:
                        continue
                    rows.append(row)
                    if len(rows) >= limit:
                        break
    except HTTPException as error:
        if error.status_code == 409:
            raise _error(
                409, "SIMULATION_CHANGED", "업로드 당시와 시뮬레이션 CSV가 다릅니다."
            ) from None
        raise
    except (OSError, ValueError, KeyError, IndexError, csv.Error):
        raise _error(503, "SIMULATION_UNAVAILABLE", "시뮬레이션 CSV를 읽지 못했습니다.") from None
    features = np.array(
        [[float(row[column]) for column in configuration.feature_columns] for row in rows],
        dtype=float,
    )

    predicted_codes, scores = _predict(estimator, features)

    points = [
        SimulationPoint(
            row_index=cursor + index,
            timestamp=datetime.fromisoformat(row[manifest["timestamp_column"]]).isoformat(),
            value=float(row[channel]),
            predicted_code=int(predicted_codes[index]),
            score=float(scores[index]),
        )
        for index, row in enumerate(rows)
    ]

    next_cursor = cursor + len(points)

    return SimulationBatch(
        simulation_id=simulation_id,
        channel=channel,
        points=points,
        next_cursor=next_cursor,
        total_rows=manifest["total_rows"],
        done=next_cursor >= manifest["total_rows"],
        score_type="reconstruction_error"
        if manifest["model_key"] == "autoencoder"
        else "probability",
        threshold=float(estimator.threshold_) if manifest["model_key"] == "autoencoder" else None,
    )
