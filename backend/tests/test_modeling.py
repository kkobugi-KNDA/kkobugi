"""시간 분할·정상 전용 학습·Test 격리와 모델 재사용을 검증한다."""

import csv
import hashlib
import json
from datetime import datetime, timedelta

import joblib
import numpy as np
import pytest
from pydantic import ValidationError

from app.model_catalog import NormalOnlyAutoencoder, create_estimator, get_model_catalog
from app.schemas.runs import RunCreate
from app.services import modeling


@pytest.fixture
def model_data(tmp_path):
    def write_data(*, name="prepared.csv", labels=None, test_offset=0, aware=False):
        source_path = tmp_path / name

        start_time = datetime(2026, 11, 9)

        source_labels = labels or [
            "normal",
            "normal",
            "normal",
            "abnormal",
            "normal",
            "normal",
            "normal",
            "abnormal",
            "normal",
            "abnormal",
            "normal",
            "abnormal",
        ]

        with source_path.open("w", encoding="utf-8-sig", newline="") as source_file:
            writer = csv.writer(source_file)

            writer.writerow(["timestamp", "sensor_a", "sensor_b", "label"])
            for row_index, source_label in enumerate(source_labels):
                timestamp = (start_time + timedelta(minutes=row_index)).isoformat()

                if aware:
                    timestamp += "+00:00"

                # Train의 비정상 표본과 Test 값이 정상 Train 스케일러에 들어가면 평균이 달라진다.
                offset = 1000 if row_index == 3 else 0

                if row_index >= 9:
                    offset += test_offset

                writer.writerow(
                    [timestamp, row_index + offset, 2 * row_index + offset, source_label]
                )
        return source_path

    return write_data


def run_configuration(models=None, **updates):
    request_values = {
        "dataset_id": "a" * 32,
        "feature_columns": ["sensor_b", "sensor_a"],
        "models": models or ["dummy"],
        "train_end": "2026-11-09T00:05:00",
        "validation_end": "2026-11-09T00:08:00",
        **updates,
    }

    return RunCreate(**request_values)


def source_hash(source_path):
    return hashlib.sha256(source_path.read_bytes()).hexdigest()


def train(source_path, configuration, artifact_directory, **column_options):
    return modeling.train_models(
        source_path,
        configuration,
        normal_label="normal",
        abnormal_label="abnormal",
        expected_sha256=source_hash(source_path),
        artifact_directory=artifact_directory,
        **column_options,
    )


@pytest.mark.parametrize(
    "missing_field", ["train_end", "validation_end", "models", "feature_columns"]
)
def test_user_must_choose_boundaries_models_and_features(missing_field):
    request_values = run_configuration().model_dump()

    del request_values[missing_field]
    with pytest.raises(ValidationError):
        RunCreate(**request_values)


@pytest.mark.parametrize(
    "updates",
    [
        {"models": ["dummy", "dummy"]},
        {"models": ["arbitrary_import"]},
        {"feature_columns": ["sensor_a", "sensor_a"]},
        {"feature_columns": [" "]},
        {"train_end": 123456},
        {"train_end": "123456"},
        {"train_end": "2026-11-09T00:08:00"},
        {"train_end": "2026-11-09T00:05:00+00:00"},
        {"unexpected_setting": True},
    ],
)
def test_invalid_or_ambiguous_configuration_is_rejected(updates):
    with pytest.raises(ValidationError):
        run_configuration(**updates)


def test_catalog_matches_figma_and_exposes_autoencoder_score_meaning():
    definitions = {definition.key: definition for definition in get_model_catalog().items}

    assert set(definitions) == {"lightgbm", "xgboost", "autoencoder"}
    assert definitions["lightgbm"].kind == "classifier"
    assert definitions["lightgbm"].parameters["n_jobs"] == 1
    assert definitions["lightgbm"].parameters["deterministic"] is True
    assert definitions["xgboost"].parameters["n_jobs"] == 1
    assert definitions["autoencoder"].kind == "anomaly_detector"
    assert definitions["autoencoder"].parameters["training_scope"] == "normal_train_only"
    assert definitions["autoencoder"].parameters["threshold_quantile"] == 0.99
    assert definitions["autoencoder"].parameters["score_type"] == "reconstruction_error"


def test_binary_metrics_have_fixed_matrix_and_class_support():
    actual_labels = np.array([0, 0, 0, 1, 1, 1])

    predicted_labels = np.array([0, 0, 1, 0, 1, 1])

    anomaly_scores = np.array([0.1, 0.2, 0.8, 0.4, 0.7, 0.9])

    metrics = modeling.calculate_metrics(actual_labels, predicted_labels, anomaly_scores)

    assert metrics.confusion_matrix == [[2, 1], [1, 2]]
    assert metrics.accuracy == pytest.approx(2 / 3)
    assert metrics.precision == pytest.approx(2 / 3)
    assert metrics.recall == pytest.approx(2 / 3)
    assert metrics.f1 == pytest.approx(2 / 3)
    assert metrics.roc_auc == pytest.approx(7 / 9)
    assert metrics.class_metrics["normal"].support == 3
    assert metrics.class_metrics["abnormal"].support == 3
    assert metrics.sample_count == 6


@pytest.mark.parametrize("single_class", [0, 1])
def test_single_class_evaluation_keeps_undefined_metrics_null(single_class):
    labels = np.full(3, single_class)

    metrics = modeling.calculate_metrics(labels, labels, np.array([0.1, 0.3, 0.2]))

    assert metrics.accuracy == 1
    assert metrics.roc_auc is None
    assert metrics.average_precision is None
    assert metrics.balanced_accuracy is None
    assert metrics.warnings
    assert metrics.class_metrics["normal" if single_class else "abnormal"].support == 0
    assert metrics.class_metrics["normal" if single_class else "abnormal"].recall is None
    json.dumps(metrics.model_dump(), allow_nan=False)


def test_training_uses_explicit_row_boundaries_and_only_requested_models(model_data, tmp_path):
    source_path = model_data()

    original_bytes = source_path.read_bytes()

    report = train(source_path, run_configuration(), tmp_path / "artifacts")

    assert report["split"] == {
        "train": {"start_row": 0, "end_row": 6, "row_count": 6},
        "validation": {"start_row": 6, "end_row": 9, "row_count": 3},
        "test": {"start_row": 9, "end_row": 12, "row_count": 3},
    }
    assert [result["model_key"] for result in report["models"]] == ["dummy"]
    assert set(report) == {"split", "models", "environment", "warnings"}
    assert "test_metrics" not in json.dumps(report)
    assert source_path.read_bytes() == original_bytes
    assert {path.name for path in (tmp_path / "artifacts").iterdir()} == {
        "dummy.joblib",
        "metadata.json",
    }


@pytest.mark.parametrize("train_label", ["normal", "abnormal"])
def test_dummy_supports_one_class_train_without_probability_index_errors(
    model_data, tmp_path, train_label
):
    source_labels = [train_label] * 6 + ["normal", "abnormal", "normal"] * 2

    source_path = model_data(labels=source_labels)

    report = train(source_path, run_configuration(), tmp_path / "artifacts")

    assert report["models"][0]["validation_metrics"]["sample_count"] == 3
    assert report["models"][0]["validation_metrics"]["roc_auc"] == 0.5


def test_xgboost_requires_both_train_labels_before_creating_artifacts(model_data, tmp_path):
    source_path = model_data(labels=["normal"] * 6 + ["normal", "abnormal", "normal"] * 2)

    artifact_directory = tmp_path / "artifacts"

    with pytest.raises(ValueError, match="XGBoost"):
        train(source_path, run_configuration(["dummy", "xgboost"]), artifact_directory)
    assert not artifact_directory.exists()


def test_autoencoder_uses_only_normal_train_and_preserves_feature_order(model_data, tmp_path):
    source_path = model_data(test_offset=100_000)

    artifact_directory = tmp_path / "artifacts"

    report = train(source_path, run_configuration(["autoencoder"]), artifact_directory)

    estimator = joblib.load(artifact_directory / "autoencoder.joblib")

    normal_train = np.array([[0, 0], [2, 1], [4, 2], [8, 4], [10, 5]], dtype=float)

    assert isinstance(estimator, NormalOnlyAutoencoder)
    np.testing.assert_allclose(estimator.scaler_.mean_, normal_train.mean(axis=0))
    assert estimator.threshold_ == pytest.approx(
        np.quantile(estimator.decision_function(normal_train), 0.99)
    )
    assert report["models"][0]["parameters"]["threshold"] == estimator.threshold_
    assert not hasattr(estimator, "predict_proba")

    metadata = json.loads((artifact_directory / "metadata.json").read_text(encoding="utf-8"))

    assert metadata["configuration"]["feature_columns"] == ["sensor_b", "sensor_a"]


def test_changing_only_test_values_cannot_change_autoencoder_or_validation(model_data, tmp_path):
    first_source = model_data(name="first.csv")

    second_source = model_data(name="second.csv", test_offset=1_000_000)

    configuration = run_configuration(["autoencoder"])

    first_report = train(first_source, configuration, tmp_path / "first")

    second_report = train(second_source, configuration, tmp_path / "second")

    first_estimator = joblib.load(tmp_path / "first" / "autoencoder.joblib")

    second_estimator = joblib.load(tmp_path / "second" / "autoencoder.joblib")

    np.testing.assert_array_equal(first_estimator.scaler_.mean_, second_estimator.scaler_.mean_)
    for first_weights, second_weights in zip(
        first_estimator.network_.coefs_, second_estimator.network_.coefs_, strict=True
    ):
        np.testing.assert_array_equal(first_weights, second_weights)
    assert first_estimator.threshold_ == second_estimator.threshold_
    assert (
        first_report["models"][0]["validation_metrics"]
        == second_report["models"][0]["validation_metrics"]
    )


def test_selection_evaluation_reuses_model_without_fitting_again(model_data, tmp_path, monkeypatch):
    source_path = model_data()

    configuration = run_configuration(["autoencoder"])

    artifact_directory = tmp_path / "artifacts"

    report = train(source_path, configuration, artifact_directory)

    artifact_hash = report["models"][0]["artifact_sha256"]

    def reject_refit(*arguments, **keywords):
        raise AssertionError("Test 평가에서 다시 학습하면 안 됩니다.")

    monkeypatch.setattr(NormalOnlyAutoencoder, "fit", reject_refit)
    metrics = modeling.evaluate_model(
        source_path,
        configuration,
        normal_label="normal",
        abnormal_label="abnormal",
        expected_sha256=source_hash(source_path),
        artifact_directory=artifact_directory,
        model_key="autoencoder",
        expected_artifact_sha256=artifact_hash,
    )

    assert metrics.sample_count == 3
    assert source_hash(artifact_directory / "autoencoder.joblib") == artifact_hash


@pytest.mark.parametrize("corruption", ["artifact", "metadata", "source"])
def test_corrupt_source_or_artifact_is_rejected_before_deserialization(
    model_data, tmp_path, monkeypatch, corruption
):
    source_path = model_data()

    configuration = run_configuration()

    artifact_directory = tmp_path / "artifacts"

    expected_source_hash = source_hash(source_path)

    report = train(source_path, configuration, artifact_directory)

    if corruption == "artifact":
        with (artifact_directory / "dummy.joblib").open("ab") as artifact_file:
            artifact_file.write(b"changed")
    elif corruption == "source":
        with source_path.open("ab") as source_file:
            source_file.write(b"changed")
    else:
        metadata_path = artifact_directory / "metadata.json"

        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

        metadata["environment"]["scikit_learn"] = "different-version"

        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    def reject_load(*arguments, **keywords):
        raise AssertionError("무결성·버전 확인 전에 joblib을 읽으면 안 됩니다.")

    monkeypatch.setattr(modeling.joblib, "load", reject_load)
    with pytest.raises(ValueError):
        modeling.evaluate_model(
            source_path,
            configuration,
            normal_label="normal",
            abnormal_label="abnormal",
            expected_sha256=expected_source_hash,
            artifact_directory=artifact_directory,
            model_key="dummy",
            expected_artifact_sha256=report["models"][0]["artifact_sha256"],
        )


def test_custom_timestamp_label_columns_and_numeric_label_strings(model_data, tmp_path):
    source_path = model_data()

    source_text = source_path.read_text(encoding="utf-8-sig").replace("timestamp,", "time,")

    source_text = (
        source_text.replace(",label", ",target").replace(",normal", ",0").replace(",abnormal", ",1")
    )

    source_path.write_text(source_text, encoding="utf-8")
    report = modeling.train_models(
        source_path,
        run_configuration(),
        normal_label="0",
        abnormal_label="1",
        expected_sha256=source_hash(source_path),
        artifact_directory=tmp_path / "artifacts",
        timestamp_column="time",
        label_column="target",
    )

    assert report["models"][0]["validation_metrics"]["class_metrics"]["abnormal"]["support"] == 1


@pytest.mark.parametrize("leakage_feature", ["timestamp", "label"])
def test_time_or_target_columns_cannot_be_features(model_data, tmp_path, leakage_feature):
    with pytest.raises(ValueError, match="학습 특징"):
        train(
            model_data(),
            run_configuration(feature_columns=[leakage_feature]),
            tmp_path / "artifacts",
        )


def test_all_figma_models_train_with_requested_seed_and_report_validation_only(
    model_data, tmp_path
):
    configuration = run_configuration(["lightgbm", "xgboost", "autoencoder"], random_seed=7)

    report = train(model_data(), configuration, tmp_path / "artifacts")

    assert [result["model_key"] for result in report["models"]] == configuration.models
    assert all(result["parameters"]["random_state"] == 7 for result in report["models"])
    assert all(result["validation_metrics"]["sample_count"] == 3 for result in report["models"])
    assert all(result["rank"] is None for result in report["models"])
    assert all(len(result["artifact_sha256"]) == 64 for result in report["models"])


def test_autoencoder_requires_two_normal_train_samples(model_data, tmp_path):
    source_path = model_data(labels=["normal"] + ["abnormal"] * 11)

    with pytest.raises(ValueError, match="두 개"):
        train(source_path, run_configuration(["autoencoder"]), tmp_path / "artifacts")


def test_autoencoder_can_train_when_train_contains_only_normal(model_data, tmp_path):
    source_path = model_data(labels=["normal"] * 6 + ["normal", "abnormal", "normal"] * 2)

    report = train(source_path, run_configuration(["autoencoder"]), tmp_path / "artifacts")

    assert report["models"][0]["validation_metrics"]["sample_count"] == 3
    assert report["models"][0]["parameters"]["training_scope"] == "normal_train_only"


def test_changed_source_is_rejected_before_model_creation(model_data, tmp_path, monkeypatch):
    source_path = model_data()

    def reject_estimator_creation(*arguments, **keywords):
        raise AssertionError("원본 확인 전에 모델을 만들면 안 됩니다.")

    monkeypatch.setattr(modeling, "create_estimator", reject_estimator_creation)
    with pytest.raises(ValueError, match="CSV 내용"):
        modeling.train_models(
            source_path,
            run_configuration(),
            normal_label="normal",
            abnormal_label="abnormal",
            expected_sha256="0" * 64,
            artifact_directory=tmp_path / "artifacts",
        )
    assert not (tmp_path / "artifacts").exists()


@pytest.mark.parametrize("boundary", ["2026-11-08T23:00:00", "2026-11-09T00:05:00"])
def test_every_split_must_have_rows(model_data, tmp_path, boundary):
    configuration = run_configuration(train_end=boundary)

    if boundary.endswith("00:05:00"):
        configuration = run_configuration(validation_end="2026-11-09T00:05:01")

    with pytest.raises(ValueError, match="각각 한 행"):
        train(model_data(), configuration, tmp_path / "artifacts")


def test_timezone_boundaries_must_match_dataset(model_data, tmp_path):
    with pytest.raises(ValueError, match="시간대"):
        train(model_data(aware=True), run_configuration(), tmp_path / "artifacts")


def test_explicit_aware_boundaries_use_same_instants(model_data, tmp_path):
    configuration = run_configuration(
        train_end="2026-11-09T09:05:00+09:00",
        validation_end="2026-11-09T09:08:00+09:00",
    )

    report = train(model_data(aware=True), configuration, tmp_path / "artifacts")

    assert report["split"]["train"]["row_count"] == 6
    assert report["split"]["validation"]["row_count"] == 3


def test_unknown_estimator_is_not_imported():
    with pytest.raises(ValueError, match="지원하는 모델"):
        create_estimator("arbitrary_import", 42)


def test_lightgbm_requires_both_train_labels_before_creating_artifacts(model_data, tmp_path):
    source_path = model_data(labels=["normal"] * 12)

    artifact_directory = tmp_path / "artifacts"

    with pytest.raises(ValueError, match="LightGBM"):
        train(source_path, run_configuration(["lightgbm"]), artifact_directory)
    assert not artifact_directory.exists()


def test_lightgbm_model_save_reload_and_test_predictions_use_same_features(tmp_path, monkeypatch):
    source_path = tmp_path / "lightgbm.csv"

    start_time = datetime(2026, 11, 9)

    # 두 클래스에 각각 충분한 Train 표본을 만들어 실제 분기·예측을 확인한다.
    with source_path.open("w", encoding="utf-8", newline="") as source_file:
        writer = csv.writer(source_file)

        writer.writerow(["timestamp", "sensor_a", "sensor_b", "label"])
        for row_index in range(100):
            is_abnormal = row_index % 2 == 1

            writer.writerow(
                [
                    (start_time + timedelta(minutes=row_index)).isoformat(),
                    10 if is_abnormal else 0,
                    row_index / 100,
                    "abnormal" if is_abnormal else "normal",
                ]
            )
    configuration = run_configuration(
        ["lightgbm"],
        train_end=(start_time + timedelta(minutes=59)).isoformat(),
        validation_end=(start_time + timedelta(minutes=79)).isoformat(),
    )

    artifact_directory = tmp_path / "artifacts"

    report = train(source_path, configuration, artifact_directory)

    model_result = report["models"][0]

    assert "lightgbm" in report["environment"]
    assert model_result["validation_metrics"]["f1"] == 1.0
    stored_estimator = joblib.load(artifact_directory / "lightgbm.joblib")

    assert stored_estimator.n_features_in_ == 2
    assert stored_estimator.get_params()["random_state"] == 42
    assert stored_estimator.get_params()["n_jobs"] == 1
    validation_features = np.array(
        [[row / 100, 10.0 if row % 2 else 0.0] for row in range(60, 80)]
    )

    expected_probabilities = stored_estimator.predict_proba(validation_features)[:, 1]

    scores = modeling._anomaly_scores(stored_estimator, validation_features)

    # 실제 저장된 LightGBM의 raw margin은 1을 넘는다. 이를 확률로 표시하면 100%를 넘는다.
    assert np.abs(stored_estimator.decision_function(validation_features)).max() > 1
    assert ((scores >= 0) & (scores <= 1)).all()
    np.testing.assert_allclose(scores, expected_probabilities)

    def forbid_fit(*arguments, **keyword_arguments):
        raise AssertionError("Test 조회 중 재학습하면 안 됩니다.")

    monkeypatch.setattr(type(stored_estimator), "fit", forbid_fit)
    metrics = modeling.evaluate_model(
        source_path,
        configuration,
        normal_label="normal",
        abnormal_label="abnormal",
        expected_sha256=source_hash(source_path),
        artifact_directory=artifact_directory,
        model_key="lightgbm",
        expected_artifact_sha256=model_result["artifact_sha256"],
    )

    assert metrics.f1 == 1.0
    assert metrics.sample_count == 20


def test_classifier_with_both_score_methods_uses_probability_and_class_order():
    class Classifier:
        # 클래스 배열의 순서를 고정해서 가정하지 않고 이상 클래스 1의 위치를 찾는다.
        classes_ = np.array([1, 0])

        def predict_proba(self, features):
            return np.array([[0.8, 0.2], [0.1, 0.9]])

        def decision_function(self, features):
            raise AssertionError("분류 모델의 raw margin을 확률 대신 사용하면 안 됩니다.")

    scores = modeling._anomaly_scores(Classifier(), np.ones((2, 1)))

    np.testing.assert_array_equal(scores, [0.8, 0.1])


@pytest.mark.parametrize("invalid_score", [-0.1, 1.1, float("inf"), float("nan")])
def test_invalid_classifier_probability_is_rejected_instead_of_clipped(invalid_score):
    class InvalidClassifier:
        classes_ = np.array([0, 1])

        def predict_proba(self, features):
            return np.array([[0.0, invalid_score]])

    with pytest.raises(ValueError, match="확률 범위"):
        modeling._anomaly_scores(InvalidClassifier(), np.ones((1, 1)))


def test_legacy_artifact_without_lightgbm_version_still_evaluates(model_data, tmp_path):
    source_path = model_data()

    configuration = run_configuration(["dummy"])

    artifact_directory = tmp_path / "legacy-artifacts"

    report = train(source_path, configuration, artifact_directory)

    metadata = json.loads((artifact_directory / "metadata.json").read_text(encoding="utf-8"))

    assert "lightgbm" not in metadata["environment"]
    metrics = modeling.evaluate_model(
        source_path,
        configuration,
        normal_label="normal",
        abnormal_label="abnormal",
        expected_sha256=source_hash(source_path),
        artifact_directory=artifact_directory,
        model_key="dummy",
        expected_artifact_sha256=report["models"][0]["artifact_sha256"],
    )

    assert metrics.sample_count == 3


@pytest.mark.parametrize("version_change", ["missing", "different"])
def test_lightgbm_version_is_checked_before_loading_model(
    model_data, tmp_path, monkeypatch, version_change
):
    source_path = model_data()

    configuration = run_configuration(["lightgbm"])

    artifact_directory = tmp_path / "artifacts"

    report = train(source_path, configuration, artifact_directory)

    metadata_path = artifact_directory / "metadata.json"

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

    # 버전 키가 빠지거나 달라진 LightGBM 파일을 역직렬화하지 않는지 확인한다.
    if version_change == "missing":
        del metadata["environment"]["lightgbm"]
    else:
        metadata["environment"]["lightgbm"] = "different-version"

    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    def reject_load(*arguments, **keyword_arguments):
        raise AssertionError("패키지 버전을 확인하기 전에 모델을 읽으면 안 됩니다.")

    monkeypatch.setattr(modeling.joblib, "load", reject_load)
    with pytest.raises(ValueError):
        modeling.load_trained_model(
            source_path,
            configuration,
            normal_label="normal",
            abnormal_label="abnormal",
            expected_sha256=source_hash(source_path),
            artifact_directory=artifact_directory,
            model_key="lightgbm",
            expected_artifact_sha256=report["models"][0]["artifact_sha256"],
        )
