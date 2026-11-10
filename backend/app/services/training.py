"""전처리가 끝난 CSV에서 순서를 지킨 분할과 제한된 기본 옵션을 만든다."""

import csv
from datetime import datetime
from decimal import Decimal

from fastapi import HTTPException

from app.config import Settings
from app.models import Dataset
from app.schemas.runs import AutoencoderOptions, NewRunCreate, XGBoostOptions
from app.schemas.training import TrainingPlanRequest, TrainingPlanResponse
from app.services import datasets as dataset_service
from app.services.csv_format import detect_csv_delimiter
from app.services.csv_inspection import METADATA_COLUMNS
from app.services.modeling import _file_sha256


def make_training_plan(
    dataset: Dataset, settings: Settings, request: TrainingPlanRequest
) -> TrainingPlanResponse:
    inspection = dataset_service.dataset_detail(dataset).inspection

    if not inspection.is_valid or inspection.row_count < 3:
        raise HTTPException(
            422, detail={"code": "DATASET_NOT_READY", "message": "CSV 검사를 먼저 확인하세요."}
        )
    if inspection.row_count > settings.max_training_rows:
        raise HTTPException(
            413,
            detail={
                "code": "TRAINING_DATA_TOO_LARGE",
                "message": "학습 가능한 행 수를 초과했습니다.",
            },
        )
    features = request.feature_columns or inspection.channels

    if (
        not features
        or len(set(features)) != len(features)
        or not set(features).issubset(inspection.channels)
        or set(features) & METADATA_COLUMNS
        or len(features) > settings.max_training_features
    ):
        raise HTTPException(
            422, detail={"code": "INVALID_FEATURES", "message": "학습할 숫자 채널을 확인하세요."}
        )
    train_rows = max(1, int(inspection.row_count * Decimal(str(request.train_ratio))))

    validation_rows = max(1, int(inspection.row_count * Decimal(str(request.validation_ratio))))

    validation_end_row = train_rows + validation_rows

    if validation_end_row >= inspection.row_count:
        raise HTTPException(
            422,
            detail={
                "code": "INVALID_SPLIT",
                "message": "학습·중간 확인·최종 확인에 각각 데이터가 필요합니다.",
            },
        )
    source_path = dataset_service.dataset_file_path(dataset, settings)

    if _file_sha256(source_path) != dataset.sha256:
        raise HTTPException(
            409, detail={"code": "DATASET_CHANGED", "message": "등록 당시와 CSV 내용이 다릅니다."}
        )
    boundaries = {}

    normal_train_rows = 0

    abnormal_train_rows = 0

    label_counts = {part: {"normal": 0, "abnormal": 0} for part in ("train", "validation", "test")}

    with source_path.open("r", encoding="utf-8-sig", newline="") as source_file:
        for row_index, row in enumerate(
            csv.DictReader(source_file, delimiter=detect_csv_delimiter(source_file))
        ):
            part = (
                "train"
                if row_index < train_rows
                else "validation"
                if row_index < validation_end_row
                else "test"
            )

            label_counts[part][
                "normal"
                if row[dataset.label_column].strip() == dataset.normal_label
                else "abnormal"
            ] += 1

            if row_index < train_rows:
                normal_train_rows += row[dataset.label_column].strip() == dataset.normal_label

                abnormal_train_rows += row[dataset.label_column].strip() == dataset.abnormal_label

            if row_index in {train_rows - 1, validation_end_row - 1}:
                boundaries[row_index] = datetime.fromisoformat(
                    row[dataset.timestamp_column].strip()
                )

    if request.model_key == "xgboost" and not (normal_train_rows and abnormal_train_rows):
        raise HTTPException(
            422,
            detail={
                "code": "TRAIN_LABELS_REQUIRED",
                "message": (
                    "XGBoost는 학습 구간에 정상·비정상 기록이 모두 필요합니다. "
                    "분할 시점을 조정하세요."
                ),
            },
        )
    if request.model_key == "autoencoder" and normal_train_rows < 2:
        raise HTTPException(
            422,
            detail={
                "code": "NORMAL_TRAIN_REQUIRED",
                "message": "AutoEncoder는 학습 구간에 정상 기록이 두 개 이상 필요합니다.",
            },
        )
    options = (
        XGBoostOptions().model_dump()
        if request.model_key == "xgboost"
        else AutoencoderOptions().model_dump()
    )

    warnings = []

    for part, label in (("validation", "중간 확인"), ("test", "최종 확인")):
        if not label_counts[part]["abnormal"]:
            warnings.append(
                f"{label} 구간에 비정상 기록이 없어 비정상 탐지 점수를 계산할 수 없습니다. "
                "이 구간에서 정상만 맞혔다고 비정상 탐지를 잘한다고 볼 수 없습니다."
            )
        elif not label_counts[part]["normal"]:
            warnings.append(
                f"{label} 구간에 정상 기록이 없습니다. "
                "잘못된 알림과 탐지 성능을 함께 확인할 수 없습니다."
            )

    return TrainingPlanResponse(
        configuration=NewRunCreate(
            dataset_id=dataset.id,
            feature_columns=features,
            models=[request.model_key],
            train_end=boundaries[train_rows - 1],
            validation_end=boundaries[validation_end_row - 1],
            model_options={request.model_key: options},
        ),
        split={
            "train_rows": train_rows,
            "validation_rows": validation_rows,
            "test_rows": inspection.row_count - validation_end_row,
        },
        notes=[
            "원본 CSV의 시간 순서를 유지합니다. 결측 처리·파생변수 생성은 하지 않습니다.",
            "중간 확인(Valid)과 최종 확인(Test)은 학습에 넣지 않습니다.",
            "AutoEncoder의 스케일·재구성망·이상 기준은 정상 Train에서만 만듭니다.",
            "자동 설정은 제안이며 최적 성능을 보장하는 자동 탐색이 아닙니다.",
        ],
        warnings=warnings,
        label_counts=label_counts,
    )
