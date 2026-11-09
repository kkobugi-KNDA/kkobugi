"""계정별 실행 기록과 한 번에 하나씩 처리하는 학습·평가 대기열."""

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database
from app.models import Dataset, ModelRun, User
from app.schemas.runs import (
    EvaluationMetrics,
    EvaluationResponse,
    ModelKey,
    ModelResult,
    RankingMetric,
    RunCreate,
    RunDetail,
    RunList,
    RunResults,
    RunSummary,
    SplitInfo,
)
from app.services import datasets as dataset_service
from app.services import modeling

logger = logging.getLogger(__name__)

_RUN_ID_PATTERN = re.compile(r"[a-f0-9]{32}")


def _run_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def _unavailable() -> HTTPException:
    # 파일 경로, SQL 인자와 내부 예외 원문은 API 응답에 포함하지 않는다.
    return _run_error(503, "RUN_UNAVAILABLE", "모델 실행 정보를 처리하지 못했습니다.")


def _commit(database_session: Session) -> None:
    try:
        database_session.commit()
    except SQLAlchemyError:
        database_session.rollback()
        raise _unavailable() from None


def get_run(database_session: Session, run_id: str, owner_id: int) -> ModelRun:
    try:
        # 같은 요청에서 이미 읽은 객체가 있어도 최신 평가 잠금 상태를 다시 읽는다.
        model_run = database_session.scalar(
            select(ModelRun)
            .where(ModelRun.id == run_id, ModelRun.owner_id == owner_id)
            .execution_options(populate_existing=True)
        )

    except SQLAlchemyError:
        raise _unavailable() from None
    if model_run is None:
        raise _run_error(404, "RUN_NOT_FOUND", "모델 실행 기록을 찾을 수 없습니다.")
    return model_run


def run_summary(model_run: ModelRun) -> RunSummary:
    training_report = model_run.training_report or {}

    return RunSummary(
        id=model_run.id,
        dataset_id=model_run.dataset_id,
        owner_id=model_run.owner_id,
        status=model_run.status,
        created_at=model_run.created_at,
        updated_at=model_run.updated_at,
        selected_model=model_run.selected_model,
        evaluation_status=model_run.evaluation_status,
        completed_models=len(training_report.get("models", [])),
        total_models=len(model_run.configuration["models"]),
        error_message=model_run.error_message,
    )


def run_detail(model_run: ModelRun) -> RunDetail:
    try:
        training_report = model_run.training_report or {}

        return RunDetail(
            run=run_summary(model_run),
            configuration=RunCreate.model_validate(model_run.configuration),
            input_sha256=model_run.input_sha256,
            split=SplitInfo.model_validate(training_report["split"])
            if training_report.get("split") is not None
            else None,
            environment=training_report.get("environment", {}),
            warnings=training_report.get("warnings", []),
        )
    except (ValidationError, KeyError, TypeError):
        raise _unavailable() from None


def list_runs(database_session: Session, owner_id: int, limit: int, offset: int) -> RunList:
    try:
        total = database_session.scalar(
            select(func.count()).select_from(ModelRun).where(ModelRun.owner_id == owner_id)
        )

        model_runs = database_session.scalars(
            select(ModelRun)
            .where(ModelRun.owner_id == owner_id)
            .order_by(ModelRun.created_at.desc(), ModelRun.id.desc())
            .limit(limit)
            .offset(offset)
        ).all()

        return RunList(
            items=[run_summary(model_run) for model_run in model_runs],
            total=total or 0,
            limit=limit,
            offset=offset,
        )
    except (SQLAlchemyError, ValidationError, KeyError, TypeError):
        raise _unavailable() from None


def get_results(model_run: ModelRun, sort_by: RankingMetric | None = None) -> RunResults:
    metric = sort_by or model_run.configuration["ranking_metric"]

    training_report = model_run.training_report or {}

    try:
        model_results = [
            ModelResult.model_validate(result) for result in training_report.get("models", [])
        ]

    except ValidationError:
        raise _unavailable() from None

    # 정의되지 않는 지표는 마지막에 두고, Test 평가 결과는 정렬에 사용하지 않는다.
    model_results.sort(
        key=lambda result: (
            getattr(result.validation_metrics, metric) is None,
            -(getattr(result.validation_metrics, metric) or 0),
        )
    )
    ranked_results = []

    for position, model_result in enumerate(model_results, start=1):
        sort_value = getattr(model_result.validation_metrics, metric)

        ranked_results.append(
            model_result.model_copy(
                update={
                    "rank": position if sort_value is not None else None,
                    "sort_value": sort_value,
                }
            )
        )
    return RunResults(
        run_id=model_run.id,
        status=model_run.status,
        metric=metric,
        items=ranked_results,
        selected_model=model_run.selected_model,
    )


def get_evaluation(model_run: ModelRun) -> EvaluationResponse:
    try:
        return EvaluationResponse(
            run_id=model_run.id,
            status=model_run.evaluation_status,
            model_key=model_run.selected_model,
            metrics=EvaluationMetrics.model_validate(model_run.evaluation_report)
            if model_run.evaluation_report is not None
            else None,
            error_message=model_run.evaluation_error,
        )
    except ValidationError:
        raise _unavailable() from None


class RunManager:
    """단일 API 프로세스에서 대기열과 모델 선택·평가 경합을 관리한다."""

    def __init__(self, database: Database, settings: Settings):
        self.database = database

        self.settings = settings

        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kkobugi-model")

        self._lock = threading.Lock()

        self._closed = False

    def recover_interrupted(self) -> None:
        # 완료한 결과는 그대로 두고, 이전 프로세스에서 끝내지 못한 작업만 실패로 표시한다.
        with self.database.session_factory() as database_session:
            database_session.execute(
                update(ModelRun)
                .where(ModelRun.status.in_(["queued", "running"]))
                .values(
                    status="failed",
                    error_message="서버 재시작으로 학습이 중단됐습니다. 새 실행을 등록하세요.",
                    updated_at=int(time.time()),
                )
            )
            database_session.execute(
                update(ModelRun)
                .where(ModelRun.evaluation_status.in_(["queued", "running"]))
                .values(
                    evaluation_status="failed",
                    evaluation_error="서버 재시작으로 시험 평가가 중단됐습니다.",
                    updated_at=int(time.time()),
                )
            )
            _commit(database_session)

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True

        # 작업의 DB 연결을 먼저 정리한 뒤 앱이 전체 DB 연결을 닫도록 기다린다.
        self._executor.shutdown(wait=True)

    def _check_capacity(self, database_session: Session) -> None:
        if self._closed:
            raise _unavailable()

        pending_count = database_session.scalar(
            select(func.count())
            .select_from(ModelRun)
            .where(
                or_(
                    ModelRun.status.in_(["queued", "running"]),
                    ModelRun.evaluation_status.in_(["queued", "running"]),
                )
            )
        )

        if (pending_count or 0) >= self.settings.max_pending_runs:
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "RUN_QUEUE_FULL",
                    "message": "학습 대기열이 찼습니다. 잠시 후 다시 실행하세요.",
                },
                headers={"Retry-After": "30"},
            )

    def create_run(
        self, database_session: Session, current_user: User, request: RunCreate
    ) -> RunDetail:
        with self._lock:
            try:
                dataset = dataset_service.get_dataset(
                    database_session, request.dataset_id, current_user.id
                )

                inspection = dataset_service.dataset_detail(dataset).inspection

                if not inspection.is_valid:
                    raise _run_error(
                        422, "DATASET_NOT_READY", "CSV 검사에서 확인할 항목을 먼저 수정하세요."
                    )
                if inspection.row_count > self.settings.max_training_rows:
                    raise _run_error(
                        413, "TRAINING_DATA_TOO_LARGE", "학습 가능한 최대 행 수를 초과했습니다."
                    )
                if len(request.feature_columns) > self.settings.max_training_features:
                    raise _run_error(
                        422, "INVALID_FEATURES", "학습 가능한 최대 채널 수를 초과했습니다."
                    )
                if not set(request.feature_columns).issubset(inspection.channels):
                    raise _run_error(
                        422, "INVALID_FEATURES", "CSV의 숫자 채널에서 학습할 특징을 선택하세요."
                    )

                self._check_capacity(database_session)
                dataset_service.dataset_file_path(dataset, self.settings)

                model_run = ModelRun(
                    id=uuid4().hex,
                    owner_id=current_user.id,
                    dataset_id=dataset.id,
                    configuration=request.model_dump(mode="json"),
                    input_sha256=dataset.sha256,
                )

                database_session.add(model_run)
                _commit(database_session)
                try:
                    self._executor.submit(self._train_run, model_run.id)
                except RuntimeError:
                    model_run.status = "failed"

                    model_run.error_message = (
                        "학습 작업을 시작하지 못했습니다. 새 실행을 등록하세요."
                    )

                    _commit(database_session)
                    raise _unavailable() from None
                return run_detail(model_run)
            except SQLAlchemyError:
                database_session.rollback()
                raise _unavailable() from None

    def select_model(
        self, database_session: Session, run_id: str, owner_id: int, model_key: ModelKey
    ) -> RunDetail:
        # 선택과 평가 시작이 동시에 들어와도 잠금 이후 모델이 바뀌지 않게 한다.
        with self._lock:
            model_run = get_run(database_session, run_id, owner_id)

            if model_run.status != "completed":
                raise _run_error(409, "RUN_NOT_READY", "학습이 완료된 뒤 모델을 선택하세요.")
            if model_key not in {
                result["model_key"]
                for result in (model_run.training_report or {}).get("models", [])
            }:
                raise _run_error(
                    422, "MODEL_NOT_AVAILABLE", "이번 실행에서 학습한 모델을 선택하세요."
                )
            if model_run.selected_model == model_key:
                return run_detail(model_run)
            if model_run.evaluation_status != "not_started":
                raise _run_error(
                    409,
                    "MODEL_SELECTION_LOCKED",
                    "시험 평가를 시작한 실행은 모델을 바꿀 수 없습니다.",
                )
            try:
                changed_rows = database_session.execute(
                    update(ModelRun)
                    .where(ModelRun.id == run_id, ModelRun.evaluation_status == "not_started")
                    .values(selected_model=model_key, updated_at=int(time.time()))
                ).rowcount

                if changed_rows != 1:
                    database_session.rollback()
                    raise _run_error(
                        409, "MODEL_SELECTION_LOCKED", "시험 평가가 시작돼 모델 선택이 잠겼습니다."
                    )
                _commit(database_session)
            except SQLAlchemyError:
                database_session.rollback()
                raise _unavailable() from None
            return run_detail(get_run(database_session, run_id, owner_id))

    def start_evaluation(
        self, database_session: Session, current_user: User, run_id: str
    ) -> tuple[EvaluationResponse, bool]:
        with self._lock:
            model_run = get_run(database_session, run_id, current_user.id)

            if model_run.status != "completed" or model_run.selected_model is None:
                raise _run_error(409, "MODEL_NOT_SELECTED", "학습 결과에서 모델을 먼저 선택하세요.")
            if model_run.evaluation_status == "completed":
                return get_evaluation(model_run), False
            if model_run.evaluation_status in {"queued", "running"}:
                return get_evaluation(model_run), True
            if model_run.evaluation_status == "failed":
                raise _run_error(
                    409,
                    "EVALUATION_FAILED",
                    "이 실행의 시험 평가는 실패했습니다. 실패 내용을 확인하세요.",
                )
            try:
                self._check_capacity(database_session)

                changed_rows = database_session.execute(
                    update(ModelRun)
                    .where(
                        ModelRun.id == run_id,
                        ModelRun.evaluation_status == "not_started",
                        ModelRun.selected_model == model_run.selected_model,
                    )
                    .values(evaluation_status="queued", updated_at=int(time.time()))
                ).rowcount

                if changed_rows != 1:
                    database_session.rollback()
                    raise _run_error(
                        409, "EVALUATION_ALREADY_STARTED", "시험 평가 상태를 다시 확인하세요."
                    )
                _commit(database_session)
                try:
                    self._executor.submit(self._evaluate_run, run_id)
                except RuntimeError:
                    model_run.evaluation_status = "failed"

                    model_run.evaluation_error = "시험 평가 작업을 시작하지 못했습니다."

                    _commit(database_session)
                    raise _unavailable() from None
                return get_evaluation(get_run(database_session, run_id, current_user.id)), True
            except SQLAlchemyError:
                database_session.rollback()
                raise _unavailable() from None

    def _artifact_directory(self, run_id: str) -> Path:
        if not _RUN_ID_PATTERN.fullmatch(run_id):
            raise ValueError("모델 실행 ID가 올바르지 않습니다.")

        storage_directory = self.settings.model_storage_path.resolve()

        artifact_directory = (storage_directory / run_id).resolve()

        if artifact_directory.parent != storage_directory:
            raise ValueError("모델 저장 위치를 확인할 수 없습니다.")
        return artifact_directory

    def _clean_new_artifacts(self, artifact_directory: Path) -> None:
        # 이 작업이 새로 만든 폴더만 전달받는다. 재귀 삭제로 기존 자료를 지우지 않는다.
        expected_parent = self.settings.model_storage_path.resolve()

        if artifact_directory.resolve().parent != expected_parent:
            return
        try:
            for file_path in artifact_directory.iterdir():
                if file_path.is_file() or file_path.is_symlink():
                    file_path.unlink()
            artifact_directory.rmdir()
        except OSError:
            logger.warning("실패한 모델 실행의 임시 파일을 정리하지 못했습니다.")

    def _mark_failure(self, run_id: str, message: str, *, evaluation: bool = False) -> None:
        try:
            with self.database.session_factory() as database_session:
                model_run = database_session.get(ModelRun, run_id)

                if model_run is None:
                    return
                if evaluation:
                    model_run.evaluation_status = "failed"

                    model_run.evaluation_error = message

                else:
                    model_run.status = "failed"

                    model_run.error_message = message

                model_run.updated_at = int(time.time())

                database_session.commit()
        except SQLAlchemyError:
            logger.exception("실패한 모델 실행 상태를 저장하지 못했습니다.")

    def _train_run(self, run_id: str) -> None:
        new_artifact_directory: Path | None = None

        try:
            with self.database.session_factory() as database_session:
                changed_rows = database_session.execute(
                    update(ModelRun)
                    .where(ModelRun.id == run_id, ModelRun.status == "queued")
                    .values(status="running", updated_at=int(time.time()))
                ).rowcount

                database_session.commit()
                if changed_rows != 1:
                    return

                model_run = database_session.get(ModelRun, run_id)

                dataset = database_session.get(Dataset, model_run.dataset_id)

                configuration = RunCreate.model_validate(model_run.configuration)

                artifact_directory = self._artifact_directory(run_id)

                artifact_directory.parent.mkdir(parents=True, exist_ok=True)
                artifact_directory.mkdir(exist_ok=False)
                new_artifact_directory = artifact_directory

                training_report = modeling.train_models(
                    dataset_service.dataset_file_path(dataset, self.settings),
                    configuration,
                    normal_label=dataset.normal_label,
                    abnormal_label=dataset.abnormal_label,
                    timestamp_column=dataset.timestamp_column,
                    label_column=dataset.label_column,
                    expected_sha256=model_run.input_sha256,
                    artifact_directory=artifact_directory,
                )

                model_run.training_report = training_report

                model_run.status = "completed"

                model_run.updated_at = int(time.time())

                database_session.commit()
                new_artifact_directory = None

        except ValueError as error:
            self._mark_failure(run_id, str(error)[:500])
        except Exception:
            logger.exception("모델 학습에 실패했습니다.")
            self._mark_failure(
                run_id, "모델 학습을 완료하지 못했습니다. 데이터와 설정을 확인하세요."
            )
        finally:
            if new_artifact_directory is not None:
                self._clean_new_artifacts(new_artifact_directory)

    def _evaluate_run(self, run_id: str) -> None:
        try:
            with self.database.session_factory() as database_session:
                changed_rows = database_session.execute(
                    update(ModelRun)
                    .where(ModelRun.id == run_id, ModelRun.evaluation_status == "queued")
                    .values(evaluation_status="running", updated_at=int(time.time()))
                ).rowcount

                database_session.commit()
                if changed_rows != 1:
                    return

                model_run = database_session.get(ModelRun, run_id)

                dataset = database_session.get(Dataset, model_run.dataset_id)

                configuration = RunCreate.model_validate(model_run.configuration)

                selected_result = next(
                    result
                    for result in model_run.training_report["models"]
                    if result["model_key"] == model_run.selected_model
                )

                # 모델을 다시 학습하지 않고, 사용자가 고른 저장 모델만 Test에 적용한다.
                evaluation = modeling.evaluate_model(
                    dataset_service.dataset_file_path(dataset, self.settings),
                    configuration,
                    normal_label=dataset.normal_label,
                    abnormal_label=dataset.abnormal_label,
                    timestamp_column=dataset.timestamp_column,
                    label_column=dataset.label_column,
                    expected_sha256=model_run.input_sha256,
                    artifact_directory=self._artifact_directory(run_id),
                    model_key=model_run.selected_model,
                    expected_artifact_sha256=selected_result["artifact_sha256"],
                )

                model_run.evaluation_report = evaluation.model_dump()

                model_run.evaluation_status = "completed"

                model_run.updated_at = int(time.time())

                database_session.commit()
        except ValueError as error:
            self._mark_failure(run_id, str(error)[:500], evaluation=True)
        except Exception:
            logger.exception("모델 시험 평가에 실패했습니다.")
            self._mark_failure(
                run_id,
                "시험 평가를 완료하지 못했습니다. 입력 파일과 모델을 확인하세요.",
                evaluation=True,
            )
