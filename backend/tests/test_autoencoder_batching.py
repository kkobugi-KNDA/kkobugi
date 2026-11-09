"""오차 계산의 메모리 단위만 바뀌고 학습·점수·분류가 같은지 확인한다."""

import joblib
import numpy as np
import pytest
from threadpoolctl import threadpool_limits

from app.model_catalog import NormalOnlyAutoencoder


def full_vector_scores(estimator, features):
    # 변경 전 계산식. 새 계산식과 같은 학습된 가중치로 직접 비교한다.
    scaled = estimator.scaler_.transform(features)
    reconstructed = estimator.network_.predict(scaled).reshape(-1, estimator.n_features_in_)
    return np.mean(np.square(reconstructed - scaled), axis=1)


class FullVectorAutoencoder(NormalOnlyAutoencoder):
    def decision_function(self, features):
        return full_vector_scores(self, features)


@pytest.mark.parametrize("feature_count", [1, 49])
@pytest.mark.filterwarnings("ignore:Stochastic Optimizer:UserWarning")
def test_batch_scores_weights_threshold_labels_and_reload_match(tmp_path, feature_count):
    generator = np.random.default_rng(10)
    train = generator.normal(size=(120, feature_count)).astype(np.float64)
    labels = np.zeros(120, dtype=int)
    labels[-20:] = 1
    # 경계와 마지막 부분 배치까지 모두 확인한다.
    probe = generator.normal(size=(8201, feature_count)).astype(np.float64)
    with threadpool_limits(limits=1):
        reference = FullVectorAutoencoder(42).fit(train, labels)
        actual = NormalOnlyAutoencoder(42).fit(train, labels)
        full = full_vector_scores(actual, probe)
        batched = actual.decision_function(probe)
        np.testing.assert_allclose(batched, full, rtol=1e-12, atol=1e-12)
        assert batched.dtype == np.float64
        assert actual.network_.n_iter_ == reference.network_.n_iter_
        assert actual.network_.get_params() == reference.network_.get_params()
        np.testing.assert_array_equal(actual.scaler_.mean_, reference.scaler_.mean_)
        np.testing.assert_array_equal(actual.scaler_.scale_, reference.scaler_.scale_)
        for actual_weight, reference_weight in zip(
            actual.network_.coefs_, reference.network_.coefs_, strict=True
        ):
            np.testing.assert_array_equal(actual_weight, reference_weight)
        for actual_bias, reference_bias in zip(
            actual.network_.intercepts_, reference.network_.intercepts_, strict=True
        ):
            np.testing.assert_array_equal(actual_bias, reference_bias)
        assert actual.threshold_ == pytest.approx(reference.threshold_, rel=1e-12, abs=1e-12)
        np.testing.assert_array_equal(actual.predict(probe), reference.predict(probe))
        path = tmp_path / "autoencoder.joblib"
        joblib.dump(actual, path)
        restored = joblib.load(path)
        np.testing.assert_array_equal(restored.decision_function(probe), batched)
        np.testing.assert_array_equal(restored.predict(probe), actual.predict(probe))


@pytest.mark.parametrize(
    "bad_features",
    [None, np.empty((0, 2)), np.ones((3, 3)), np.ones(3), np.full((3, 2), np.nan)],
)
@pytest.mark.filterwarnings("ignore:Stochastic Optimizer:UserWarning")
def test_invalid_inputs_keep_full_vector_validation_error(bad_features):
    features = np.arange(40, dtype=float).reshape(20, 2)
    with threadpool_limits(limits=1):
        estimator = NormalOnlyAutoencoder(42).fit(features, np.zeros(20, dtype=int))
        with pytest.raises(ValueError):
            full_vector_scores(estimator, bad_features)
        with pytest.raises(ValueError):
            estimator.decision_function(bad_features)
