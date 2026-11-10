"""전체 원본 또는 Test를 재표본화하고, 요청한 배치만 저장 모델로 예측한다."""

import csv
import hashlib
import json
import re
import time
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

import numpy as np
from fastapi import HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import ModelRun, User
from app.schemas.replays import ReplayBatch, ReplayCreate, ReplayList, ReplayManifest, ReplayPoint
from app.schemas.runs import RunCreate, SplitInfo
from app.services import datasets as dataset_service
from app.services import modeling
from app.services import runs as run_service
from app.services.csv_format import detect_csv_delimiter
from app.services.series import _predict

_ID_PATTERN = re.compile(r"[a-f0-9]{32}")

_INDEX_STEP = 1000

FileStamp = tuple[int, int, int, int, int]


def _file_stamp(path: Path) -> FileStamp:
    """비공개 불변 파일의 내용 검증 결과를 재사용할 수 있는지 확인한다."""
    attributes = path.stat()

    return (
        attributes.st_mtime_ns,
        attributes.st_ctime_ns,
        attributes.st_size,
        attributes.st_ino,
        attributes.st_dev,
    )


@lru_cache(maxsize=2)
def _cached_trained_model(
    owner_id: int,
    run_id: str,
    model_key: str,
    source_path: Path,
    artifact_directory: Path,
    normal_label: str,
    abnormal_label: str,
    expected_sha256: str,
    expected_artifact_sha256: str,
    timestamp_column: str,
    label_column: str,
    configuration_json: str,
    source_stamp: FileStamp,
    artifact_stamp: FileStamp,
    metadata_stamp: FileStamp,
) -> object:
    # 계정·실행·설정·예상 해시·세 파일의 stat가 모두 같은 경우만 최대 두 모델을 보관한다.
    # 소유권·선택 모델·Test 완료 상태는 이 함수 밖에서 매 요청 DB로 다시 확인한다.
    configuration = RunCreate.model_validate_json(configuration_json)

    estimator = modeling.load_trained_model(
        source_path,
        configuration,
        normal_label=normal_label,
        abnormal_label=abnormal_label,
        expected_sha256=expected_sha256,
        artifact_directory=artifact_directory,
        model_key=model_key,
        expected_artifact_sha256=expected_artifact_sha256,
        timestamp_column=timestamp_column,
        label_column=label_column,
    )

    if (
        _file_stamp(source_path) != source_stamp
        or _file_stamp(artifact_directory / f"{model_key}.joblib") != artifact_stamp
        or _file_stamp(artifact_directory / "metadata.json") != metadata_stamp
    ):
        # 검증 도중 바뀐 파일이나 실패한 검증은 lru_cache에 들어가지 않는다.
        raise ValueError("모델 확인 도중 파일이 변경됐습니다.")
    return estimator


@lru_cache(maxsize=2)
def _cached_generated_sha256(file_path: Path, stamp: FileStamp, expected_sha256: str) -> str:
    actual_sha256 = modeling._file_sha256(file_path)

    if actual_sha256 != expected_sha256 or _file_stamp(file_path) != stamp:
        # 누락·변경을 검증하지 못한 결과는 저장하지 않는다.
        raise _error(409, "REPLAY_CHANGED", "생성 당시와 재생 CSV 내용이 다릅니다.")
    return actual_sha256


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _manifest_path(settings: Settings, replay_id: str) -> Path:
    if not _ID_PATTERN.fullmatch(replay_id):
        raise _error(404, "REPLAY_NOT_FOUND", "재생 데이터를 찾을 수 없습니다.")
    directory = (settings.dataset_storage_path.resolve() / "replays").resolve()

    path = (directory / f"{replay_id}.json").resolve()

    if path.parent != directory or directory.parent != settings.dataset_storage_path.resolve():
        raise _error(503, "REPLAY_UNAVAILABLE", "재생 저장 위치를 확인하지 못했습니다.")
    return path


def get_manifest(settings: Settings, replay_id: str, owner_id: int) -> dict:
    path = _manifest_path(settings, replay_id)

    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))

    except FileNotFoundError:
        raise _error(404, "REPLAY_NOT_FOUND", "재생 데이터를 찾을 수 없습니다.") from None
    except (OSError, ValueError):
        raise _error(503, "REPLAY_UNAVAILABLE", "재생 정보를 읽지 못했습니다.") from None
    if manifest.get("owner_id") != owner_id:
        raise _error(404, "REPLAY_NOT_FOUND", "재생 데이터를 찾을 수 없습니다.")
    return manifest


def list_replays(settings: Settings, owner_id: int) -> ReplayList:
    directory = _manifest_path(settings, "0" * 32).parent

    items = []

    for path in directory.glob("*.json"):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))

            if manifest.get("owner_id") == owner_id:
                items.append(ReplayManifest.model_validate(manifest))
        except (OSError, ValueError):
            continue
    items.sort(key=lambda item: (item.created_at, item.id), reverse=True)
    return ReplayList(items=items[:100], total=len(items))


def _load_model(
    database_session: Session,
    settings: Settings,
    owner_id: int,
    run_id: str,
    model_key: str,
    *,
    use_batch_cache: bool = False,
) -> tuple[ModelRun, object, object, RunCreate]:
    model_run = run_service.get_run(database_session, run_id, owner_id)

    if model_run.status != "completed" or model_run.evaluation_status != "completed":
        raise _error(409, "TEST_NOT_EVALUATED", "학습과 최종 확인을 완료한 뒤 재생하세요.")
    if model_run.selected_model != model_key:
        raise _error(409, "MODEL_NOT_SELECTED", "최종 확인한 모델과 같은 모델을 선택하세요.")
    dataset = dataset_service.get_dataset(database_session, model_run.dataset_id, owner_id)

    configuration = RunCreate.model_validate(model_run.configuration)

    model_report = next(
        (
            item
            for item in (model_run.training_report or {}).get("models", [])
            if item["model_key"] == model_key
        ),
        None,
    )

    if model_report is None:
        raise _error(409, "MODEL_NOT_TRAINED", "저장된 학습 모델을 확인하세요.")
    try:
        source_path = dataset_service.dataset_file_path(dataset, settings)

        artifact_directory = settings.model_storage_path.resolve() / model_run.id

        if use_batch_cache:
            estimator = _cached_trained_model(
                owner_id,
                model_run.id,
                model_key,
                source_path,
                artifact_directory,
                dataset.normal_label,
                dataset.abnormal_label,
                model_run.input_sha256,
                model_report["artifact_sha256"],
                dataset.timestamp_column,
                dataset.label_column,
                json.dumps(configuration.model_dump(mode="json"), sort_keys=True),
                _file_stamp(source_path),
                _file_stamp(artifact_directory / f"{model_key}.joblib"),
                _file_stamp(artifact_directory / "metadata.json"),
            )

        else:
            estimator = modeling.load_trained_model(
                source_path,
                configuration,
                normal_label=dataset.normal_label,
                abnormal_label=dataset.abnormal_label,
                expected_sha256=model_run.input_sha256,
                artifact_directory=artifact_directory,
                model_key=model_key,
                expected_artifact_sha256=model_report["artifact_sha256"],
                timestamp_column=dataset.timestamp_column,
                label_column=dataset.label_column,
            )

    except (OSError, ValueError, KeyError, TypeError):
        raise _error(
            503, "REPLAY_MODEL_UNAVAILABLE", "학습한 모델과 원본을 확인하지 못했습니다."
        ) from None
    return model_run, dataset, estimator, configuration


def create_replay(
    database_session: Session, settings: Settings, current_user: User, body: ReplayCreate
) -> ReplayManifest:
    model_run, dataset, estimator, configuration = _load_model(
        database_session, settings, current_user.id, body.run_id, body.model_key
    )

    # 생성 단계에서는 추론 배열을 만들지 않는다. 모델 검증이 끝나면 즉시 해제한다.
    del estimator
    test_split = SplitInfo.model_validate(model_run.training_report["split"]).test

    source_start_row = test_split.start_row if body.source_split == "test" else 0

    source_end_row = (
        test_split.end_row
        if body.source_split == "test"
        else dataset_service.dataset_detail(dataset).inspection.row_count
    )

    source_count = source_end_row - source_start_row

    start = body.start_time or datetime.now(ZoneInfo("Asia/Seoul")).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    identity = (
        f"{current_user.id}:{body.run_id}:{body.model_key}:{body.row_count}:"
        f"{body.source_split}:{start.isoformat()}"
    )

    replay_id = hashlib.sha256(identity.encode()).hexdigest()[:32]

    manifest_path = _manifest_path(settings, replay_id)

    if manifest_path.exists():
        return ReplayManifest.model_validate(get_manifest(settings, replay_id, current_user.id))
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_id = uuid4().hex

    # 이전 프로세스가 남긴 고정 이름의 tmp와 겹치지 않고, 이 요청의 파일만 정리한다.
    temporary_path = manifest_path.with_name(f".{replay_id}.{temporary_id}.csv.tmp")

    staged_manifest = manifest_path.with_name(f".{replay_id}.{temporary_id}.json.tmp")

    offsets = []

    source_timestamps = []

    emitted_rows = 0

    try:
        with (
            dataset_service.dataset_file_path(dataset, settings).open(
                "r", encoding="utf-8-sig", newline=""
            ) as source_file,
            temporary_path.open("x", encoding="utf-8", newline="") as replay_file,
        ):
            writer = csv.writer(replay_file)

            writer.writerow(
                [dataset.timestamp_column, *configuration.feature_columns, dataset.label_column]
            )
            for source_row, row in enumerate(
                csv.DictReader(source_file, delimiter=detect_csv_delimiter(source_file))
            ):
                if source_row < source_start_row:
                    continue
                if source_row >= source_end_row:
                    break
                source_timestamps.append(row[dataset.timestamp_column])
                relative_row = source_row - source_start_row

                # nearest/hold 방식으로 시간 순서를 늘린다. 센서값·라벨을 보간하지 않는다.
                end = ((relative_row + 1) * body.row_count + source_count - 1) // source_count

                while emitted_rows < end:
                    if emitted_rows % _INDEX_STEP == 0:
                        offsets.append(replay_file.tell())
                    timestamp = (start + timedelta(seconds=emitted_rows)).isoformat(
                        timespec="seconds"
                    )

                    writer.writerow(
                        [
                            timestamp,
                            *[row[column] for column in configuration.feature_columns],
                            row[dataset.label_column],
                        ]
                    )
                    emitted_rows += 1

                    if replay_file.tell() > settings.max_upload_bytes:
                        raise _error(
                            413,
                            "REPLAY_TOO_LARGE",
                            "선택한 채널로 생성한 CSV가 저장 한도를 초과했습니다.",
                        )
        if emitted_rows != body.row_count or len(source_timestamps) != source_count:
            raise _error(409, "SOURCE_CHANGED", "원본의 행 개수와 저장된 분할을 다시 확인하세요.")
        with temporary_path.open("rb") as replay_file:
            generated_dataset, _ = dataset_service.upload_dataset(
                database_session,
                UploadFile(file=replay_file, filename=f"synthetic-replay-{replay_id[:8]}.csv"),
                current_user,
                settings,
                timestamp_column=dataset.timestamp_column,
                label_column=dataset.label_column,
                normal_label=dataset.normal_label,
                abnormal_label=dataset.abnormal_label,
            )

        manifest = {
            "id": replay_id,
            "owner_id": current_user.id,
            "run_id": body.run_id,
            "model_key": body.model_key,
            "dataset_id": generated_dataset.id,
            "source_dataset_id": dataset.id,
            "source_sha256": dataset.sha256,
            "source_start_row": source_start_row,
            "source_end_row": source_end_row,
            "source_split": body.source_split,
            "total_rows": body.row_count,
            "feature_columns": configuration.feature_columns,
            "timestamp_column": dataset.timestamp_column,
            "label_column": dataset.label_column,
            "start_time": start.isoformat(timespec="seconds"),
            "end_time": (start + timedelta(seconds=body.row_count - 1)).isoformat(
                timespec="seconds"
            ),
            "synthetic": True,
            "provenance": (
                (
                    "전체 원본(학습 구간 포함)"
                    if body.source_split == "full"
                    else "최종 확인(Test) 구간"
                )
                + "을 시간 순서대로 재표본화한 합성 데이터입니다. "
                "새 측정값·독립 평가·고장 원인 정답이 아닙니다."
            ),
            "created_at": int(time.time()),
            "offsets": offsets,
            "source_timestamps": source_timestamps,
            "generated_sha256": generated_dataset.sha256,
        }

        with staged_manifest.open("x", encoding="utf-8") as manifest_file:
            json.dump(manifest, manifest_file, ensure_ascii=False, allow_nan=False)
        staged_manifest.replace(manifest_path)
        return ReplayManifest.model_validate(manifest)
    except (OSError, ValueError, KeyError, OverflowError):
        raise _error(503, "REPLAY_UNAVAILABLE", "재생 데이터를 만들지 못했습니다.") from None
    finally:
        # 이 요청이 만든 임시 파일만 정리한다. 원본·기존 데이터는 건드리지 않는다.
        temporary_path.unlink(missing_ok=True)
        staged_manifest.unlink(missing_ok=True)


def replay_batch(
    database_session: Session,
    settings: Settings,
    owner_id: int,
    replay_id: str,
    cursor: int,
    limit: int,
    channel: str,
) -> ReplayBatch:
    manifest = get_manifest(settings, replay_id, owner_id)

    if channel not in manifest["feature_columns"]:
        raise _error(422, "INVALID_CHANNEL", "학습에 사용한 채널을 선택하세요.")
    if cursor > manifest["total_rows"]:
        raise _error(422, "INVALID_CURSOR", "재생 데이터 범위 안에서 시작하세요.")
    model_run, source_dataset, estimator, configuration = _load_model(
        database_session,
        settings,
        owner_id,
        manifest["run_id"],
        manifest["model_key"],
        use_batch_cache=True,
    )

    generated_dataset = dataset_service.get_dataset(
        database_session, manifest["dataset_id"], owner_id
    )

    generated_path = dataset_service.dataset_file_path(generated_dataset, settings)

    try:
        _cached_generated_sha256(
            generated_path, _file_stamp(generated_path), manifest["generated_sha256"]
        )
    except OSError:
        raise _error(503, "REPLAY_UNAVAILABLE", "재생 CSV를 읽지 못했습니다.") from None
    rows = []

    if cursor < manifest["total_rows"]:
        block = cursor // _INDEX_STEP

        with generated_path.open("r", encoding="utf-8", newline="") as replay_file:
            replay_file.seek(manifest["offsets"][block])
            reader = csv.DictReader(
                replay_file,
                fieldnames=[
                    manifest["timestamp_column"],
                    *configuration.feature_columns,
                    manifest["label_column"],
                ],
            )

            for row_index, row in enumerate(reader, start=block * _INDEX_STEP):
                if row_index < cursor:
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
    features = np.array(
        [[float(row[column]) for column in configuration.feature_columns] for row in rows],
        dtype=float,
    )

    predicted_codes, scores = _predict(estimator, features)

    source_count = manifest["source_end_row"] - manifest["source_start_row"]

    points = []

    for point_index, row in enumerate(rows):
        row_index = cursor + point_index

        source_relative = row_index * source_count // manifest["total_rows"]

        points.append(
            ReplayPoint(
                row_index=row_index,
                timestamp=row[manifest["timestamp_column"]],
                value=float(row[channel]),
                predicted_code=int(predicted_codes[point_index]),
                score=float(scores[point_index]),
                source_row=manifest["source_start_row"] + source_relative,
                source_timestamp=manifest["source_timestamps"][source_relative],
            )
        )
    next_cursor = cursor + len(points)

    return ReplayBatch(
        replay_id=replay_id,
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
