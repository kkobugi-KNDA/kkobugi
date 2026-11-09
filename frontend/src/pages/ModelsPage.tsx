import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Cpu,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  WandSparkles,
} from 'lucide-react';
import { Badge, EmptyState, Field, Modal, Notice, PageHeader } from '../components/ui';
import { useApp } from '../context/AppContext';
import { useExpertise } from '../context/ExpertiseContext';
import { DEMO_DATASET_DETAIL, DEMO_RESULTS, DEMO_RUN_DETAIL } from '../data/demo';
import { api, errorMessage } from '../lib/api';
import { csvTime, dateTime, number } from '../lib/format';
import {
  prepareTraining,
  type TrainingConfiguration,
  type TrainingModel,
  type TrainingPlan,
} from '../lib/training-api';
import type {
  DatasetDetail,
  EvaluationMetrics,
  EvaluationResponse,
  ModelKey,
  RunDetail,
  RunResults,
  TrainingProgressEvent,
  TrainingStage,
} from '../types';
import './data-models.css';
import './training.css';

const MODEL_NAMES: Record<ModelKey, string> = {
  xgboost: 'XGBoost',
  autoencoder: 'AutoEncoder',
  lightgbm: 'LightGBM',
  dummy: 'DummyClassifier',
};

const RUN_STATUS_NAMES = {
  queued: '대기 중',
  running: '학습 중',
  completed: '학습 완료',
  failed: '학습 실패',
};

const TRAINING_STAGES: {
  key: TrainingStage;
  simple: string;
  expert: string;
  description: string;
}[] = [
  {
    key: 'data_check',
    simple: '원본 확인',
    expert: '데이터 무결성 검사',
    description: '등록한 CSV가 그대로인지 확인해요.',
  },
  {
    key: 'split',
    simple: '데이터 나누기',
    expert: '시간순 Train·Valid·Test 분할',
    description: '학습할 과거와 확인할 뒷부분을 나눠요.',
  },
  {
    key: 'input_preparation',
    simple: '학습 자료 준비',
    expert: '입력 행렬·라벨 준비',
    description: '선택한 채널을 모델에 넣을 자료로 준비해요.',
  },
  {
    key: 'training',
    simple: '모델 학습',
    expert: '모델 fit',
    description: '선택한 모델이 학습 구간의 패턴을 배워요.',
  },
  {
    key: 'validation',
    simple: '중간 확인',
    expert: 'Valid 추론·지표 계산',
    description: '학습에 쓰지 않은 구간에서 결과를 확인해요.',
  },
  {
    key: 'saving',
    simple: '모델 저장',
    expert: '아티팩트·설정 저장',
    description: '만들어진 모델과 사용한 설정을 저장해요.',
  },
  {
    key: 'completed',
    simple: '학습 완료',
    expert: '학습 작업 완료',
    description: '저장까지 끝나면 최종 확인을 시작할 수 있어요.',
  },
];

const DEFAULT_OPTIONS = {
  xgboost: { n_estimators: 100, max_depth: 4, learning_rate: 0.1 },
  autoencoder: { max_iter: 100, hidden_size: 32, threshold_quantile: 0.99 },
};

const OPTION_FIELDS: Record<
  TrainingModel,
  { key: string; label: string; min: number; max: number; step: number }[]
> = {
  xgboost: [
    { key: 'n_estimators', label: '트리 수 · n_estimators', min: 20, max: 300, step: 1 },
    { key: 'max_depth', label: '트리 깊이 · max_depth', min: 2, max: 8, step: 1 },
    { key: 'learning_rate', label: '학습률 · learning_rate', min: 0.01, max: 0.3, step: 0.01 },
  ],
  autoencoder: [
    { key: 'max_iter', label: '반복 수 · max_iter', min: 20, max: 200, step: 1 },
    { key: 'hidden_size', label: '은닉층 크기 · hidden_size', min: 8, max: 64, step: 1 },
    {
      key: 'threshold_quantile',
      label: '오차 기준 분위수 · threshold_quantile',
      min: 0.95,
      max: 0.999,
      step: 0.001,
    },
  ],
};

function metric(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '평가 근거 부족' : value.toFixed(3);
}

function progressMessage(message: string, isExpert: boolean): string {
  return isExpert
    ? message
    : message
        .replace(
          'Train을 사용한 모델 학습이 끝났습니다.',
          '학습 자료로 모델을 만드는 작업을 마쳤어요.',
        )
        .replace('Valid·Test는 학습에 넣지 않습니다.', '중간·최종 확인 자료는 학습에 넣지 않아요.')
        .replace(/\bTrain\b/g, '학습 구간')
        .replace(/\bValid\b/g, '중간 확인')
        .replace(/\bTest\b/g, '최종 확인');
}

function TrainingProcess({
  detail,
  filename,
  isExpert,
}: {
  detail: RunDetail;
  filename: string;
  isExpert: boolean;
}) {
  const events = detail.training_progress || [];

  const latestEvents = new Map<TrainingStage, TrainingProgressEvent>();

  for (const event of events) latestEvents.set(event.stage, event);
  return (
    <section className="training-process" aria-label="실제 학습 과정">
      <div className="section-heading">
        <h3>{isExpert ? '실제 학습 파이프라인' : '모델이 만들어지는 과정'}</h3>
        <small>서버에서 기록한 진행 상태</small>
      </div>
      {!events.length ? (
        <Notice>
          {detail.run.status === 'queued'
            ? '학습 순서를 기다리고 있어요. 서버가 작업을 시작하면 실제 진행 기록을 표시해요.'
            : detail.run.status === 'running'
              ? '첫 진행 기록을 기다리고 있어요. 서버에서 완료한 단계부터 표시합니다.'
              : '이 실행에는 단계별 진행 기록이 없어요. 저장된 전체 상태만 확인할 수 있어요.'}
        </Notice>
      ) : (
        <>
          <ol className="training-process-steps" aria-label="실제 학습 단계">
            {TRAINING_STAGES.map((stage) => {
              const event = latestEvents.get(stage.key);

              const status = event?.status || 'unrecorded';

              return (
                <li
                  key={stage.key}
                  className={`stage-${status}`}
                  aria-label={`${isExpert ? stage.expert : stage.simple}: ${{ running: '진행 중', completed: '완료', failed: '실패', unrecorded: '기록 없음' }[status]}`}
                >
                  <span className="training-process-icon">
                    {status === 'running' ? (
                      <LoaderCircle size={16} className="dm-spin" />
                    ) : status === 'completed' ? (
                      <Check size={16} />
                    ) : status === 'failed' ? (
                      '!'
                    ) : (
                      '·'
                    )}
                  </span>
                  <strong>{isExpert ? stage.expert : stage.simple}</strong>
                  <small>
                    {
                      {
                        running: '진행 중',
                        completed: '완료',
                        failed: '실패',
                        unrecorded: '기록 없음',
                      }[status]
                    }
                  </small>
                  {event && <p>{progressMessage(event.message, isExpert)}</p>}
                </li>
              );
            })}
          </ol>
          <details className="training-process-log">
            <summary>실제 진행 기록과 사용한 설정</summary>
            <dl className="training-process-settings">
              <dt>데이터셋</dt>
              <dd>{filename}</dd>
              <dt>모델</dt>
              <dd>{detail.configuration.models.map((key) => MODEL_NAMES[key]).join(' · ')}</dd>
              <dt>{isExpert ? 'Train 종료' : '학습에 사용한 마지막 시각'}</dt>
              <dd>{csvTime(detail.configuration.train_end)}</dd>
              <dt>{isExpert ? 'Valid 종료' : '중간 확인에 사용한 마지막 시각'}</dt>
              <dd>{csvTime(detail.configuration.validation_end)}</dd>
              <dt>입력 채널</dt>
              <dd>{detail.configuration.feature_columns.join(', ')}</dd>
            </dl>
            {isExpert && (
              <pre>
                {JSON.stringify(
                  {
                    random_seed: detail.configuration.random_seed,
                    model_options:
                      (detail.configuration as TrainingConfiguration).model_options || {},
                  },
                  null,
                  2,
                )}
              </pre>
            )}
            <ol className="training-event-timeline" aria-label="서버의 실제 진행 기록">
              {events.map((event, index) => (
                <li key={index}>
                  <time dateTime={new Date(event.timestamp * 1000).toISOString()}>
                    {new Date(event.timestamp * 1000).toLocaleString('ko-KR', {
                      timeZone: 'Asia/Seoul',
                      hour12: false,
                    })}
                  </time>
                  <strong>
                    {
                      TRAINING_STAGES.find((stage) => stage.key === event.stage)?.[
                        isExpert ? 'expert' : 'simple'
                      ]
                    }{' '}
                    · {{ running: '시작', completed: '완료', failed: '실패' }[event.status]}
                    {event.model_key ? ` · ${MODEL_NAMES[event.model_key]}` : ''}
                  </strong>
                  <p>{progressMessage(event.message, isExpert)}</p>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}

// 두 설명 방식은 같은 평가값을 사용한다. 점수는 고장 확률을 뜻하지 않는다.
export function learningScore(metrics: EvaluationMetrics): number | null {
  return metrics.f1 == null || !Number.isFinite(metrics.f1)
    ? null
    : Math.round(metrics.f1 * 1000) / 10;
}

type ResultMetricKey = 'recall' | 'precision' | 'f1' | 'accuracy' | 'roc_auc' | 'average_precision';

/** 계산되지 않은 지표는 0으로 바꾸지 않고, 해당 지표에 필요한 기록을 설명한다. */
function unavailableMetricReason(key: ResultMetricKey, metrics: EvaluationMetrics): string {
  if (metrics[key] != null && Number.isFinite(metrics[key])) return '';

  const actualNormal =
    (metrics.confusion_matrix[0]?.[0] ?? 0) + (metrics.confusion_matrix[0]?.[1] ?? 0);

  const actualAbnormal =
    (metrics.confusion_matrix[1]?.[0] ?? 0) + (metrics.confusion_matrix[1]?.[1] ?? 0);

  const predictedAbnormal =
    (metrics.confusion_matrix[0]?.[1] ?? 0) + (metrics.confusion_matrix[1]?.[1] ?? 0);

  if (key === 'recall' && actualAbnormal === 0)
    return '실제 이상이 0행이라 이상을 얼마나 찾았는지 계산할 수 없어요.';
  if (key === 'precision' && predictedAbnormal === 0)
    return '이상으로 예측한 행이 0행이라 그중 실제 이상인 비율을 계산할 수 없어요.';
  if (key === 'f1' && actualAbnormal === 0 && predictedAbnormal === 0)
    return '실제 이상과 예측 이상이 모두 0행이라 이상 탐지 F1을 계산할 수 없어요.';
  if (key === 'roc_auc' && (actualNormal === 0 || actualAbnormal === 0))
    return '실제 정상과 이상이 모두 있어야 구분 성능을 계산할 수 있어요.';
  if (key === 'average_precision' && actualAbnormal === 0)
    return '실제 이상이 0행이라 이상 점수의 순위를 평가할 수 없어요.';
  return '이 실행에 저장된 결과로는 계산할 수 없어요. 0점으로 바꾸지 않아요.';
}

function EvaluationOutcome({
  metrics,
  partition,
}: {
  metrics: EvaluationMetrics;
  partition: 'Valid' | 'Test';
}) {
  const correctNormal = metrics.confusion_matrix[0]?.[0] ?? 0;

  const correctAbnormal = metrics.confusion_matrix[1]?.[1] ?? 0;

  const correctCount = correctNormal + correctAbnormal;

  const actualAbnormal = (metrics.confusion_matrix[1]?.[0] ?? 0) + correctAbnormal;

  const allCorrect = metrics.sample_count > 0 && correctCount === metrics.sample_count;

  const accuracyPercent = Number.isFinite(metrics.accuracy)
    ? (metrics.accuracy * 100).toLocaleString('ko-KR', { maximumFractionDigits: 4 })
    : null;

  return (
    <div className="training-evaluation-outcome" aria-label="정답률 요약">
      <strong>
        {allCorrect
          ? `${number(metrics.sample_count)}건 모두 정답`
          : `${number(metrics.sample_count)}건 중 ${number(correctCount)}건 정답`}
        {accuracyPercent !== null && ` · 정확도 ${accuracyPercent}%`}
      </strong>
      <p>
        정상을 정상으로 {number(correctNormal)}건, 이상을 이상으로 {number(correctAbnormal)}건
        맞혔어요.
      </p>
      {actualAbnormal === 0 && (
        <p>
          이번 {partition}는 전부 정상 데이터라{' '}
          {allCorrect ? '정상 판별은 모두 맞았어요.' : '위 정확도는 정상 기록을 맞힌 비율이에요.'}{' '}
          이상을 얼마나 잘 잡는지는 이 결과만으로 평가할 수 없어요.
        </p>
      )}
    </div>
  );
}

function EvaluationExplanation({
  metrics,
  partition,
  dataset,
}: {
  metrics: EvaluationMetrics;
  partition: 'Valid' | 'Test';
  dataset: DatasetDetail | null;
}) {
  const actualNormal =
    (metrics.confusion_matrix[0]?.[0] ?? 0) + (metrics.confusion_matrix[0]?.[1] ?? 0);

  const actualAbnormal =
    (metrics.confusion_matrix[1]?.[0] ?? 0) + (metrics.confusion_matrix[1]?.[1] ?? 0);

  const predictedAbnormal =
    (metrics.confusion_matrix[0]?.[1] ?? 0) + (metrics.confusion_matrix[1]?.[1] ?? 0);

  const cannotEvaluateAbnormal = actualAbnormal === 0 || actualNormal === 0;

  return (
    <div className="training-evaluation-explanation" aria-label="평가 결과 해석">
      <p>
        {partition} {number(metrics.sample_count)}행 · 실제 정상 {number(actualNormal)}행 · 실제
        이상 {number(actualAbnormal)}행 · 예측 이상 {number(predictedAbnormal)}행
      </p>
      {actualNormal === 0 && actualAbnormal > 0 && (
        <Notice tone="warning">
          이 평가 구간에는 실제 정상이 없어요. 정상과 이상을 구분하는 성능을 충분히 확인할 수
          없어요.
        </Notice>
      )}
      {dataset && (
        <p>
          전체 데이터셋 {dataset.dataset.filename}: Normal{' '}
          {number(dataset.inspection.label_counts[dataset.dataset.normal_label] ?? 0)}행 · Abnormal{' '}
          {number(dataset.inspection.label_counts[dataset.dataset.abnormal_label] ?? 0)}행. 전체에
          이상이 있어도 시간순으로 나눈 평가 구간에는 없을 수 있어요.
        </p>
      )}
      {cannotEvaluateAbnormal && (
        <p>
          <a href="#training-settings">분할 설정 다시 보기</a>에서 각 구간의 라벨 분포와 이상 발생
          시각을 확인한 뒤 새 학습 실행을 만드세요. 비율만 바꾼다고 평가 근거가 생기지는 않아요.
          시간 순서를 유지하고 새 Test 구간은 마지막 확인용으로 남겨두세요. 기존 실행의 평가값은
          그대로 유지돼요.
        </p>
      )}
    </div>
  );
}

function ResultMetrics({
  metrics,
  partition,
  isExpert,
  dataset,
}: {
  metrics: EvaluationMetrics;
  partition: 'Valid' | 'Test';
  isExpert: boolean;
  dataset: DatasetDetail | null;
}) {
  const score = learningScore(metrics);

  if (!isExpert)
    return (
      <div className={`training-score${score == null ? ' training-score-unavailable' : ''}`}>
        <EvaluationOutcome metrics={metrics} partition={partition} />
        <span>{partition === 'Test' ? '최종 확인 결과' : '중간 확인 결과'}</span>
        <strong>
          {score == null ? (
            '평가 근거가 부족해요'
          ) : (
            <>
              {score}
              <small> / 100점</small>
            </>
          )}
        </strong>
        <p>
          기록된 이상과 모델이 찾은 이상이 얼마나 잘 맞는지 보여줘요. 고장 확률이나 설비의 건강
          점수는 아니에요.
        </p>
        <details>
          <summary>점수 계산 근거</summary>
          <p>
            {partition} 구간의 이상 라벨 기준 F1 × 100이에요. 놓친 이상과 잘못 알린 이상을 함께
            반영해요. 확인한 자료는 {number(metrics.sample_count)}행이에요.
          </p>
        </details>
        <EvaluationExplanation metrics={metrics} partition={partition} dataset={dataset} />
        {metrics.warnings.map((warning, index) => (
          <Notice key={index} tone="warning">
            {warning}
          </Notice>
        ))}
      </div>
    );
  return (
    <div className="training-expert-metrics">
      <EvaluationOutcome metrics={metrics} partition={partition} />
      <div className="section-heading">
        <h3>{partition} · 이상 클래스 평가</h3>
        <Badge>{number(metrics.sample_count)}행</Badge>
      </div>
      <div className="dm-metric-grid">
        {(['recall', 'precision', 'f1', 'accuracy', 'roc_auc', 'average_precision'] as const).map(
          (key) => (
            <div key={key}>
              <span>
                {
                  {
                    recall: 'Recall',
                    precision: 'Precision',
                    f1: 'F1 score',
                    accuracy: 'Accuracy',
                    roc_auc: 'ROC-AUC',
                    average_precision: 'Average precision',
                  }[key]
                }
              </span>
              <strong>{metric(metrics[key])}</strong>
              {unavailableMetricReason(key, metrics) && (
                <p className="dm-caption">{unavailableMetricReason(key, metrics)}</p>
              )}
            </div>
          ),
        )}
      </div>
      <div className="dm-matrix-heading">
        <strong>혼동행렬</strong>
        <span>행: 실제 / 열: 예측 · Normal, Abnormal 순서</span>
      </div>
      <div className="dm-matrix">
        <span />
        <span>Normal</span>
        <span>Abnormal</span>
        <span>Normal</span>
        <strong>{number(metrics.confusion_matrix[0]?.[0] ?? 0)}</strong>
        <strong>{number(metrics.confusion_matrix[0]?.[1] ?? 0)}</strong>
        <span>Abnormal</span>
        <strong>{number(metrics.confusion_matrix[1]?.[0] ?? 0)}</strong>
        <strong>{number(metrics.confusion_matrix[1]?.[1] ?? 0)}</strong>
      </div>
      <EvaluationExplanation metrics={metrics} partition={partition} dataset={dataset} />
      {metrics.warnings.map((warning, index) => (
        <Notice key={index} tone="warning">
          {warning}
        </Notice>
      ))}
    </div>
  );
}

export default function ModelsPage() {
  const {
    mode,
    user,
    datasets,
    runs,
    selectedDatasetId,
    selectedRunId,
    setSelectedDatasetId,
    setSelectedRunId,
    refreshRuns,
    refreshDatasets,
    toast,
  } = useApp();

  const { isExpert } = useExpertise();

  const [datasetId, setDatasetId] = useState(selectedDatasetId || '');

  const [dataset, setDataset] = useState<DatasetDetail | null>(null);

  const [datasetLoading, setDatasetLoading] = useState(false);

  const [reinspecting, setReinspecting] = useState(false);

  const [modelKey, setModelKey] = useState<TrainingModel>('xgboost');

  const [ratioPreset, setRatioPreset] = useState('70:15:15');

  const [trainRatio, setTrainRatio] = useState(70);

  const [validationRatio, setValidationRatio] = useState(15);

  const [features, setFeatures] = useState<string[]>([]);

  const [trainEnd, setTrainEnd] = useState('');

  const [validationEnd, setValidationEnd] = useState('');

  const [seed, setSeed] = useState(42);

  const [options, setOptions] = useState<Record<string, number>>({ ...DEFAULT_OPTIONS.xgboost });

  const [plan, setPlan] = useState<TrainingPlan | null>(null);

  const [planning, setPlanning] = useState(false);

  const [creating, setCreating] = useState(false);

  const [formError, setFormError] = useState('');

  const [detail, setDetail] = useState<RunDetail | null>(null);

  const [results, setResults] = useState<RunResults | null>(null);

  const [resultDataset, setResultDataset] = useState<DatasetDetail | null>(null);

  const [evaluation, setEvaluation] = useState<EvaluationResponse | null>(null);

  const [viewModel, setViewModel] = useState<ModelKey | ''>('');

  const [runLoading, setRunLoading] = useState(false);

  const [runError, setRunError] = useState('');

  const [reload, setReload] = useState(0);

  const [busy, setBusy] = useState(false);

  const [testOpen, setTestOpen] = useState(false);

  const planController = useRef<AbortController | null>(null);

  const reinspectionController = useRef<AbortController | null>(null);

  const manualBoundaries = useRef(false);

  const loadedDatasetAccount = useRef('');

  const currentRun = useRef(selectedRunId);

  const activeAccount = useRef('');

  currentRun.current = selectedRunId;
  activeAccount.current = `${mode}:${user?.id}`;

  const metadataNeedsReinspection = !!dataset?.inspection.channels.some((column) =>
    ['machine_status', 'all_sensors_missing'].includes(column),
  );

  function clearPlan() {
    planController.current?.abort();
    setPlan(null);
    setPlanning(false);
    setFormError('');
  }

  useEffect(() => {
    if (!datasetId) setDatasetId(selectedDatasetId || datasets[0]?.id || '');
  }, [datasetId, selectedDatasetId, datasets]);

  useEffect(() => {
    // CSV·계정이 바뀌면 이전 채널과 자동 설정을 다음 자료에 적용하지 않는다.
    const controller = new AbortController();

    reinspectionController.current?.abort();
    reinspectionController.current = null;
    setReinspecting(false);
    setDataset(null);
    loadedDatasetAccount.current = '';
    manualBoundaries.current = false;
    setFeatures([]);
    setTrainEnd('');
    setValidationEnd('');
    clearPlan();
    if (!datasetId) return;
    setDatasetLoading(true);
    const request =
      mode === 'demo'
        ? Promise.resolve(DEMO_DATASET_DETAIL)
        : api.dataset(datasetId, controller.signal);

    request
      .then((next) => {
        if (controller.signal.aborted) return;
        loadedDatasetAccount.current = `${mode}:${user?.id}`;
        setDataset(next);
        setFeatures([...next.inspection.channels]);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFormError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDatasetLoading(false);
      });
    return () => {
      controller.abort();
      planController.current?.abort();
      reinspectionController.current?.abort();
    };
  }, [datasetId, mode, user?.id]);

  async function reinspectCsv() {
    if (!dataset || reinspecting || creating || mode !== 'live') return;
    const controller = new AbortController();

    const requestAccount = activeAccount.current;

    reinspectionController.current?.abort();
    reinspectionController.current = controller;
    setReinspecting(true);
    clearPlan();
    try {
      const inspected = await api.reinspectDataset(dataset.dataset.id, controller.signal);

      if (controller.signal.aborted || activeAccount.current !== requestAccount) return;
      manualBoundaries.current = false;
      setDataset(inspected);
      setFeatures([...inspected.inspection.channels]);
      setTrainEnd('');
      setValidationEnd('');
      await refreshDatasets();
    } catch (error) {
      if (!controller.signal.aborted && activeAccount.current === requestAccount)
        setFormError(errorMessage(error));
    } finally {
      if (reinspectionController.current === controller) setReinspecting(false);
    }
  }

  useEffect(() => {
    if (!selectedRunId && runs.length) setSelectedRunId(runs[0].id);
  }, [selectedRunId, runs, setSelectedRunId]);

  useEffect(() => {
    // 과거 여러 모델을 비교했던 실행도 삭제하지 않고 같은 기록에서 계속 읽는다.
    const controller = new AbortController();

    let timer: ReturnType<typeof setTimeout> | undefined;

    setDetail(null);
    setResults(null);
    setResultDataset(null);
    setEvaluation(null);
    setRunError('');
    setViewModel('');
    setTestOpen(false);
    if (!selectedRunId) {
      setRunLoading(false);
      return;
    }
    const id = selectedRunId;

    setRunLoading(true);
    async function load() {
      try {
        const next =
          mode === 'demo' ? structuredClone(DEMO_RUN_DETAIL) : await api.run(id, controller.signal);

        if (controller.signal.aborted) return;
        setDetail(next);
        setViewModel(
          (previous) =>
            previous ||
            next.run.selected_model ||
            (next.configuration.models.length === 1 ? next.configuration.models[0] : ''),
        );
        if (next.run.status === 'completed') {
          // 평가한 실행의 CSV만 읽는다. 위 학습 폼에서 고른 다른 CSV와 섞지 않는다.
          const [nextResults, nextDataset] = await Promise.all([
            mode === 'demo'
              ? Promise.resolve(structuredClone(DEMO_RESULTS))
              : api.results(id, 'f1', controller.signal),
            mode === 'demo'
              ? Promise.resolve(structuredClone(DEMO_DATASET_DETAIL))
              : api.dataset(next.run.dataset_id, controller.signal).catch(() => null),
          ]);

          if (controller.signal.aborted) return;
          setResults(nextResults);
          setResultDataset(nextDataset);
          if (next.run.evaluation_status !== 'not_started' && mode !== 'demo') {
            const nextEvaluation = await api.evaluation(id, controller.signal);

            if (controller.signal.aborted) return;
            setEvaluation(nextEvaluation);
          }
        }
        setRunLoading(false);
        if (
          mode !== 'demo' &&
          (['queued', 'running'].includes(next.run.status) ||
            ['queued', 'running'].includes(next.run.evaluation_status))
        )
          timer = setTimeout(load, 1800);
      } catch (error) {
        if (!controller.signal.aborted) {
          setRunError(errorMessage(error));
          setRunLoading(false);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selectedRunId, mode, user?.id, reload]);

  async function automaticSettings(resetOptions = true) {
    if (
      !dataset ||
      metadataNeedsReinspection ||
      reinspecting ||
      mode === 'demo' ||
      loadedDatasetAccount.current !== activeAccount.current ||
      (!resetOptions && manualBoundaries.current)
    )
      return;
    const controller = new AbortController();

    const requestAccount = activeAccount.current;

    planController.current?.abort();
    planController.current = controller;
    if (resetOptions) manualBoundaries.current = false;
    setPlan(null);
    setTrainEnd('');
    setValidationEnd('');
    setPlanning(true);
    setFormError('');
    try {
      const next = await prepareTraining(
        {
          dataset_id: datasetId,
          model_key: modelKey,
          train_ratio: trainRatio / 100,
          validation_ratio: validationRatio / 100,
          feature_columns: features,
        },
        controller.signal,
      );

      if (controller.signal.aborted || activeAccount.current !== requestAccount) return;
      setPlan(next);
      setTrainEnd(next.configuration.train_end);
      setValidationEnd(next.configuration.validation_end);
      // 사용자가 바꾼 옵션은 자동 재계산으로 덮지 않는다. 버튼을 누른 경우에만 초기화한다.
      if (resetOptions) {
        setOptions(
          next.configuration.model_options?.[modelKey] || { ...DEFAULT_OPTIONS[modelKey] },
        );
        setSeed(next.configuration.random_seed);
      }
    } catch (error) {
      if (!controller.signal.aborted) setFormError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPlanning(false);
    }
  }

  useEffect(() => {
    // CSV를 고르면 시간 경계를 자동으로 채운다. 수동 입력 중에는 늦은 응답도 적용하지 않는다.
    if (
      !dataset ||
      datasetLoading ||
      dataset.dataset.id !== datasetId ||
      dataset.dataset.status !== 'valid' ||
      metadataNeedsReinspection ||
      reinspecting ||
      !features.length ||
      mode === 'demo' ||
      loadedDatasetAccount.current !== activeAccount.current ||
      manualBoundaries.current
    )
      return;
    setPlanning(true);
    const timer = setTimeout(() => void automaticSettings(false), 150);

    return () => {
      clearTimeout(timer);
      planController.current?.abort();
    };
  }, [
    dataset,
    datasetLoading,
    datasetId,
    mode,
    user?.id,
    modelKey,
    ratioPreset,
    trainRatio,
    validationRatio,
    features,
    reinspecting,
    metadataNeedsReinspection,
  ]);

  async function startTraining(event: FormEvent) {
    event.preventDefault();
    if (mode === 'demo' || creating || planning) return;
    setFormError('');
    if (
      !dataset ||
      dataset.dataset.status !== 'valid' ||
      metadataNeedsReinspection ||
      reinspecting ||
      !features.length
    ) {
      setFormError('검사를 통과한 CSV와 학습할 채널을 선택해주세요.');
      return;
    }
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

    if (
      !iso.test(trainEnd) ||
      !iso.test(validationEnd) ||
      !Number.isFinite(Date.parse(trainEnd)) ||
      !Number.isFinite(Date.parse(validationEnd)) ||
      Date.parse(trainEnd) >= Date.parse(validationEnd)
    ) {
      setFormError('Train 종료와 Valid 종료를 올바른 ISO 시각으로, 시간 순서에 맞게 입력해주세요.');
      return;
    }
    const aware = (value: string) => /(?:Z|[+-]\d{2}:\d{2})$/.test(value);

    if (
      aware(trainEnd) !== aware(validationEnd) ||
      (dataset.inspection.timezone_mode === 'aware' && !aware(trainEnd)) ||
      (dataset.inspection.timezone_mode === 'naive' && aware(trainEnd))
    ) {
      setFormError('두 경계의 시간대 표기를 CSV와 같게 맞춰주세요. 시간대를 임의로 바꾸지 않아요.');
      return;
    }
    const configuration: TrainingConfiguration = {
      dataset_id: datasetId,
      feature_columns: features,
      models: [modelKey],
      train_end: trainEnd,
      validation_end: validationEnd,
      ranking_metric: 'f1',
      random_seed: seed,
      model_options: { [modelKey]: options },
    };

    const requestAccount = activeAccount.current;

    setCreating(true);
    try {
      const next = await api.createRun(configuration);

      if (activeAccount.current !== requestAccount) return;
      setSelectedDatasetId(datasetId);
      setSelectedRunId(next.run.id);
      setReload((value) => value + 1);
      toast('학습을 시작했어요. 완료 상태를 서버에서 확인할게요.', 'success');
      await refreshRuns().catch((error) => toast(errorMessage(error), 'error'));
    } catch (error) {
      if (activeAccount.current === requestAccount) setFormError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function useModel() {
    if (!detail || !viewModel || mode === 'demo') return;
    const id = detail.run.id;

    const requestAccount = activeAccount.current;

    setBusy(true);
    setRunError('');
    try {
      const next = await api.selectModel(id, viewModel);

      if (currentRun.current !== id || activeAccount.current !== requestAccount) return;
      setDetail(next);
      toast(
        ['xgboost', 'autoencoder'].includes(viewModel)
          ? '사용할 모델을 저장했어요. 최종 평가를 마친 뒤 시뮬레이션에서 사용할 수 있어요.'
          : '이전 실행에서 사용할 모델을 저장했어요.',
        'success',
      );
      await refreshRuns().catch((error) => toast(errorMessage(error), 'error'));
    } catch (error) {
      if (currentRun.current === id && activeAccount.current === requestAccount)
        setRunError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function evaluateTest() {
    if (!detail || !viewModel || mode === 'demo') return;
    const id = detail.run.id;

    const requestAccount = activeAccount.current;

    setBusy(true);
    setRunError('');
    try {
      // 확인 버튼을 누른 경우에만 모델을 고정하고 Test 평가를 요청한다.
      if (!detail.run.selected_model) {
        const selected = await api.selectModel(id, viewModel);

        if (currentRun.current !== id || activeAccount.current !== requestAccount) return;
        setDetail(selected);
      }
      const next = await api.evaluate(id);

      if (currentRun.current !== id || activeAccount.current !== requestAccount) return;
      setEvaluation(next);
      setTestOpen(false);
      setReload((value) => value + 1);
      await refreshRuns().catch((error) => toast(errorMessage(error), 'error'));
    } catch (error) {
      if (currentRun.current === id && activeAccount.current === requestAccount)
        setRunError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const result = results?.items.find((item) => item.model_key === viewModel);

  const finalMetrics =
    evaluation?.status === 'completed' && evaluation.model_key === viewModel
      ? evaluation.metrics
      : null;

  const shownMetrics = finalMetrics || result?.validation_metrics;

  const evaluationStarted = !!detail && detail.run.evaluation_status !== 'not_started';

  const activeJob =
    !!detail &&
    (['queued', 'running'].includes(detail.run.status) ||
      ['queued', 'running'].includes(detail.run.evaluation_status));

  const canSimulate =
    detail?.run.evaluation_status === 'completed' &&
    ['xgboost', 'autoencoder'].includes(detail.run.selected_model || '');

  // 중요한 자료 부족 안내는 쉬운 설명에서도 숨기지 않는다. 과거 API의 notes도 읽는다.
  const planWarnings =
    plan?.warnings ?? plan?.notes.filter((note) => /라벨|비정상|F1/.test(note)) ?? [];

  return (
    <div className="page-stack training-page">
      <PageHeader
        eyebrow="TRAINING"
        title="모델 학습"
        description={
          isExpert
            ? '전처리한 채널과 시간 분할을 정하고, 선택한 모델 하나를 학습합니다.'
            : '준비된 데이터를 고르고, 이상을 찾아줄 모델을 하나 만들어보세요.'
        }
      />
      {mode === 'demo' && (
        <Notice>화면 미리보기예요. 학습과 자동 설정은 로그인 후 사용할 수 있어요.</Notice>
      )}
      <form id="training-settings" className="surface training-builder" onSubmit={startTraining}>
        <section className="training-step">
          <div className="training-step-heading">
            <span>01</span>
            <div>
              <h2>데이터셋 선택</h2>
              <p>전처리가 끝난 CSV를 사용해요.</p>
            </div>
          </div>
          <Field label="학습할 데이터셋" htmlFor="training-dataset">
            <select
              id="training-dataset"
              className="select"
              value={datasetId}
              disabled={creating}
              onChange={(event) => setDatasetId(event.target.value)}
            >
              <option value="" disabled>
                CSV를 선택해주세요
              </option>
              {datasets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.filename} · {number(item.row_count)}행
                </option>
              ))}
            </select>
          </Field>
          {!datasets.length && (
            <EmptyState
              title="먼저 CSV를 등록해주세요"
              action={
                <Link to="/data" className="button secondary">
                  데이터 등록 <ArrowRight size={15} />
                </Link>
              }
            />
          )}
          {datasetLoading && <p role="status">데이터를 확인하고 있어요.</p>}
          {dataset && (
            <p className="training-period">
              {csvTime(dataset.inspection.time_start)} ~ {csvTime(dataset.inspection.time_end)} ·{' '}
              {features.length}개 채널
            </p>
          )}
          {dataset && (dataset.dataset.status === 'needs_review' || metadataNeedsReinspection) && (
            <Notice tone="warning">
              <p>아래 항목 때문에 학습을 멈췄어요. 원본 CSV는 바꾸지 않습니다.</p>
              {metadataNeedsReinspection && (
                <p>
                  <code>machine_status</code> 같은 상태 열이 숫자 채널로 잡힌 이전 검사 결과예요.
                  다시 검사하면 상태 열을 학습 입력에서 제외합니다.
                </p>
              )}
              <ul aria-label="CSV에서 확인할 항목">
                {dataset.inspection.issues
                  .filter((issue) => issue.severity === 'error')
                  .map((issue, index) => (
                    <li key={`${issue.code}:${issue.column || ''}:${index}`}>
                      {issue.column ? `${issue.column} · ` : ''}
                      {number(issue.count)}건: {issue.message}
                    </li>
                  ))}
              </ul>
              <button
                className="button secondary"
                type="button"
                onClick={() => void reinspectCsv()}
                disabled={reinspecting || creating || mode !== 'live'}
              >
                {reinspecting ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                {reinspecting ? 'CSV 다시 검사 중' : 'CSV 다시 검사'}
              </button>{' '}
              <Link to="/data">전체 검사 결과 보기 ↗</Link>
            </Notice>
          )}
          {!!dataset?.inspection.ignored_columns?.length && (
            <p className="training-period">
              학습 입력에서 제외한 상태 열: {dataset.inspection.ignored_columns.join(', ')}.
              원본에는 그대로 남아 있어요.
            </p>
          )}
        </section>
        <section className="training-step">
          <div className="training-step-heading">
            <span>02</span>
            <div>
              <h2>{isExpert ? '학습 모델 선택' : '이상을 찾는 방법 선택'}</h2>
              <p>한 번에 하나만 학습해요.</p>
            </div>
          </div>
          <div className="training-models" role="radiogroup" aria-label="학습할 모델">
            {(['xgboost', 'autoencoder'] as const).map((key) => (
              <label className={modelKey === key ? 'selected' : ''} key={key}>
                <input
                  type="radio"
                  name="training-model"
                  value={key}
                  checked={modelKey === key}
                  disabled={creating}
                  onChange={() => {
                    clearPlan();
                    setModelKey(key);
                    setOptions({ ...DEFAULT_OPTIONS[key] });
                  }}
                />
                <Cpu size={21} />
                <strong>{MODEL_NAMES[key]}</strong>
                <p>
                  {key === 'xgboost'
                    ? isExpert
                      ? 'Normal·Abnormal 라벨을 학습하는 지도 분류 모델'
                      : '과거에 정상·이상으로 기록된 사례를 배워요.'
                    : isExpert
                      ? '정상 Train의 재구성 오차로 이상을 찾는 모델'
                      : '정상일 때의 모습을 배우고, 크게 달라진 값을 찾아요.'}
                </p>
              </label>
            ))}
          </div>
        </section>
        <section className="training-step">
          <div className="training-step-heading">
            <span>03</span>
            <div>
              <h2>{isExpert ? '분할·하이퍼파라미터 설정' : '학습 준비'}</h2>
              <p>
                {isExpert
                  ? '자동 설정값을 확인하고 필요한 값만 조정합니다.'
                  : '데이터를 고르면 시간 순서대로 나누고 학습할 준비를 해요.'}
              </p>
            </div>
          </div>
          <div className="training-plan-row">
            <Field
              label={isExpert ? 'Train : Valid : Test' : '데이터를 나누는 비율'}
              htmlFor="training-ratio"
            >
              <select
                id="training-ratio"
                className="select"
                value={ratioPreset}
                disabled={creating || planning}
                onChange={(event) => {
                  const value = event.target.value;

                  clearPlan();
                  manualBoundaries.current = false;
                  setRatioPreset(value);
                  if (value !== 'custom') {
                    const parts = value.split(':').map(Number);

                    setTrainRatio(parts[0]);
                    setValidationRatio(parts[1]);
                  }
                }}
              >
                <option value="70:15:15">학습 70% · 중간 확인 15% · 최종 확인 15%</option>
                <option value="60:20:20">학습 60% · 중간 확인 20% · 최종 확인 20%</option>
                <option value="80:10:10">학습 80% · 중간 확인 10% · 최종 확인 10%</option>
                {(isExpert || ratioPreset === 'custom') && (
                  <option value="custom">직접 지정</option>
                )}
              </select>
            </Field>
            <button
              type="button"
              className="button secondary"
              onClick={() => void automaticSettings()}
              disabled={
                !dataset ||
                dataset.dataset.status !== 'valid' ||
                metadataNeedsReinspection ||
                reinspecting ||
                !features.length ||
                planning ||
                creating ||
                mode === 'demo'
              }
            >
              {planning ? (
                <LoaderCircle className="dm-spin" size={17} />
              ) : (
                <WandSparkles size={17} />
              )}{' '}
              자동 설정
            </button>
          </div>
          {planning && <p role="status">데이터에 맞춰 학습·확인 시각을 자동으로 채우고 있어요.</p>}
          {ratioPreset === 'custom' && isExpert && (
            <div className="dm-form-grid">
              <Field label="Train 비율 (%)" htmlFor="training-train-ratio">
                <input
                  id="training-train-ratio"
                  type="number"
                  className="input"
                  min="10"
                  max="90"
                  step="1"
                  value={trainRatio}
                  onChange={(event) => {
                    clearPlan();
                    manualBoundaries.current = false;
                    setTrainRatio(Number(event.target.value));
                  }}
                />
              </Field>
              <Field label="Valid 비율 (%)" htmlFor="training-valid-ratio">
                <input
                  id="training-valid-ratio"
                  type="number"
                  className="input"
                  min="5"
                  max="40"
                  step="1"
                  value={validationRatio}
                  onChange={(event) => {
                    clearPlan();
                    manualBoundaries.current = false;
                    setValidationRatio(Number(event.target.value));
                  }}
                />
              </Field>
            </div>
          )}
          {plan && (
            <div className="training-split" aria-label="자동 설정된 데이터 분할">
              <div>
                <span>{isExpert ? 'Train' : '학습'}</span>
                <strong>{number(plan.split.train_rows)}행</strong>
              </div>
              <div>
                <span>{isExpert ? 'Valid' : '중간 확인'}</span>
                <strong>{number(plan.split.validation_rows)}행</strong>
              </div>
              <div>
                <span>{isExpert ? 'Test' : '최종 확인'}</span>
                <strong>{number(plan.split.test_rows)}행</strong>
              </div>
            </div>
          )}
          {plan?.label_counts && (
            <div className="dm-table-scroll">
              <table className="dm-table" aria-label="각 구간의 라벨 분포">
                <thead>
                  <tr>
                    <th scope="col">구간</th>
                    <th scope="col">{isExpert ? 'Normal' : '정상 기록'}</th>
                    <th scope="col">{isExpert ? 'Abnormal' : '이상 기록'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(['train', 'validation', 'test'] as const).map((part) => (
                    <tr key={part}>
                      <th scope="row">
                        {isExpert
                          ? { train: 'Train', validation: 'Valid', test: 'Test' }[part]
                          : { train: '학습', validation: '중간 확인', test: '최종 확인' }[part]}
                      </th>
                      <td>{number(plan.label_counts![part].normal)}행</td>
                      <td>{number(plan.label_counts![part].abnormal)}행</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {plan?.label_counts &&
            (plan.label_counts.validation.abnormal === 0 ||
              plan.label_counts.test.abnormal === 0) && (
              <Notice tone="warning">
                이상이 0행인 평가 구간에서는 이상 탐지 성능을 확인할 수 없어요. 비율만 바꾸기보다 각
                구간의 라벨 분포와 이상 발생 시각을 확인하세요. 데이터는 시간순으로 유지해요.
              </Notice>
            )}
          {planWarnings.map((warning, index) => (
            <Notice key={index} tone="warning">
              {isExpert
                ? warning
                : warning
                    .replace(/\bTrain\b/g, '학습')
                    .replace(/\bValid\b/g, '중간 확인')
                    .replace(/\bTest\b/g, '최종 확인')
                    .replace(/\bF1\b/g, '점수')}
            </Notice>
          ))}
          <p className="training-period">
            시간 순서를 유지해요. 앞부분으로 배우고, 뒷부분으로 확인합니다.
          </p>
          {isExpert && (
            <details className="training-advanced">
              <summary>채널·시간 경계·모델 옵션 직접 설정</summary>
              <div className="dm-form-stack">
                <div className="training-feature-list">
                  {dataset?.inspection.channels.map((channel) => (
                    <label key={channel}>
                      <input
                        type="checkbox"
                        checked={features.includes(channel)}
                        disabled={creating}
                        onChange={(event) => {
                          clearPlan();
                          setFeatures((previous) =>
                            event.target.checked
                              ? [...previous, channel]
                              : previous.filter((item) => item !== channel),
                          );
                        }}
                      />
                      <code>{channel}</code>
                    </label>
                  ))}
                </div>
                <Field label="Train 종료 시각" htmlFor="training-train-end">
                  <input
                    id="training-train-end"
                    className="input"
                    value={trainEnd}
                    disabled={creating}
                    onChange={(event) => {
                      manualBoundaries.current = true;
                      clearPlan();
                      setTrainEnd(event.target.value);
                    }}
                    placeholder="2018-06-30T23:59:00"
                  />
                </Field>
                <Field label="Valid 종료 시각" htmlFor="training-valid-end">
                  <input
                    id="training-valid-end"
                    className="input"
                    value={validationEnd}
                    disabled={creating}
                    onChange={(event) => {
                      manualBoundaries.current = true;
                      clearPlan();
                      setValidationEnd(event.target.value);
                    }}
                    placeholder="2018-07-31T23:59:00"
                  />
                </Field>
                <div className="training-option-grid">
                  {OPTION_FIELDS[modelKey].map((field) => (
                    <Field
                      label={field.label}
                      htmlFor={`training-option-${field.key}`}
                      key={field.key}
                    >
                      <input
                        id={`training-option-${field.key}`}
                        className="input"
                        type="number"
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        value={options[field.key] ?? ''}
                        disabled={creating}
                        onChange={(event) =>
                          setOptions((previous) => ({
                            ...previous,
                            [field.key]: Number(event.target.value),
                          }))
                        }
                      />
                    </Field>
                  ))}
                  <Field label="랜덤 시드" htmlFor="training-seed">
                    <input
                      id="training-seed"
                      type="number"
                      className="input"
                      min="0"
                      max="2147483647"
                      step="1"
                      value={seed}
                      disabled={creating}
                      onChange={(event) => setSeed(Number(event.target.value))}
                    />
                  </Field>
                </div>
              </div>
            </details>
          )}
          {isExpert &&
            plan?.notes.map((note, index) => (
              <p className="dm-caption" key={index}>
                {note}
              </p>
            ))}
          {formError && <Notice tone="error">{formError}</Notice>}
          <section className="training-process-preview" aria-label="학습을 시작하면 진행할 순서">
            <h3>현재 데이터에서 모델이 만들어지는 순서</h3>
            <p>
              학습 시작을 누르면 아래 순서로 진행해요. 진행 상태는 서버에서 실제 기록을 받아
              표시합니다.
            </p>
            <ol>
              {TRAINING_STAGES.map((stage, index) => (
                <li key={stage.key}>
                  <span>{index + 1}</span>
                  <div>
                    <strong>{isExpert ? stage.expert : stage.simple}</strong>
                    <small>{stage.description}</small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          <div className="training-submit">
            <button
              className="button primary"
              type="submit"
              disabled={
                creating ||
                planning ||
                !dataset ||
                dataset.dataset.status !== 'valid' ||
                metadataNeedsReinspection ||
                reinspecting ||
                mode === 'demo' ||
                !features.length ||
                !trainEnd ||
                !validationEnd ||
                (!plan && !manualBoundaries.current)
              }
            >
              {creating ? <LoaderCircle className="dm-spin" size={17} /> : <Play size={17} />} 학습
              시작
            </button>
            <span>
              선택한 {MODEL_NAMES[modelKey]}만 학습해요. 최종 평가는 별도 버튼으로 시작합니다.
            </span>
          </div>
        </section>
      </form>
      <section className="surface training-result">
        <div className="section-heading">
          <div>
            <h2>학습 결과</h2>
            <p>
              {isExpert
                ? 'Valid 확인 후 Test를 평가합니다. Test 결과로 다시 조정하지 않습니다.'
                : '학습 결과와 최종 확인을 마친 뒤 시뮬레이션에서 사용할 수 있어요.'}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="학습 결과 새로고침"
            disabled={runLoading || busy}
            onClick={() => {
              setReload((value) => value + 1);
              void refreshRuns().catch((error) => toast(errorMessage(error), 'error'));
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <details className="training-history">
          <summary>
            <History size={15} /> 이전 학습 기록 {runs.length}개
          </summary>
          <select
            className="select"
            aria-label="학습 기록 선택"
            value={selectedRunId || ''}
            disabled={busy}
            onChange={(event) => setSelectedRunId(event.target.value)}
          >
            <option value="" disabled>
              학습 기록 선택
            </option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {dateTime(run.created_at)} ·{' '}
                {datasets.find((item) => item.id === run.dataset_id)?.filename ||
                  run.dataset_id.slice(0, 8)}{' '}
                · {RUN_STATUS_NAMES[detail?.run.id === run.id ? detail.run.status : run.status]}
              </option>
            ))}
          </select>
        </details>
        {runError && <Notice tone="error">{runError}</Notice>}
        {runLoading && !detail ? (
          <p role="status">학습 기록을 불러오고 있어요.</p>
        ) : !detail ? (
          <EmptyState
            title="첫 학습을 시작해주세요"
            description="선택한 모델의 결과를 여기에 표시해요."
          />
        ) : (
          <>
            <div className="training-result-heading">
              <Badge
                tone={
                  detail.run.status === 'failed'
                    ? 'red'
                    : detail.run.status === 'completed'
                      ? 'green'
                      : 'blue'
                }
              >
                {RUN_STATUS_NAMES[detail.run.status]}
              </Badge>
              <span>실행 {detail.run.id.slice(0, 8)}</span>
              {detail.split && (
                <span>
                  {isExpert ? 'Train / Valid / Test' : '학습 / 중간 확인 / 최종 확인'} ·{' '}
                  {number(detail.split.train.row_count)} /{' '}
                  {number(detail.split.validation.row_count)} /{' '}
                  {number(detail.split.test.row_count)}행
                </span>
              )}
            </div>
            {detail.run.error_message && <Notice tone="error">{detail.run.error_message}</Notice>}
            <TrainingProcess
              detail={detail}
              filename={
                datasets.find((item) => item.id === detail.run.dataset_id)?.filename ||
                detail.run.dataset_id
              }
              isExpert={isExpert}
            />
            {activeJob && (
              <div className="training-running" role="status">
                <LoaderCircle size={24} className="dm-spin" />
                <span>
                  {detail.run.status === 'completed'
                    ? '최종 확인 중이에요.'
                    : '선택한 모델을 학습하고 있어요.'}{' '}
                  완료 상태를 서버에서 확인하고 있어요.
                </span>
              </div>
            )}
            {detail.run.status === 'completed' && (
              <>
                {detail.configuration.models.length > 1 && (
                  <Field label="이전 실행의 모델" htmlFor="training-history-model">
                    <select
                      id="training-history-model"
                      className="select"
                      value={viewModel}
                      disabled={busy || evaluationStarted}
                      onChange={(event) => setViewModel(event.target.value as ModelKey)}
                    >
                      <option value="" disabled>
                        결과를 볼 모델 선택
                      </option>
                      {detail.configuration.models.map((key) => (
                        <option key={key} value={key}>
                          {MODEL_NAMES[key]}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {viewModel && <h3>{MODEL_NAMES[viewModel]}</h3>}
                {shownMetrics && (
                  <ResultMetrics
                    metrics={shownMetrics}
                    partition={finalMetrics ? 'Test' : 'Valid'}
                    isExpert={isExpert}
                    dataset={resultDataset}
                  />
                )}
                {!shownMetrics && !runError && <p>결과를 볼 모델을 선택해주세요.</p>}
                {evaluation?.error_message && (
                  <Notice tone="error">{evaluation.error_message}</Notice>
                )}
                {evaluationStarted && (
                  <p className="dm-caption">
                    최종 평가를 시작한 실행은 모델과 설정을 바꿀 수 없어요.
                  </p>
                )}
                <div className="training-result-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={useModel}
                    disabled={
                      !result ||
                      busy ||
                      evaluationStarted ||
                      mode === 'demo' ||
                      detail.run.selected_model === viewModel
                    }
                  >
                    {detail.run.selected_model === viewModel ? (
                      <Check size={16} />
                    ) : (
                      <Cpu size={16} />
                    )}
                    {detail.run.selected_model === viewModel
                      ? '사용할 모델로 저장됨'
                      : '사용할 모델 저장'}
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    disabled={
                      !result ||
                      busy ||
                      activeJob ||
                      evaluation?.status === 'completed' ||
                      mode === 'demo' ||
                      (!!detail.run.selected_model && detail.run.selected_model !== viewModel)
                    }
                    onClick={() => setTestOpen(true)}
                  >
                    {isExpert ? 'Test 평가' : '마지막 데이터로 확인'}
                  </button>
                  {canSimulate && (
                    <Link to="/simulation" className="button ghost">
                      시뮬레이션 <ArrowRight size={16} />
                    </Link>
                  )}
                </div>
                {detail.run.selected_model &&
                  !canSimulate &&
                  ['xgboost', 'autoencoder'].includes(detail.run.selected_model) && (
                    <p className="dm-caption">
                      사용할 모델이 저장됐어요. 마지막 데이터로 확인을 마치면 시뮬레이션으로 이동할
                      수 있어요.
                    </p>
                  )}
                {isExpert && !detail.training_progress?.length && (
                  <details className="training-advanced">
                    <summary>저장된 학습 설정</summary>
                    <p>
                      Train 종료: {detail.configuration.train_end}
                      <br />
                      Valid 종료: {detail.configuration.validation_end}
                      <br />
                      입력 채널: {detail.configuration.feature_columns.join(', ')}
                    </p>
                    <pre>{JSON.stringify(result?.parameters || {}, null, 2)}</pre>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </section>
      <Modal
        open={testOpen}
        onOpenChange={setTestOpen}
        title={isExpert ? '선택한 모델로 Test를 평가할까요?' : '마지막 데이터로 확인할까요?'}
        description="이 확인을 시작하면 이 실행의 모델을 바꿀 수 없어요."
        footer={
          <>
            <button className="button secondary" onClick={() => setTestOpen(false)} disabled={busy}>
              돌아가기
            </button>
            <button
              className="button primary"
              onClick={evaluateTest}
              disabled={busy || mode === 'demo'}
            >
              {busy ? <LoaderCircle size={16} className="dm-spin" /> : <Play size={16} />}
              {isExpert ? 'Test 평가 시작' : '최종 확인 시작'}
            </button>
          </>
        }
      >
        <p>
          {viewModel && MODEL_NAMES[viewModel]}를 그대로 사용해요. 학습에 쓰지 않은 마지막 구간에서
          확인하고, 이 결과를 보고 다시 설정하지 않아요.
        </p>
        {runError && <Notice tone="error">{runError}</Notice>}
      </Modal>
    </div>
  );
}
