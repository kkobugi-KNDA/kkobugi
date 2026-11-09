import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowRight,
  BarChart3,
  Boxes,
  Check,
  ChevronRight,
  CircleCheck,
  Clock3,
  FlaskConical,
  History,
  LockKeyhole,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Drawer,
  EmptyState,
  Field,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
} from '../components/ui';
import { useApp } from '../context/AppContext';
import { DEMO_DATASET_DETAIL, DEMO_MODELS, DEMO_RESULTS, DEMO_RUN_DETAIL } from '../data/demo';
import { api, errorMessage } from '../lib/api';
import { csvTime, dateTime, number } from '../lib/format';
import type {
  DatasetDetail,
  EvaluationMetrics,
  EvaluationResponse,
  ModelDefinition,
  ModelKey,
  ModelResult,
  RankingMetric,
  RunDetail,
  RunResults,
} from '../types';
import './data-models.css';

const metricNames: Record<RankingMetric, string> = {
  f1: 'F1',
  precision: 'Precision',
  recall: 'Recall',
  accuracy: 'Accuracy',
  balanced_accuracy: 'Balanced accuracy',
  roc_auc: 'ROC-AUC',
  average_precision: 'Average precision',
};
const statusNames = {
  queued: '대기 중',
  running: '학습 중',
  completed: '학습 완료',
  failed: '실패',
};
function metricValue(value: number | null | undefined) {
  return value == null ? '—' : value.toFixed(3);
}
function Metrics({
  metrics,
  normal = 'Normal',
  abnormal = 'UnNormal',
}: {
  metrics: EvaluationMetrics;
  normal?: string;
  abnormal?: string;
}) {
  return (
    <div className="dm-form-stack">
      <div className="dm-metric-grid">
        {(
          [
            'f1',
            'precision',
            'recall',
            'accuracy',
            'roc_auc',
            'average_precision',
          ] as RankingMetric[]
        ).map((key) => (
          <div key={key}>
            <span>{metricNames[key]}</span>
            <strong>{metricValue(metrics[key])}</strong>
          </div>
        ))}
      </div>
      <div className="dm-matrix-heading">
        <strong>혼동행렬</strong>
        <span>행: 실제값 / 열: 예측값</span>
      </div>
      <div className="dm-matrix">
        <span />
        <span>{normal}</span>
        <span>{abnormal}</span>
        <span>{normal}</span>
        <strong>{number(metrics.confusion_matrix[0]?.[0] ?? 0)}</strong>
        <strong className="is-error">{number(metrics.confusion_matrix[0]?.[1] ?? 0)}</strong>
        <span>{abnormal}</span>
        <strong className="is-error">{number(metrics.confusion_matrix[1]?.[0] ?? 0)}</strong>
        <strong>{number(metrics.confusion_matrix[1]?.[1] ?? 0)}</strong>
      </div>
      <p className="dm-caption">
        양성 기준은 CSV의 UnNormal 라벨이에요. 평가에 사용한 행은 {number(metrics.sample_count)}
        개예요. 계산할 수 없는 지표는 —로 표시해요.
      </p>
      {metrics.warnings.map((warning, i) => (
        <Notice tone="warning" key={i}>
          {warning}
        </Notice>
      ))}
    </div>
  );
}

export default function ModelsPage() {
  const {
    mode,
    datasets,
    runs,
    runsLoading,
    selectedDatasetId,
    selectedRunId,
    setSelectedDatasetId,
    setSelectedRunId,
    refreshRuns,
    toast,
  } = useApp();
  const [catalog, setCatalog] = useState<ModelDefinition[]>([]),
    [catalogError, setCatalogError] = useState('');
  const [detail, setDetail] = useState<RunDetail | null>(null),
    [results, setResults] = useState<RunResults | null>(null),
    [evaluation, setEvaluation] = useState<EvaluationResponse | null>(null);
  const [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(''),
    [metric, setMetric] = useState<RankingMetric>('f1'),
    [reload, setReload] = useState(0);
  const [newOpen, setNewOpen] = useState(false),
    [testConfirm, setTestConfirm] = useState(false),
    [metricDetail, setMetricDetail] = useState<ModelResult | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false);
  const [formDatasetId, setFormDatasetId] = useState(''),
    [formDataset, setFormDataset] = useState<DatasetDetail | null>(null),
    [formDataLoading, setFormDataLoading] = useState(false);
  const [features, setFeatures] = useState<string[]>([]),
    [modelKeys, setModelKeys] = useState<ModelKey[]>([]),
    [trainEnd, setTrainEnd] = useState(''),
    [validationEnd, setValidationEnd] = useState(''),
    [seed, setSeed] = useState('42');
  const [formError, setFormError] = useState(''),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false);
  const selectedIdRef = useRef(selectedRunId);
  selectedIdRef.current = selectedRunId;
  const demoSelectedModel = useRef<ModelKey | null>(DEMO_RUN_DETAIL.run.selected_model);
  useEffect(() => {
    if (mode === 'demo') {
      setCatalog(DEMO_MODELS);
      setModelKeys(DEMO_MODELS.map((m) => m.key));
      setCatalogError('');
      return;
    }
    const controller = new AbortController();
    setCatalogError('');
    api
      .models(controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) {
          setCatalog(r.items);
          setModelKeys(r.items.map((m) => m.key));
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setCatalogError(errorMessage(e));
      });
    return () => controller.abort();
  }, [mode]);
  useEffect(() => {
    if (!selectedRunId && runs.length) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId, setSelectedRunId]);
  useEffect(() => {
    setDetail(null);
    setResults(null);
    setEvaluation(null);
    setLoadError('');
    if (!selectedRunId) {
      setLoading(false);
      return;
    }
    if (mode === 'demo') {
      const next = structuredClone(DEMO_RUN_DETAIL);
      next.run.selected_model = demoSelectedModel.current;
      setDetail(next);
      setLoading(false);
      const sorted = [...DEMO_RESULTS.items]
        .sort(
          (a, b) =>
            (b.validation_metrics[metric] ?? -Infinity) -
            (a.validation_metrics[metric] ?? -Infinity),
        )
        .map((r, i) => ({ ...r, rank: i + 1, sort_value: r.validation_metrics[metric] }));
      setResults({ ...DEMO_RESULTS, metric, items: sorted });
      return;
    }
    const id = selectedRunId,
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    async function load() {
      try {
        const next = await api.run(id, controller.signal);
        if (controller.signal.aborted) return;
        setDetail(next);
        setLoading(false);
        if (next.run.status === 'completed') {
          const nextResults = await api.results(id, metric, controller.signal);
          if (!controller.signal.aborted) setResults(nextResults);
          if (next.run.evaluation_status !== 'not_started') {
            const nextEvaluation = await api.evaluation(id, controller.signal);
            if (!controller.signal.aborted) setEvaluation(nextEvaluation);
          }
        }
        if (
          !controller.signal.aborted &&
          (next.run.status === 'queued' ||
            next.run.status === 'running' ||
            next.run.evaluation_status === 'queued' ||
            next.run.evaluation_status === 'running')
        )
          timer = setTimeout(load, 1800);
      } catch (e) {
        if (!controller.signal.aborted) {
          setLoadError(errorMessage(e));
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [selectedRunId, mode, metric, reload]);
  useEffect(() => {
    if (newOpen && !formDatasetId) setFormDatasetId(selectedDatasetId || datasets[0]?.id || '');
  }, [newOpen, formDatasetId, selectedDatasetId, datasets]);
  useEffect(() => {
    setFormDataset(null);
    setFeatures([]);
    setFormError('');
    if (!formDatasetId) return;
    if (mode === 'demo') {
      setFormDataset(DEMO_DATASET_DETAIL);
      setFeatures(DEMO_DATASET_DETAIL.inspection.channels);
      return;
    }
    const controller = new AbortController();
    setFormDataLoading(true);
    api
      .dataset(formDatasetId, controller.signal)
      .then((r) => {
        if (!controller.signal.aborted) {
          setFormDataset(r);
          setFeatures(r.inspection.channels);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setFormError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setFormDataLoading(false);
      });
    return () => controller.abort();
  }, [formDatasetId, mode]);
  async function createRun(event: FormEvent) {
    event.preventDefault();
    setFormError('');
    if (mode === 'demo') return;
    if (!formDataset || formDataset.dataset.status !== 'valid') {
      setFormError('입력 검사를 통과한 CSV를 선택해주세요.');
      return;
    }
    if (!features.length || !modelKeys.length) {
      setFormError('입력 채널과 학습할 모델을 각각 1개 이상 선택해주세요.');
      return;
    }
    const isoBoundary =
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;
    if (
      !isoBoundary.test(trainEnd) ||
      !isoBoundary.test(validationEnd) ||
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
      (formDataset.inspection.timezone_mode === 'aware' && !aware(trainEnd)) ||
      (formDataset.inspection.timezone_mode === 'naive' && aware(trainEnd))
    ) {
      setFormError(
        '두 경계의 시간대 표기를 CSV와 같게 맞춰주세요. Z나 +09:00 같은 표기를 임의로 더하거나 빼지 않아요.',
      );
      return;
    }
    if (!Number.isInteger(Number(seed)) || Number(seed) < 0 || Number(seed) > 2147483647) {
      setFormError('시드는 0부터 2,147,483,647 사이의 정수로 입력해주세요.');
      return;
    }
    setCreating(true);
    try {
      const next = await api.createRun({
        dataset_id: formDataset.dataset.id,
        feature_columns: features,
        models: modelKeys,
        train_end: trainEnd,
        validation_end: validationEnd,
        ranking_metric: metric,
        random_seed: Number(seed),
      });
      setSelectedDatasetId(formDataset.dataset.id);
      setSelectedRunId(next.run.id);
      setNewOpen(false);
      setDetail(next);
      toast('학습 요청을 보냈어요. 실제 완료 상태를 표시할게요.', 'success');
      await refreshRuns().catch((e) => toast(errorMessage(e), 'error'));
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  }
  async function chooseModel(key: ModelKey) {
    if (!detail) return;
    if (mode === 'demo') {
      demoSelectedModel.current = key;
      setDetail((d) => d && { ...d, run: { ...d.run, selected_model: key } });
      toast('미리보기에서 모델을 선택했어요. 실제 서버에는 저장하지 않아요.');
      return;
    }
    const id = detail.run.id;
    setBusy(true);
    try {
      const next = await api.selectModel(id, key);
      if (selectedIdRef.current === id) setDetail(next);
      toast('모델을 선택했어요. Test 평가는 별도로 시작해주세요.', 'success');
      await refreshRuns().catch((e) => toast(errorMessage(e), 'error'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  async function startTest() {
    if (!detail?.run.selected_model) return;
    setTestConfirm(false);
    if (mode === 'demo') {
      toast('미리보기에서는 예시 결과만 제공해요. 실제 Test 평가는 로그인 후 시작할 수 있어요.');
      return;
    }
    const id = detail.run.id;
    setBusy(true);
    try {
      const next = await api.evaluate(id);
      if (selectedIdRef.current === id) {
        setEvaluation(next);
        setReload((v) => v + 1);
      }
      toast('선택한 모델로 Test 평가를 시작했어요.', 'success');
      await refreshRuns().catch((e) => toast(errorMessage(e), 'error'));
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  }
  const dataset = datasets.find((d) => d.id === detail?.run.dataset_id),
    selectedResult = results?.items.find((r) => r.model_key === detail?.run.selected_model);
  const selectionLocked = !!detail && detail.run.evaluation_status !== 'not_started';
  const test = evaluation;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="MODEL LAB"
        title="모델 비교"
        description="같은 시간 분할로 학습하고, Valid 결과를 비교한 뒤 모델을 선택해요."
      >
        <button
          className="button secondary"
          onClick={() => {
            setReload((v) => v + 1);
            refreshRuns().catch((e) => toast(errorMessage(e), 'error'));
          }}
          disabled={loading || runsLoading}
        >
          <RefreshCw size={16} className={loading || runsLoading ? 'dm-spin' : ''} /> 새로고침
        </button>
        <button className="button primary" onClick={() => setNewOpen(true)}>
          <Plus size={17} /> 새 학습
        </button>
      </PageHeader>
      {mode === 'demo' && (
        <Notice>
          화면 미리보기예요. 아래 모델 지표와 학습 기록은 화면 구성 확인을 위한 예시예요.
        </Notice>
      )}
      {catalogError && <Notice tone="error">모델 목록을 불러오지 못했어요. {catalogError}</Notice>}
      <section className="surface dm-run-toolbar">
        <div className="dm-toolbar-label">
          <History size={19} />
          <div>
            <strong>학습 기록</strong>
            <span>{runs.length ? `${number(runs.length)}개 실행` : '첫 학습을 시작해주세요'}</span>
          </div>
        </div>
        <select
          className="select"
          aria-label="학습 기록 선택"
          value={selectedRunId || ''}
          disabled={!runs.length || busy}
          onChange={(e) => setSelectedRunId(e.target.value)}
        >
          <option value="" disabled>
            학습 기록 선택
          </option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {dateTime(r.created_at)} ·{' '}
              {datasets.find((d) => d.id === r.dataset_id)?.filename || r.dataset_id.slice(0, 8)} ·{' '}
              {statusNames[r.status]}
            </option>
          ))}
        </select>
        {detail && (
          <button className="button ghost" onClick={() => setSettingsOpen(true)}>
            <SlidersHorizontal size={16} /> 실행 설정
          </button>
        )}
      </section>
      {loadError && <Notice tone="error">{loadError}</Notice>}
      {loading ? (
        <div className="surface dm-detail-card">
          <Skeleton className="dm-title-skeleton" />
          <Skeleton className="dm-block-skeleton" />
        </div>
      ) : detail ? (
        <>
          <section className="surface dm-run-summary">
            <div>
              <Badge
                tone={
                  detail.run.status === 'completed'
                    ? 'green'
                    : detail.run.status === 'failed'
                      ? 'red'
                      : 'blue'
                }
              >
                {statusNames[detail.run.status]}
              </Badge>
              <h2>{dataset?.filename || '선택한 CSV'}</h2>
              <p>
                <span>{detail.configuration.feature_columns.length}개 입력 채널</span>
                <span>
                  {detail.run.completed_models} / {detail.run.total_models}개 모델 완료
                </span>
                <span>실행 {detail.run.id.slice(0, 8)}</span>
              </p>
            </div>
            <div className="dm-stage-flow">
              <span
                className={
                  detail.run.status === 'completed'
                    ? 'is-done'
                    : detail.run.status === 'running'
                      ? 'is-current'
                      : ''
                }
              >
                {detail.run.status === 'completed' ? <Check size={14} /> : <Clock3 size={14} />}
                Train
              </span>
              <ChevronRight size={14} />
              <span className={detail.run.status === 'completed' ? 'is-done' : ''}>
                {detail.run.status === 'completed' ? <Check size={14} /> : <Clock3 size={14} />}
                Valid 비교
              </span>
              <ChevronRight size={14} />
              <span className={test?.status === 'completed' ? 'is-done' : ''}>
                {test?.status === 'completed' ? <Check size={14} /> : <LockKeyhole size={14} />}Test
              </span>
            </div>
          </section>
          {detail.run.error_message && <Notice tone="error">{detail.run.error_message}</Notice>}
          {detail.run.status === 'queued' || detail.run.status === 'running' ? (
            <section className="surface dm-detail-card">
              <div className="dm-job-state">
                <RefreshCw className="dm-spin" size={28} />
                <div>
                  <h2>
                    {detail.run.status === 'queued'
                      ? '학습 순서를 기다리고 있어요'
                      : '선택한 모델을 학습하고 있어요'}
                  </h2>
                  <p>
                    {detail.run.completed_models}개 완료 / 전체 {detail.run.total_models}개 · 완료
                    상태는 서버에서 받아요.
                  </p>
                </div>
              </div>
              <progress
                className="dm-progress"
                aria-label="완료된 모델 수"
                value={detail.run.completed_models}
                max={detail.run.total_models}
              />
            </section>
          ) : null}
          {detail.run.status === 'completed' && results && (
            <>
              <section className="surface dm-detail-card dm-rank-card">
                <div className="section-heading">
                  <div>
                    <div className="dm-overline">VALIDATION</div>
                    <h2>어떤 모델을 사용할까요?</h2>
                    <p className="dm-caption">
                      순위는 비교 기준이에요. 사용할 모델은 직접 선택해주세요.
                    </p>
                  </div>
                  <label className="dm-sort">
                    <ArrowDownWideNarrow size={16} />
                    <span className="dm-visually-hidden">순위 지표</span>
                    <select
                      aria-label="순위 지표"
                      value={metric}
                      onChange={(e) => setMetric(e.target.value as RankingMetric)}
                    >
                      {Object.entries(metricNames).map(([key, name]) => (
                        <option key={key} value={key}>
                          {name} 높은 순
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {selectionLocked && (
                  <Notice>
                    <LockKeyhole size={15} /> Test 평가를 시작해서 모델 선택이 잠겼어요.
                  </Notice>
                )}
                <div className="dm-table-scroll">
                  <table className="dm-table dm-ranking-table">
                    <thead>
                      <tr>
                        <th>순위 / 모델</th>
                        <th>F1</th>
                        <th>Precision</th>
                        <th>Recall</th>
                        <th>ROC-AUC</th>
                        <th>학습 시간</th>
                        <th>
                          <span className="dm-visually-hidden">모델 선택</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.items.map((result) => (
                        <tr
                          key={result.model_key}
                          className={
                            detail.run.selected_model === result.model_key ? 'is-selected' : ''
                          }
                        >
                          <td>
                            <div className="dm-model-cell">
                              <span className={`dm-rank ${result.rank === 1 ? 'is-first' : ''}`}>
                                {result.rank ?? '—'}
                              </span>
                              <div>
                                <strong>{result.display_name}</strong>
                                <button
                                  className="dm-text-button"
                                  onClick={() => setMetricDetail(result)}
                                >
                                  지표 자세히 <ChevronRight size={12} />
                                </button>
                              </div>
                            </div>
                          </td>
                          <td className={metric === 'f1' ? 'dm-emphasis' : ''}>
                            {metricValue(result.validation_metrics.f1)}
                          </td>
                          <td>{metricValue(result.validation_metrics.precision)}</td>
                          <td>{metricValue(result.validation_metrics.recall)}</td>
                          <td>{metricValue(result.validation_metrics.roc_auc)}</td>
                          <td>{result.training_seconds.toFixed(2)}초</td>
                          <td>
                            <button
                              className={`button ${detail.run.selected_model === result.model_key ? 'dm-selected-button' : 'secondary'}`}
                              disabled={
                                busy ||
                                selectionLocked ||
                                detail.run.selected_model === result.model_key
                              }
                              onClick={() => chooseModel(result.model_key)}
                            >
                              {detail.run.selected_model === result.model_key ? (
                                <>
                                  <CircleCheck size={15} /> 선택됨
                                </>
                              ) : (
                                '선택'
                              )}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="dm-rank-footer">
                  <span>
                    <BarChart3 size={15} /> 지표의 양성 기준: <strong>UnNormal</strong>
                  </span>
                  <span>
                    Valid{' '}
                    {number(
                      detail.split?.validation.row_count ||
                        results.items[0]?.validation_metrics.sample_count ||
                        0,
                    )}
                    행
                  </span>
                </div>
              </section>
              <div className="dm-two-col dm-test-row">
                <section className="surface dm-detail-card">
                  <div className="section-heading">
                    <div>
                      <div className="dm-overline">YOUR SELECTION</div>
                      <h2>선택한 모델</h2>
                    </div>
                    <Boxes size={21} />
                  </div>
                  {selectedResult ? (
                    <>
                      <div className="dm-chosen-model">
                        <span>
                          <Check size={23} />
                        </span>
                        <div>
                          <h3>{selectedResult.display_name}</h3>
                          <p>
                            Valid F1 {metricValue(selectedResult.validation_metrics.f1)} · Recall{' '}
                            {metricValue(selectedResult.validation_metrics.recall)}
                          </p>
                        </div>
                      </div>
                      <p className="dm-caption">
                        Train으로 학습한 모델을 그대로 평가해요. Test 평가를 위해 다시 학습하지
                        않아요.
                      </p>
                    </>
                  ) : (
                    <EmptyState
                      title="사용할 모델을 선택해주세요"
                      description="위 Valid 결과에서 모델을 선택할 수 있어요."
                    />
                  )}
                </section>
                <section className="surface dm-detail-card">
                  <div className="section-heading">
                    <div>
                      <div className="dm-overline">HOLDOUT TEST</div>
                      <h2>Test 평가</h2>
                    </div>
                    {selectionLocked ? <LockKeyhole size={20} /> : <FlaskConical size={21} />}
                  </div>
                  {test?.status === 'completed' && test.metrics ? (
                    <>
                      <div className="dm-test-headline">
                        <div>
                          <span>F1</span>
                          <strong>{metricValue(test.metrics.f1)}</strong>
                        </div>
                        <div>
                          <span>Recall</span>
                          <strong>{metricValue(test.metrics.recall)}</strong>
                        </div>
                        <div>
                          <span>평가 행</span>
                          <strong>{number(test.metrics.sample_count)}</strong>
                        </div>
                      </div>
                      <button
                        className="button secondary"
                        onClick={() =>
                          setMetricDetail({
                            ...(selectedResult || results.items[0]),
                            display_name: `${selectedResult?.display_name || '선택 모델'} · Test`,
                            validation_metrics: test.metrics!,
                          })
                        }
                      >
                        Test 지표 자세히 <ArrowRight size={15} />
                      </button>
                    </>
                  ) : test?.status === 'queued' || test?.status === 'running' ? (
                    <div className="dm-job-state">
                      <RefreshCw size={21} className="dm-spin" />
                      <p>
                        {test.status === 'queued'
                          ? 'Test 평가 순서를 기다리고 있어요.'
                          : 'Test 구간을 평가하고 있어요.'}
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="dm-test-copy">
                        아직 Test 구간을 평가하지 않았어요.
                        <br />
                        평가를 시작하면 이 실행의 모델 선택이 잠겨요.
                      </p>
                      {test?.status === 'failed' && (
                        <Notice tone="error">
                          {test.error_message || 'Test 평가를 완료하지 못했어요.'}
                        </Notice>
                      )}
                      <button
                        className="button primary"
                        disabled={!detail.run.selected_model || busy || mode === 'demo'}
                        onClick={() => setTestConfirm(true)}
                      >
                        <Play size={15} /> 이 모델로 Test 평가
                      </button>
                      {mode === 'demo' && (
                        <p className="dm-caption">실제 Test 평가는 로그인 후 사용할 수 있어요.</p>
                      )}
                    </>
                  )}
                </section>
              </div>
            </>
          )}
          {detail.warnings.length > 0 && (
            <section className="dm-warning-stack">
              {detail.warnings.map((warning, i) => (
                <Notice tone="warning" key={i}>
                  {warning}
                </Notice>
              ))}
            </section>
          )}
        </>
      ) : (
        !loading && (
          <section className="surface">
            <EmptyState
              icon={FlaskConical}
              title="첫 모델 비교를 시작해볼까요?"
              description="등록한 CSV에서 입력 채널·모델·시간 경계를 선택해주세요."
              action={
                <button className="button primary" onClick={() => setNewOpen(true)}>
                  <Plus size={16} /> 새 학습
                </button>
              }
            />
          </section>
        )
      )}
      <Drawer
        open={newOpen}
        onOpenChange={(open) => {
          if (!creating) setNewOpen(open);
        }}
        title="새 학습"
        description="같은 Train · Valid · Test 구간으로 선택한 모델을 비교해요."
        className="dm-training-drawer"
        footer={
          <>
            <button
              className="button secondary"
              disabled={creating}
              onClick={() => setNewOpen(false)}
            >
              취소
            </button>
            <button
              form="dm-train-form"
              type="submit"
              className="button primary"
              disabled={
                creating || formDataLoading || !formDataset || !catalog.length || mode === 'demo'
              }
            >
              {creating ? <RefreshCw size={16} className="dm-spin" /> : <Play size={15} />}{' '}
              {creating ? '학습 요청 중' : '학습 시작'}
            </button>
          </>
        }
      >
        <form id="dm-train-form" className="dm-form-stack" onSubmit={createRun}>
          {mode === 'demo' && (
            <Notice>설정 화면 미리보기예요. 실제 학습 요청은 로그인 후 보낼 수 있어요.</Notice>
          )}
          <Field label="CSV" htmlFor="dm-train-dataset">
            <select
              id="dm-train-dataset"
              className="select"
              value={formDatasetId}
              onChange={(e) => setFormDatasetId(e.target.value)}
              disabled={creating}
            >
              <option value="" disabled>
                등록한 CSV 선택
              </option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.filename} · {number(d.row_count)}행
                  {d.status !== 'valid' ? ' · 입력 확인 필요' : ''}
                </option>
              ))}
            </select>
          </Field>
          {!datasets.length && (
            <Notice>
              등록한 CSV가 없어요.{' '}
              <Link to="/data" onClick={() => setNewOpen(false)}>
                데이터에서 먼저 등록해주세요.
              </Link>
            </Notice>
          )}
          {formDataLoading && <Skeleton className="dm-title-skeleton" />}
          {formDataset && (
            <>
              <div className="dm-form-section-heading">
                <h3>입력 채널</h3>
                <span>{features.length}개 선택</span>
                <button
                  type="button"
                  className="dm-text-button"
                  disabled={creating}
                  onClick={() =>
                    setFeatures(
                      features.length === formDataset.inspection.channels.length
                        ? []
                        : [...formDataset.inspection.channels],
                    )
                  }
                >
                  {features.length === formDataset.inspection.channels.length
                    ? '선택 해제'
                    : '전체 선택'}
                </button>
              </div>
              <div className="dm-feature-grid">
                {formDataset.inspection.channels.map((channel) => (
                  <label key={channel} className={features.includes(channel) ? 'is-checked' : ''}>
                    <input
                      type="checkbox"
                      checked={features.includes(channel)}
                      disabled={creating}
                      onChange={(e) =>
                        setFeatures((all) =>
                          e.target.checked ? [...all, channel] : all.filter((c) => c !== channel),
                        )
                      }
                    />
                    <code>{channel}</code>
                  </label>
                ))}
              </div>
              {formDataset.dataset.status !== 'valid' && (
                <Notice tone="warning">
                  이 CSV는 입력 확인이 필요해요. 수정한 파일을 등록한 뒤 학습해주세요.
                </Notice>
              )}
            </>
          )}
          <div className="dm-form-section-heading">
            <h3>비교할 모델</h3>
            <span>{modelKeys.length}개 선택</span>
          </div>
          <div className="dm-model-choices">
            {catalog.map((model) => (
              <label key={model.key} className={modelKeys.includes(model.key) ? 'is-checked' : ''}>
                <input
                  type="checkbox"
                  checked={modelKeys.includes(model.key)}
                  disabled={creating}
                  onChange={(e) =>
                    setModelKeys((all) =>
                      e.target.checked ? [...all, model.key] : all.filter((m) => m !== model.key),
                    )
                  }
                />
                <span className="dm-choice-icon">
                  {model.kind === 'baseline' ? (
                    <BarChart3 size={20} />
                  ) : model.kind === 'anomaly_detector' ? (
                    <Sparkles size={20} />
                  ) : (
                    <Boxes size={20} />
                  )}
                </span>
                <span>
                  <strong>{model.display_name}</strong>
                  <small>{model.description}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="dm-form-section-heading">
            <h3>시간 분할</h3>
            <Badge>순서 유지</Badge>
          </div>
          {formDataset && (
            <div className="dm-source-period">
              <span>CSV 측정 기간</span>
              <strong>
                {csvTime(formDataset.inspection.time_start)}
                <br />~ {csvTime(formDataset.inspection.time_end)}
              </strong>
            </div>
          )}
          <Field
            label="Train 종료 시각"
            htmlFor="dm-train-end"
            hint="이 시각까지의 행으로 학습해요."
          >
            <input
              id="dm-train-end"
              className="input dm-iso-input"
              placeholder="2018-06-30T23:59:00"
              value={trainEnd}
              onChange={(e) => setTrainEnd(e.target.value)}
              required
              disabled={creating}
            />
          </Field>
          <Field
            label="Valid 종료 시각"
            htmlFor="dm-valid-end"
            hint="Train 이후부터 이 시각까지 비교하고, 나머지 이후 행은 Test로 남겨요."
          >
            <input
              id="dm-valid-end"
              className="input dm-iso-input"
              placeholder="2018-07-31T23:59:00"
              value={validationEnd}
              onChange={(e) => setValidationEnd(e.target.value)}
              required
              disabled={creating}
            />
          </Field>
          <div className="dm-split-example">
            <span>Train</span>
            <span>Valid</span>
            <span>Test</span>
          </div>
          <p className="dm-caption">
            각 구간에 행이 있어야 해요. 시간대가 있는 CSV는 경계에도 같은 시간대를 입력해주세요.
          </p>
          <div className="dm-form-grid">
            <Field label="순위 지표" htmlFor="dm-ranking">
              <select
                id="dm-ranking"
                className="select"
                value={metric}
                onChange={(e) => setMetric(e.target.value as RankingMetric)}
                disabled={creating}
              >
                {Object.entries(metricNames).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="랜덤 시드" htmlFor="dm-seed">
              <input
                id="dm-seed"
                type="number"
                min="0"
                max="2147483647"
                step="1"
                className="input"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                required
                disabled={creating}
              />
            </Field>
          </div>
          <Notice>
            행을 섞거나 결측 처리·PCA·파생변수 생성을 자동으로 하지 않아요. 전처리한 숫자 채널을
            그대로 학습해요.
          </Notice>
          {formError && <Notice tone="error">{formError}</Notice>}
        </form>
      </Drawer>
      <Modal
        open={testConfirm}
        onOpenChange={setTestConfirm}
        title="선택한 모델로 Test를 평가할까요?"
        description="Test 평가를 시작하면 이 실행에서는 모델을 바꿀 수 없어요."
        footer={
          <>
            <button className="button secondary" onClick={() => setTestConfirm(false)}>
              돌아가기
            </button>
            <button
              className="button primary"
              onClick={startTest}
              disabled={busy || mode === 'demo'}
            >
              <FlaskConical size={16} /> Test 평가 시작
            </button>
          </>
        }
      >
        <div className="dm-form-stack">
          <div className="dm-confirm-model">
            <Boxes size={25} />
            <strong>{selectedResult?.display_name || detail?.run.selected_model}</strong>
          </div>
          <p>
            Train에서 학습한 모델을 그대로 사용해요. Test 결과를 보고 이 실행의 모델이나 기준을 다시
            조정하지 않아요.
          </p>
          <Notice>Valid 결과를 확인하고 모델 선택을 마쳤다면 시작해주세요.</Notice>
        </div>
      </Modal>
      <Drawer
        open={!!metricDetail}
        onOpenChange={(open) => {
          if (!open) setMetricDetail(null);
        }}
        title={metricDetail?.display_name || '평가 지표'}
        description="계산 결과와 실제·예측 라벨의 분포를 확인해요."
      >
        {metricDetail && <Metrics metrics={metricDetail.validation_metrics} />}
      </Drawer>
      <Drawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="실행 설정"
        description="이 실행에 사용한 입력과 시간 경계를 확인해요."
      >
        {detail && (
          <div className="dm-form-stack">
            <div className="dm-config-grid">
              <span>CSV</span>
              <strong>{dataset?.filename || detail.configuration.dataset_id}</strong>
              <span>Train 종료</span>
              <strong>{csvTime(detail.configuration.train_end)}</strong>
              <span>Valid 종료</span>
              <strong>{csvTime(detail.configuration.validation_end)}</strong>
              <span>랜덤 시드</span>
              <strong>{detail.configuration.random_seed}</strong>
              <span>모델</span>
              <strong>{detail.configuration.models.join(' · ')}</strong>
            </div>
            <h3>입력 채널 순서</h3>
            <ol className="dm-feature-order">
              {detail.configuration.feature_columns.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ol>
            {detail.split && (
              <div className="dm-config-grid">
                <span>Train</span>
                <strong>{number(detail.split.train.row_count)}행</strong>
                <span>Valid</span>
                <strong>{number(detail.split.validation.row_count)}행</strong>
                <span>Test</span>
                <strong>{number(detail.split.test.row_count)}행</strong>
              </div>
            )}
            <h3>입력 SHA-256</h3>
            <code className="dm-hash">{detail.input_sha256}</code>
            <h3>실행 환경</h3>
            <div className="dm-config-grid">
              {Object.entries(detail.environment).map(([key, value]) => (
                <div className="dm-config-pair" key={key}>
                  <span>{key}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
