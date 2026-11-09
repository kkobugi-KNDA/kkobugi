"""검토에 연결한 모델 결과와 현장 관찰의 지정 버전을 그대로 보관한다."""

import json
import re
from copy import deepcopy
from datetime import datetime

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import Dataset, ObservationHistory
from app.schemas.observations import ObservationResponse
from app.schemas.reviews import (
    CapturedModelResult,
    ModelResultReference,
    ObservationReference,
    ReviewEvidence,
)
from app.schemas.runs import EvaluationMetrics, ModelResult, RunCreate, SplitInfo
from app.services import observations as observation_service
from app.services import runs as run_service
from app.services.series import format_timestamp


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    # 저장 자료가 잘못됐더라도 SQL 인자나 내부 파일 경로는 사용자에게 보내지 않는다.
    return _error(
        503, "REVIEW_EVIDENCE_UNAVAILABLE", "검토 근거의 저장 정보를 확인하지 못했습니다."
    )


def _check_split(split: SplitInfo, row_count: int) -> None:
    # 행 번호는 [시작, 끝)이며 세 분할이 빈틈 없이 원본 행을 나눠야 한다.
    if (
        split.train.start_row != 0
        or split.train.end_row != split.validation.start_row
        or split.validation.end_row != split.test.start_row
        or split.test.end_row != row_count
    ):
        raise ValueError("저장된 분할 범위 오류")
    for part in (split.train, split.validation, split.test):
        if part.end_row <= part.start_row or part.row_count != part.end_row - part.start_row:
            raise ValueError("저장된 분할 행 수 오류")


def _capture_model_result(
    database_session: Session,
    owner_id: int,
    dataset: Dataset,
    start_time: str,
    end_time: str,
    reference: ModelResultReference,
) -> CapturedModelResult:
    model_run = run_service.get_run(database_session, reference.run_id, owner_id)

    if model_run.dataset_id != dataset.id:
        raise _error(422, "REVIEW_CONTEXT_MISMATCH", "같은 CSV의 모델 실행을 연결하세요.")
    if model_run.status != "completed":
        raise _error(409, "RUN_NOT_READY", "학습이 완료된 실행 결과를 연결하세요.")
    if model_run.input_sha256 != dataset.sha256:
        raise _error(422, "REVIEW_SOURCE_MISMATCH", "모델이 학습한 CSV와 검토 자료가 다릅니다.")
    # 조회나 검토 등록만으로 Test 평가를 시작하거나 선택 모델을 바꾸지 않는다.
    if reference.split == "test" and (
        model_run.evaluation_status != "completed"
        or model_run.selected_model != reference.model_key
    ):
        raise _error(409, "TEST_NOT_EVALUATED", "선택한 모델의 Test 평가를 먼저 완료하세요.")
    try:
        configuration = RunCreate.model_validate(model_run.configuration)

        if configuration.dataset_id != dataset.id:
            raise ValueError("저장된 CSV 설정 오류")
        if reference.model_key not in configuration.models:
            raise _error(422, "MODEL_NOT_TRAINED", "이 실행에서 학습한 모델을 연결하세요.")
        training_report = deepcopy(model_run.training_report)

        if not isinstance(training_report, dict):
            raise ValueError("저장된 학습 결과 오류")
        model_results = [ModelResult.model_validate(item) for item in training_report["models"]]

        matching_models = [item for item in model_results if item.model_key == reference.model_key]

        if not matching_models:
            raise _error(422, "MODEL_NOT_TRAINED", "이 실행에서 학습한 모델을 연결하세요.")
        if len(matching_models) != 1:
            raise ValueError("중복된 모델 결과")
        model_result = matching_models[0]

        if re.fullmatch(r"[a-f0-9]{64}", model_result.artifact_sha256) is None:
            raise ValueError("저장된 모델 식별값 오류")
        split = SplitInfo.model_validate(training_report["split"])

        _check_split(split, dataset.inspection["row_count"])
        if model_result.validation_metrics.sample_count != split.validation.row_count:
            raise ValueError("검증 지표의 표본 수 오류")
        start_bound = datetime.fromisoformat(start_time)

        end_bound = datetime.fromisoformat(end_time)

        if (start_bound.tzinfo is None) != (configuration.train_end.tzinfo is None):
            raise ValueError("저장된 시간대 설정 오류")
        if reference.split == "validation":
            if start_bound <= configuration.train_end or end_bound > configuration.validation_end:
                raise _error(
                    422, "REVIEW_OUTSIDE_SPLIT", "검토 구간을 해당 Valid 기간 안에 지정하세요."
                )
            metrics = model_result.validation_metrics

            partition = split.validation

        else:
            if start_bound <= configuration.validation_end:
                raise _error(
                    422, "REVIEW_OUTSIDE_SPLIT", "검토 구간을 해당 Test 기간 안에 지정하세요."
                )
            # 평가 결과는 지표 자체로 저장되며 연결 모델은 selected_model이 식별한다.
            metrics = EvaluationMetrics.model_validate(model_run.evaluation_report)

            partition = split.test

            if metrics.sample_count != partition.row_count:
                raise ValueError("시험 지표의 표본 수 오류")
        evidence = CapturedModelResult(
            run_id=model_run.id,
            model_key=reference.model_key,
            split=reference.split,
            display_name=model_result.display_name,
            input_sha256=model_run.input_sha256,
            artifact_sha256=model_result.artifact_sha256,
            feature_columns=configuration.feature_columns,
            train_end=format_timestamp(configuration.train_end),
            validation_end=format_timestamp(configuration.validation_end),
            partition=partition,
            partition_metrics=metrics,
            metrics_scope="full_partition",
            parameters=model_result.parameters,
            environment=training_report["environment"],
        )

        # NaN·Infinity 같은 값은 정상 JSON 근거나 정상 수치처럼 저장하지 않는다.
        json.dumps(evidence.model_dump(mode="json"), allow_nan=False)
        return evidence
    except (KeyError, TypeError, ValueError, OverflowError, ValidationError):
        raise _unavailable() from None


def _capture_observation(
    database_session: Session,
    owner_id: int,
    dataset: Dataset,
    channel: str,
    start_time: str,
    end_time: str,
    reference: ObservationReference,
) -> ObservationResponse:
    # 현재 기록에서 소유자를 먼저 확인하고, 내용은 요청한 과거 수정본에서 읽는다.
    observation_service.get_observation(database_session, reference.observation_id, owner_id)
    try:
        history = database_session.scalar(
            select(ObservationHistory).where(
                ObservationHistory.observation_id == reference.observation_id,
                ObservationHistory.revision == reference.revision,
            )
        )

        if history is None:
            raise _error(
                422, "OBSERVATION_REVISION_NOT_FOUND", "저장된 현장 관찰의 수정 번호를 지정하세요."
            )
        snapshot = ObservationResponse.model_validate(history.snapshot)

        if (
            snapshot.id != reference.observation_id
            or snapshot.revision != reference.revision
            or snapshot.author.id != owner_id
            or snapshot.last_editor.id != history.changed_by_id
        ):
            raise ValueError("관찰 이력 식별값 오류")
        if snapshot.dataset_id != dataset.id or snapshot.channel != channel:
            raise _error(422, "REVIEW_CONTEXT_MISMATCH", "같은 CSV·채널의 현장 관찰을 연결하세요.")
        observation_start = datetime.fromisoformat(snapshot.start_time)

        observation_end = datetime.fromisoformat(snapshot.end_time)

        review_start = datetime.fromisoformat(start_time)

        review_end = datetime.fromisoformat(end_time)

        if (
            (observation_start.tzinfo is None) != (review_start.tzinfo is None)
            or (observation_end.tzinfo is None) != (review_start.tzinfo is None)
            or observation_start > observation_end
        ):
            raise ValueError("관찰 이력 시간 오류")
        if observation_start > review_end or observation_end < review_start:
            raise _error(
                422, "REVIEW_CONTEXT_MISMATCH", "검토 시간과 겹치는 현장 관찰을 연결하세요."
            )
        return snapshot
    except (SQLAlchemyError, KeyError, TypeError, ValueError, OverflowError, ValidationError):
        raise _unavailable() from None


def capture_evidence(
    database_session: Session,
    owner_id: int,
    dataset: Dataset,
    channel: str,
    start_time: str,
    end_time: str,
    model_reference: ModelResultReference | None,
    observation_references: list[ObservationReference],
) -> ReviewEvidence:
    """최신값을 추측하지 않고 명시한 실행·모델·관찰 수정본을 검토 근거로 묶는다."""

    if dataset.owner_id != owner_id:
        raise _error(404, "DATASET_NOT_FOUND", "CSV 자료를 찾을 수 없습니다.")
    if len(observation_references) > 50 or len(
        {reference.observation_id for reference in observation_references}
    ) != len(observation_references):
        raise _error(422, "INVALID_REVIEW_EVIDENCE", "중복 없이 현장 관찰을 50개까지 연결하세요.")
    model_result = (
        _capture_model_result(
            database_session, owner_id, dataset, start_time, end_time, model_reference
        )
        if model_reference is not None
        else None
    )

    observations = [
        _capture_observation(
            database_session, owner_id, dataset, channel, start_time, end_time, reference
        )
        for reference in observation_references
    ]

    # CSV 라벨·모델 파일·관찰 원본은 바꾸지 않고 검토에 남길 사본만 반환한다.
    return ReviewEvidence(model_result=model_result, observations=observations)
