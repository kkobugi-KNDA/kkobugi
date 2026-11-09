"""수동 시간 분할로 모델을 비교하고 선택된 모델의 Test를 별도로 평가한다."""

import hashlib
import json
import platform
import time
import warnings
from bisect import bisect_right
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.exceptions import ConvergenceWarning
from sklearn.metrics import average_precision_score, confusion_matrix, roc_auc_score
from threadpoolctl import threadpool_limits

from app.model_catalog import create_estimator, get_model_catalog
from app.schemas.runs import (
    ClassMetrics,
    EvaluationMetrics,
    ModelDefinition,
    ModelKey,
    ModelResult,
    RunCreate,
    SplitInfo,
    SplitPart,
)


def _file_sha256(file_path: Path) -> str:
    file_hasher = hashlib.sha256()

    with file_path.open("rb") as source_file:
        while True:
            chunk = source_file.read(1024 * 1024)

            if not chunk:
                break
            file_hasher.update(chunk)
    return file_hasher.hexdigest()


def _environment_versions(*, include_lightgbm: bool = False) -> dict[str, str]:
    # 기존 모델에는 없던 패키지 키를 강제로 추가하면 정상 파일도 불일치가 된다.
    environment = {
        "python": platform.python_version(),
        "scikit_learn": version("scikit-learn"),
        "numpy": version("numpy"),
        "pandas": version("pandas"),
        "joblib": version("joblib"),
        "xgboost": version("xgboost"),
        "scipy": version("scipy"),
        "threadpoolctl": version("threadpoolctl"),
    }

    if include_lightgbm:
        environment["lightgbm"] = version("lightgbm")

    return environment


def _artifact_path(artifact_directory: Path, model_key: ModelKey) -> Path:
    if model_key not in {"dummy", "xgboost", "lightgbm", "autoencoder"}:
        raise ValueError("지원하는 모델을 선택하세요.")

    artifact_path = (artifact_directory / f"{model_key}.joblib").resolve()

    if artifact_path.parent != artifact_directory.resolve():
        raise ValueError("저장된 모델 파일의 위치를 확인하세요.")
    return artifact_path


def _read_dataset(
    file_path: Path,
    config: RunCreate,
    *,
    timestamp_column: str,
    label_column: str,
    normal_label: str,
    abnormal_label: str,
    expected_sha256: str,
) -> tuple[np.ndarray, np.ndarray, SplitInfo]:
    if _file_sha256(file_path) != expected_sha256:
        raise ValueError("등록 당시와 CSV 내용이 다릅니다. 원본을 다시 확인하세요.")
    if timestamp_column in config.feature_columns or label_column in config.feature_columns:
        raise ValueError("시각·정답 라벨은 학습 특징에 포함할 수 없습니다.")

    try:
        data_frame = pd.read_csv(
            file_path,
            encoding="utf-8-sig",
            usecols=[timestamp_column, label_column, *config.feature_columns],
            dtype={timestamp_column: str, label_column: str},
            keep_default_na=False,
        )

        timestamps = [
            datetime.fromisoformat(str(value).strip()) for value in data_frame[timestamp_column]
        ]

        timezone_modes = {timestamp.tzinfo is not None for timestamp in timestamps}

        if len(timezone_modes) != 1:
            raise ValueError("CSV 시각이 비어 있거나 시간대 표기가 섞여 있습니다.")

        is_timezone_aware = timestamps[0].tzinfo is not None

        if is_timezone_aware != (config.train_end.tzinfo is not None):
            raise ValueError("CSV와 분할 경계의 시간대 표기를 같게 지정하세요.")
        if is_timezone_aware:
            timestamps = [timestamp.astimezone(UTC) for timestamp in timestamps]

        if any(left >= right for left, right in zip(timestamps, timestamps[1:])):
            raise ValueError("CSV 시각은 중복 없이 오름차순이어야 합니다.")

        feature_values = data_frame[config.feature_columns].to_numpy(dtype=float)

        if not np.isfinite(feature_values).all():
            raise ValueError("선택한 특징에는 결측 없이 유한한 숫자만 있어야 합니다.")

        raw_labels = data_frame[label_column].astype(str).str.strip()

        encoded_labels = raw_labels.map({normal_label: 0, abnormal_label: 1})

        if encoded_labels.isna().any():
            raise ValueError("CSV에 지정한 정상·이상 라벨 외의 값이 있습니다.")
    except (KeyError, OverflowError, pd.errors.ParserError, UnicodeDecodeError):
        raise ValueError("선택한 CSV 컬럼·시각·숫자·라벨 형식을 확인하세요.") from None

    train_end_row = bisect_right(timestamps, config.train_end)

    validation_end_row = bisect_right(timestamps, config.validation_end)

    total_rows = len(timestamps)

    if not 0 < train_end_row < validation_end_row < total_rows:
        raise ValueError("Train·Valid·Test에 각각 한 행 이상 남도록 경계를 지정하세요.")

    split = SplitInfo(
        train=SplitPart(start_row=0, end_row=train_end_row, row_count=train_end_row),
        validation=SplitPart(
            start_row=train_end_row,
            end_row=validation_end_row,
            row_count=validation_end_row - train_end_row,
        ),
        test=SplitPart(
            start_row=validation_end_row,
            end_row=total_rows,
            row_count=total_rows - validation_end_row,
        ),
    )

    return feature_values, encoded_labels.to_numpy(dtype=int), split


def calculate_metrics(
    actual_labels: np.ndarray, predicted_labels: np.ndarray, anomaly_scores: np.ndarray
) -> EvaluationMetrics:
    """두 클래스의 순서를 고정하고, 정의되지 않는 지표는 숫자로 꾸미지 않는다."""

    matrix = confusion_matrix(actual_labels, predicted_labels, labels=[0, 1])

    class_metrics = {}

    for class_index, class_name in enumerate(("normal", "abnormal")):
        true_positives = int(matrix[class_index, class_index])

        actual_support = int(matrix[class_index, :].sum())

        predicted_support = int(matrix[:, class_index].sum())

        precision = true_positives / predicted_support if predicted_support else None

        recall = true_positives / actual_support if actual_support else None

        f1_denominator = actual_support + predicted_support

        f1 = 2 * true_positives / f1_denominator if actual_support else None

        class_metrics[class_name] = ClassMetrics(
            precision=precision, recall=recall, f1=f1, support=actual_support
        )

    has_both_classes = all(result.support > 0 for result in class_metrics.values())

    metric_warnings = []

    if not has_both_classes:
        metric_warnings.append(
            "평가 구간에 한 라벨만 있어 ROC AUC·AP·균형 정확도를 계산하지 않습니다."
        )

    abnormal_metrics = class_metrics["abnormal"]

    return EvaluationMetrics(
        accuracy=float(np.trace(matrix) / len(actual_labels)),
        precision=abnormal_metrics.precision,
        recall=abnormal_metrics.recall,
        f1=abnormal_metrics.f1,
        balanced_accuracy=(
            float((class_metrics["normal"].recall + abnormal_metrics.recall) / 2)
            if has_both_classes
            else None
        ),
        roc_auc=float(roc_auc_score(actual_labels, anomaly_scores)) if has_both_classes else None,
        average_precision=(
            float(average_precision_score(actual_labels, anomaly_scores))
            if has_both_classes
            else None
        ),
        confusion_matrix=matrix.tolist(),
        class_metrics=class_metrics,
        sample_count=len(actual_labels),
        warnings=metric_warnings,
    )


def _anomaly_scores(estimator, features: np.ndarray) -> np.ndarray:
    if hasattr(estimator, "decision_function"):
        # AutoEncoder의 재구성 오차를 확률로 바꾸지 않고 순위 지표에 사용한다.
        return estimator.decision_function(features)

    class_values = list(estimator.classes_)

    if 1 not in class_values:
        return np.zeros(len(features))
    return estimator.predict_proba(features)[:, class_values.index(1)]


def train_models(
    file_path: Path,
    config: RunCreate,
    *,
    normal_label: str,
    abnormal_label: str,
    expected_sha256: str,
    artifact_directory: Path,
    timestamp_column: str = "timestamp",
    label_column: str = "label",
) -> dict:
    features, labels, split = _read_dataset(
        file_path,
        config,
        timestamp_column=timestamp_column,
        label_column=label_column,
        normal_label=normal_label,
        abnormal_label=abnormal_label,
        expected_sha256=expected_sha256,
    )

    train_features = features[: split.train.end_row]

    train_labels = labels[: split.train.end_row]

    validation_features = features[split.validation.start_row : split.validation.end_row]

    validation_labels = labels[split.validation.start_row : split.validation.end_row]

    # 모든 선택 모델의 전제조건을 먼저 확인해, 잘못된 실행에 모델 파일을 남기지 않는다.
    if "xgboost" in config.models and len(np.unique(train_labels)) != 2:
        raise ValueError("XGBoost 학습에는 Train의 정상·이상 라벨이 모두 필요합니다.")
    if "lightgbm" in config.models and len(np.unique(train_labels)) != 2:
        raise ValueError("LightGBM 학습에는 Train의 정상·이상 라벨이 모두 필요합니다.")
    if "autoencoder" in config.models and int((train_labels == 0).sum()) < 2:
        raise ValueError("AutoEncoder 학습에는 Train의 정상 표본이 두 개 이상 필요합니다.")

    environment = _environment_versions(include_lightgbm="lightgbm" in config.models)

    metadata = {
        "configuration": config.model_dump(mode="json"),
        "input_sha256": expected_sha256,
        "timestamp_column": timestamp_column,
        "label_column": label_column,
        "normal_label": normal_label,
        "abnormal_label": abnormal_label,
        "environment": environment,
    }

    artifact_directory.mkdir(parents=True, exist_ok=True)
    if any(artifact_directory.iterdir()):
        raise ValueError("모델을 저장할 새 실행 폴더가 필요합니다.")

    catalog = {definition.key: definition for definition in get_model_catalog().items}

    # 이전 버전의 파일을 재현하는 내부 검증에서만 Dummy 설정을 사용한다.
    # 새 API 학습 요청은 NewRunCreate와 RunManager에서 이미 거절한다.
    if "dummy" in config.models:
        catalog["dummy"] = ModelDefinition(
            key="dummy",
            display_name="DummyClassifier",
            kind="baseline",
            description="이전 버전에 저장된 다수 라벨 기준 모델",
            parameters={"strategy": "most_frequent", "random_state": config.random_seed},
        )

    model_results = []

    with threadpool_limits(limits=1):
        for model_key in config.models:
            estimator = create_estimator(model_key, config.random_seed)

            started_at = time.perf_counter()

            with warnings.catch_warnings(record=True) as training_warnings:
                warnings.simplefilter("always", ConvergenceWarning)
                estimator.fit(train_features, train_labels)

            training_seconds = time.perf_counter() - started_at

            predicted_labels = estimator.predict(validation_features)

            anomaly_scores = _anomaly_scores(estimator, validation_features)

            validation_metrics = calculate_metrics(
                validation_labels, predicted_labels, anomaly_scores
            )

            artifact_path = _artifact_path(artifact_directory, model_key)

            with artifact_path.open("xb") as artifact_file:
                joblib.dump(estimator, artifact_file, compress=3)

            parameters = dict(catalog[model_key].parameters)

            parameters["random_state"] = config.random_seed

            if model_key == "autoencoder":
                parameters["hidden_layer_sizes"] = list(estimator.hidden_layer_sizes_)

                parameters["threshold"] = estimator.threshold_

            model_warnings = []

            if any(
                issubclass(warning.category, ConvergenceWarning) for warning in training_warnings
            ):
                model_warnings.append(
                    "정해진 반복 횟수 안에 수렴하지 않았습니다. 결과를 확인하세요."
                )

            model_results.append(
                ModelResult(
                    model_key=model_key,
                    display_name=catalog[model_key].display_name,
                    parameters=parameters,
                    validation_metrics=validation_metrics,
                    training_seconds=training_seconds,
                    artifact_sha256=_file_sha256(artifact_path),
                    warnings=model_warnings,
                ).model_dump()
            )

    # JSON을 먼저 읽어 버전을 확인한 다음에만 서버가 만든 joblib을 역직렬화한다.
    with (artifact_directory / "metadata.json").open("x", encoding="utf-8") as metadata_file:
        json.dump(metadata, metadata_file, ensure_ascii=False, allow_nan=False)

    return {
        "split": split.model_dump(),
        "models": model_results,
        "environment": environment,
        "warnings": [
            "평가는 업로드된 CSV 기준입니다. 업로드 전 전처리의 시간 누수 여부는 별도로 확인하세요."
        ],
    }


def load_trained_model(
    file_path: Path,
    config: RunCreate,
    *,
    normal_label: str,
    abnormal_label: str,
    expected_sha256: str,
    artifact_directory: Path,
    model_key: ModelKey,
    expected_artifact_sha256: str,
    timestamp_column: str = "timestamp",
    label_column: str = "label",
) -> object:
    """원본·설정·버전·모델 해시를 확인한 뒤 서버가 저장한 모델만 읽는다."""

    if model_key not in config.models:
        raise ValueError("이 실행에서 학습한 모델을 선택하세요.")
    if _file_sha256(file_path) != expected_sha256:
        raise ValueError("등록 당시와 CSV 내용이 다릅니다. 원본을 다시 확인하세요.")

    metadata_path = artifact_directory / "metadata.json"

    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    except (OSError, ValueError):
        raise ValueError("저장된 모델의 실행 정보를 확인할 수 없습니다.") from None

    if not isinstance(metadata, dict) or not isinstance(metadata.get("environment"), dict):
        raise ValueError("저장된 모델의 실행 정보 형식을 확인하세요.")

    expected_metadata = {
        "configuration": config.model_dump(mode="json"),
        "input_sha256": expected_sha256,
        "timestamp_column": timestamp_column,
        "label_column": label_column,
        "normal_label": normal_label,
        "abnormal_label": abnormal_label,
        "environment": _environment_versions(
            include_lightgbm="lightgbm" in metadata.get("environment", {})
        ),
    }

    if model_key == "lightgbm" and "lightgbm" not in metadata.get("environment", {}):
        raise ValueError("LightGBM 학습 당시의 패키지 버전을 확인할 수 없습니다.")
    if metadata != expected_metadata:
        raise ValueError("학습 당시의 모델 설정·데이터·패키지 버전과 일치하지 않습니다.")

    artifact_path = _artifact_path(artifact_directory, model_key)

    if _file_sha256(artifact_path) != expected_artifact_sha256:
        raise ValueError("저장된 모델 파일의 내용이 변경됐습니다.")

    # 검증 전에는 joblib을 읽지 않는다. 사용자 업로드 모델도 받지 않는다.
    return joblib.load(artifact_path)


def evaluate_model(
    file_path: Path,
    config: RunCreate,
    *,
    normal_label: str,
    abnormal_label: str,
    expected_sha256: str,
    artifact_directory: Path,
    model_key: ModelKey,
    expected_artifact_sha256: str,
    timestamp_column: str = "timestamp",
    label_column: str = "label",
) -> EvaluationMetrics:

    features, labels, split = _read_dataset(
        file_path,
        config,
        timestamp_column=timestamp_column,
        label_column=label_column,
        normal_label=normal_label,
        abnormal_label=abnormal_label,
        expected_sha256=expected_sha256,
    )

    # 학습·재학습 없이 이미 고른 모델로 Test만 예측한다.
    estimator = load_trained_model(
        file_path,
        config,
        normal_label=normal_label,
        abnormal_label=abnormal_label,
        expected_sha256=expected_sha256,
        artifact_directory=artifact_directory,
        model_key=model_key,
        expected_artifact_sha256=expected_artifact_sha256,
        timestamp_column=timestamp_column,
        label_column=label_column,
    )

    test_features = features[split.test.start_row : split.test.end_row]

    with threadpool_limits(limits=1):
        predicted_labels = estimator.predict(test_features)

        anomaly_scores = _anomaly_scores(estimator, test_features)

    return calculate_metrics(labels[split.test.start_row :], predicted_labels, anomaly_scores)
