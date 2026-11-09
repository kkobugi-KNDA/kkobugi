"""허용한 모델의 설정과 정상 Train만 학습하는 AutoEncoder를 관리한다."""

import numpy as np
from sklearn.dummy import DummyClassifier
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

from app.schemas.runs import ModelCatalog, ModelDefinition, ModelKey


class NormalOnlyAutoencoder:
    """정상 Train의 재구성 오차를 기준으로 이상 후보를 분류한다."""

    def __init__(self, random_seed: int):
        self.random_seed = random_seed

    def fit(self, features: np.ndarray, labels: np.ndarray):
        normal_features = features[labels == 0]

        if len(normal_features) < 2:
            raise ValueError("AutoEncoder 학습에는 Train의 정상 표본이 두 개 이상 필요합니다.")

        # 스케일러와 재구성 신경망 모두 정상 Train만 확인한다.
        self.scaler_ = StandardScaler()

        normal_scaled = self.scaler_.fit_transform(normal_features)

        self.n_features_in_ = features.shape[1]

        self.hidden_layer_sizes_ = (32, min(8, max(1, self.n_features_in_ // 2)), 32)

        self.network_ = MLPRegressor(
            hidden_layer_sizes=self.hidden_layer_sizes_,
            max_iter=100,
            early_stopping=False,
            shuffle=False,
            random_state=self.random_seed,
        )

        reconstruction_target = normal_scaled.ravel() if self.n_features_in_ == 1 else normal_scaled

        self.network_.fit(normal_scaled, reconstruction_target)
        normal_errors = self.decision_function(normal_features)

        # Valid/Test를 보면서 기준을 바꾸지 않고 정상 Train의 99분위를 고정한다.
        self.threshold_ = float(np.quantile(normal_errors, 0.99))

        return self

    def decision_function(self, features: np.ndarray) -> np.ndarray:
        scaled_features = self.scaler_.transform(features)

        reconstructed_features = self.network_.predict(scaled_features).reshape(
            -1, self.n_features_in_
        )

        # 점수는 고장 확률이 아니라 스케일된 채널의 평균 제곱 재구성 오차다.
        return np.mean(np.square(reconstructed_features - scaled_features), axis=1)

    def predict(self, features: np.ndarray) -> np.ndarray:
        return (self.decision_function(features) > self.threshold_).astype(int)


def get_model_catalog() -> ModelCatalog:
    return ModelCatalog(
        items=[
            ModelDefinition(
                key="xgboost",
                display_name="XGBoost",
                kind="classifier",
                description="같은 시간 분할에서 학습하는 지도 분류 모델",
                parameters={
                    "n_estimators": 100,
                    "max_depth": 4,
                    "learning_rate": 0.1,
                    "tree_method": "hist",
                    "n_jobs": 1,
                    "random_state": 42,
                },
            ),
            ModelDefinition(
                key="lightgbm",
                display_name="LightGBM",
                kind="classifier",
                description="같은 시간 분할에서 학습하는 지도 분류 모델",
                parameters={
                    "n_estimators": 100,
                    "max_depth": 4,
                    "num_leaves": 15,
                    "learning_rate": 0.1,
                    "min_child_samples": 20,
                    "n_jobs": 1,
                    "deterministic": True,
                    "force_col_wise": True,
                    "verbosity": -1,
                    "random_state": 42,
                },
            ),
            ModelDefinition(
                key="autoencoder",
                display_name="AutoEncoder",
                kind="anomaly_detector",
                description="정상 Train으로 재구성 신경망과 99분위 기준을 학습하는 이상 탐지 모델",
                parameters={
                    "training_scope": "normal_train_only",
                    "scaler": "StandardScaler",
                    "hidden_layer_sizes": "32 → min(8, max(1, feature_count // 2)) → 32",
                    "max_iter": 100,
                    "early_stopping": False,
                    "shuffle": False,
                    "threshold_quantile": 0.99,
                    "score_type": "reconstruction_error",
                    "random_state": 42,
                },
            ),
        ]
    )


def create_estimator(model_key: ModelKey, random_seed: int):
    # 외부 모듈명이나 사용자가 올린 pickle은 실행하지 않는다.
    # 이전에 저장한 Dummy 실행을 검증하는 내부 호환 경로이며 새 목록에는 노출하지 않는다.
    if model_key == "dummy":
        return DummyClassifier(strategy="most_frequent", random_state=random_seed)
    if model_key == "xgboost":
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=100,
            max_depth=4,
            learning_rate=0.1,
            tree_method="hist",
            n_jobs=1,
            random_state=random_seed,
        )
    if model_key == "lightgbm":
        from lightgbm import LGBMClassifier

        # CPU 한 스레드와 고정 시드를 사용해 같은 분할의 비교 조건을 유지한다.
        return LGBMClassifier(
            n_estimators=100,
            max_depth=4,
            num_leaves=15,
            learning_rate=0.1,
            min_child_samples=20,
            n_jobs=1,
            deterministic=True,
            force_col_wise=True,
            verbosity=-1,
            random_state=random_seed,
        )
    if model_key == "autoencoder":
        return NormalOnlyAutoencoder(random_seed=random_seed)
    raise ValueError("지원하는 모델을 선택하세요.")
