import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartNoAxesCombined, LoaderCircle, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, ApiError, errorMessage } from '../lib/api';
import {
  emptyPredictionOverlay,
  predictionApi,
  type PredictionIntervalsResponse,
  type PredictionOverlay,
  type PredictionResponse,
  type PredictionSplit,
} from '../lib/prediction-api';
import type { AppMode, ModelKey, RunDetail, RunResults } from '../types';
import { csvTimestampToNumber, type SelectedRange } from './TimeSeriesChart';
import { Field, Notice } from './ui';
import './prediction.css';

interface Props {
  datasetId: string | null;
  channel: string;
  mode: AppMode;
  selection: SelectedRange | null;
  onChange: (value: PredictionOverlay) => void;
}

const INTERVAL_PAGE_SIZE = 500;

const POINT_PAGE_SIZE = 50;

const MAX_DISPLAY_POINTS = 1000;

function toRange(item: PredictionIntervalsResponse['items'][number]): SelectedRange {
  return {
    start: {
      time: csvTimestampToNumber(item.start_time),
      timestamp: item.start_time,
      value: null,
      label: '1',
    },
    end: {
      time: csvTimestampToNumber(item.end_time),
      timestamp: item.end_time,
      value: null,
      label: '1',
    },
  };
}

export default function PredictionPanel({ datasetId, channel, mode, selection, onChange }: Props) {
  const { user, runs, selectedRunId, setSelectedRunId, refreshRuns } = useApp();

  const eligibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.dataset_id === datasetId && run.status === 'completed' && run.owner_id === user?.id,
      ),
    [runs, datasetId, user?.id],
  );

  const [runId, setRunId] = useState('');

  const [modelKey, setModelKey] = useState<ModelKey | ''>('');

  const [split, setSplit] = useState<PredictionSplit>('validation');

  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);

  const [results, setResults] = useState<RunResults | null>(null);

  const [loadingRun, setLoadingRun] = useState(false);

  const [loadingIntervals, setLoadingIntervals] = useState(false);

  const [intervalResponse, setIntervalResponse] = useState<PredictionIntervalsResponse | null>(
    null,
  );

  const [intervals, setIntervals] = useState<SelectedRange[]>([]);

  const [intervalError, setIntervalError] = useState('');

  const [runError, setRunError] = useState('');

  const [refreshVersion, setRefreshVersion] = useState(0);

  const [points, setPoints] = useState<PredictionResponse | null>(null);

  const [loadingPoints, setLoadingPoints] = useState(false);

  const [pointError, setPointError] = useState('');

  const [pointOffset, setPointOffset] = useState(0);

  const [pointRetry, setPointRetry] = useState(0);

  const [intervalRetry, setIntervalRetry] = useState(0);

  const intervalController = useRef<AbortController | null>(null);

  const generation = useRef(0);

  const activeRunUpdatedAt = eligibleRuns.find((run) => run.id === runId)?.updated_at;

  const modelDefinition = results?.items.find((item) => item.model_key === modelKey);

  const testAllowed = !!(
    runDetail &&
    modelKey &&
    runDetail.run.selected_model === modelKey &&
    runDetail.run.evaluation_status === 'completed'
  );

  const ready = !!(
    mode === 'live' &&
    datasetId &&
    runId &&
    modelKey &&
    modelDefinition &&
    runDetail?.run.id === runId &&
    (split === 'validation' || testAllowed)
  );

  const label = modelDefinition
    ? `${modelDefinition.display_name} · ${split === 'test' ? 'Test' : 'Valid'}`
    : '';

  // 계정·자료가 달라지면 이전 예측이나 모델 연결이 새 검토에 섞이지 않게 한다.
  useEffect(() => {
    const selected = eligibleRuns.some((run) => run.id === selectedRunId) ? selectedRunId! : '';

    setRunId(selected);
    setModelKey('');
    setSplit('validation');
    setRunDetail(null);
    setResults(null);
    onChange(emptyPredictionOverlay);
  }, [datasetId, user?.id, mode]);

  useEffect(() => {
    const preservedModel = runDetail?.run.id === runId ? modelKey : '';

    setRunDetail(null);
    setResults(null);
    setModelKey('');
    setRunError('');
    setLoadingRun(false);
    onChange(emptyPredictionOverlay);
    if (mode !== 'live' || !runId || !datasetId) return;
    const controller = new AbortController();

    setLoadingRun(true);
    Promise.all([api.run(runId, controller.signal), api.results(runId, 'f1', controller.signal)])
      .then(([detail, result]) => {
        if (controller.signal.aborted) return;
        if (detail.run.dataset_id !== datasetId || detail.run.status !== 'completed') {
          throw new ApiError(
            '이 데이터의 완료된 실행을 선택해주세요.',
            422,
            'RUN_CONTEXT_MISMATCH',
          );
        }
        setRunDetail(detail);
        setResults(result);
        // 지표 1위로 자동 선택하지 않고 사용자가 이미 선택한 모델만 복원한다.
        setModelKey(
          result.items.some((item) => item.model_key === preservedModel)
            ? preservedModel
            : result.items.some((item) => item.model_key === detail.run.selected_model)
              ? detail.run.selected_model!
              : '',
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setRunError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingRun(false);
      });
    return () => controller.abort();
  }, [runId, datasetId, mode, activeRunUpdatedAt, refreshVersion]);

  useEffect(() => {
    const requestGeneration = ++generation.current;

    intervalController.current?.abort();
    setIntervals([]);
    setIntervalResponse(null);
    setIntervalError('');
    onChange(emptyPredictionOverlay);
    if (!ready || !modelKey) {
      setLoadingIntervals(false);
      return;
    }
    const controller = new AbortController();

    intervalController.current = controller;
    setLoadingIntervals(true);
    onChange({ ...emptyPredictionOverlay, label, status: '모델 예측 구간을 불러오고 있어요.' });
    predictionApi
      .intervals(
        runId,
        { model_key: modelKey, split, limit: INTERVAL_PAGE_SIZE, offset: 0 },
        controller.signal,
      )
      .then((response) => {
        if (controller.signal.aborted || generation.current !== requestGeneration) return;
        if (
          response.run_id !== runId ||
          response.dataset_id !== datasetId ||
          response.model_key !== modelKey ||
          response.split !== split
        ) {
          throw new ApiError(
            '선택한 실행의 예측 결과인지 확인하지 못했어요.',
            503,
            'PREDICTION_CONTEXT_MISMATCH',
          );
        }
        const ranges = response.items.map(toRange);

        setIntervalResponse(response);
        setIntervals(ranges);
        onChange({
          intervals: ranges,
          label,
          status: '',
          truncated: response.total > ranges.length,
          modelResult: { run_id: runId, model_key: modelKey, split },
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || generation.current !== requestGeneration) return;
        const message = errorMessage(error);

        setIntervalError(message);
        onChange({ ...emptyPredictionOverlay, label, status: message });
      })
      .finally(() => {
        if (!controller.signal.aborted && generation.current === requestGeneration)
          setLoadingIntervals(false);
      });
    return () => {
      controller.abort();
      // 더 불러오기 요청도 현재 화면을 떠날 때 함께 취소한다.
      intervalController.current?.abort();
    };
  }, [datasetId, channel, ready, runId, modelKey, split, label, intervalRetry]);

  const loadMoreIntervals = async () => {
    if (!ready || !modelKey || !intervalResponse || loadingIntervals) return;
    const requestGeneration = generation.current;

    const controller = new AbortController();

    intervalController.current?.abort();
    intervalController.current = controller;
    setLoadingIntervals(true);
    setIntervalError('');
    try {
      const response = await predictionApi.intervals(
        runId,
        {
          model_key: modelKey,
          split,
          limit: INTERVAL_PAGE_SIZE,
          offset: intervals.length,
        },
        controller.signal,
      );

      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (
        response.run_id !== runId ||
        response.dataset_id !== datasetId ||
        response.model_key !== modelKey ||
        response.split !== split
      ) {
        throw new ApiError(
          '선택한 실행의 예측 결과인지 확인하지 못했어요.',
          503,
          'PREDICTION_CONTEXT_MISMATCH',
        );
      }
      const ranges = [...intervals, ...response.items.map(toRange)];

      setIntervals(ranges);
      setIntervalResponse(response);
      onChange({
        intervals: ranges,
        label,
        status: '',
        truncated: response.total > ranges.length,
        modelResult: { run_id: runId, model_key: modelKey, split },
      });
    } catch (error) {
      if (!controller.signal.aborted && generation.current === requestGeneration)
        setIntervalError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted && generation.current === requestGeneration)
        setLoadingIntervals(false);
    }
  };

  useEffect(() => {
    setPointOffset(0);
    setPoints(null);
  }, [datasetId, channel, runId, modelKey, split, selection]);

  // 전체 분할의 구간 막대와 달리 표는 직접 고른 시간만 읽고, 일부 행이면 개수를 알린다.
  useEffect(() => {
    setPointError('');
    if (!ready || !modelKey || !selection) {
      setPoints(null);
      setLoadingPoints(false);
      return;
    }
    const controller = new AbortController();

    setLoadingPoints(true);
    predictionApi
      .points(
        runId,
        {
          model_key: modelKey,
          split,
          start_time: selection.start.timestamp,
          end_time: selection.end.timestamp,
          limit: POINT_PAGE_SIZE,
          offset: pointOffset,
        },
        controller.signal,
      )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (
          response.run_id !== runId ||
          response.dataset_id !== datasetId ||
          response.model_key !== modelKey ||
          response.split !== split
        ) {
          throw new ApiError(
            '선택한 실행의 예측값인지 확인하지 못했어요.',
            503,
            'PREDICTION_CONTEXT_MISMATCH',
          );
        }
        setPoints((previous) => ({
          ...response,
          items: pointOffset && previous ? [...previous.items, ...response.items] : response.items,
        }));
      })
      .catch((error) => {
        if (!controller.signal.aborted) setPointError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPoints(false);
      });
    return () => controller.abort();
  }, [datasetId, channel, ready, runId, modelKey, split, selection, pointOffset, pointRetry]);

  const refresh = async () => {
    setRunError('');
    try {
      await refreshRuns();
      setRefreshVersion((version) => version + 1);
    } catch (error) {
      setRunError(errorMessage(error));
    }
  };

  return (
    <section className="surface prediction-panel" aria-labelledby="prediction-heading">
      <div className="section-heading">
        <div>
          <h2 id="prediction-heading">예측 결과</h2>
          <p>모델 예측을 원본 라벨·직접 내린 판단과 구분해서 확인합니다.</p>
        </div>
        <button
          className="icon-button"
          aria-label="실행 목록 새로고침"
          title="실행 목록 새로고침"
          onClick={refresh}
          disabled={mode !== 'live'}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {mode === 'demo' ? (
        <Notice>모델 예측은 로그인 후 실제 데이터의 학습 실행을 선택해서 확인할 수 있어요.</Notice>
      ) : (
        <>
          <div className="prediction-controls">
            <Field label="예측 실행" htmlFor="prediction-run">
              <select
                id="prediction-run"
                className="select"
                value={runId}
                onChange={(event) => {
                  onChange(emptyPredictionOverlay);
                  setRunId(event.target.value);
                  setSelectedRunId(event.target.value || null);
                  setSplit('validation');
                }}
              >
                <option value="">완료된 실행 선택</option>
                {eligibleRuns.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id.slice(0, 8)} · {new Date(run.created_at * 1000).toLocaleString('ko-KR')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="예측 모델" htmlFor="prediction-model">
              <select
                id="prediction-model"
                className="select"
                disabled={!results || loadingRun}
                value={modelKey}
                onChange={(event) => {
                  onChange(emptyPredictionOverlay);
                  setModelKey(event.target.value as ModelKey | '');
                  setSplit('validation');
                }}
              >
                <option value="">학습한 모델 선택</option>
                {results?.items.map((result) => (
                  <option key={result.model_key} value={result.model_key}>
                    {result.display_name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="평가 구간" htmlFor="prediction-split">
              <select
                id="prediction-split"
                className="select"
                value={split}
                onChange={(event) => {
                  onChange(emptyPredictionOverlay);
                  setSplit(event.target.value as PredictionSplit);
                }}
                disabled={!modelKey}
              >
                <option value="validation">Valid</option>
                <option value="test" disabled={!testAllowed}>
                  Test · 선택 모델 평가 완료 후
                </option>
              </select>
            </Field>
          </div>
          {!eligibleRuns.length && (
            <p className="prediction-hint">
              <ChartNoAxesCombined size={16} />이 데이터의 완료된 학습 실행이 없어요.{' '}
              <Link to="/models">모델 학습으로 이동</Link>
            </p>
          )}
          {loadingRun && (
            <p className="prediction-hint">
              <LoaderCircle className="rv-spin" size={16} />
              학습한 모델을 불러오고 있어요.
            </p>
          )}
          {runError && <Notice tone="error">{runError}</Notice>}
          {modelKey && !testAllowed && (
            <p className="prediction-hint">
              Test는 선택한 모델의 평가 완료 후 조회할 수 있어요.{' '}
              <Link to="/models">모델 선택·평가</Link>
            </p>
          )}
          {loadingIntervals && (
            <p className="prediction-hint">
              <LoaderCircle className="rv-spin" size={16} />
              모델 예측 구간을 읽고 있어요.
            </p>
          )}
          {intervalError && (
            <Notice tone="error">
              {intervalError}{' '}
              <button
                className="button secondary small"
                onClick={() => setIntervalRetry((version) => version + 1)}
              >
                예측 다시 불러오기
              </button>
            </Notice>
          )}
          {intervalResponse && (
            <div className="prediction-summary">
              <span>
                <i />
                {label} · 예측 1 구간 {intervals.length.toLocaleString('ko-KR')} /{' '}
                {intervalResponse.total.toLocaleString('ko-KR')}개
              </span>
              <span>아래 그래프의 주황색 구간 · 고장 확정 아님</span>
              {intervals.length < intervalResponse.total && (
                <button
                  className="button secondary small"
                  onClick={loadMoreIntervals}
                  disabled={loadingIntervals}
                >
                  예측 구간 더 불러오기
                </button>
              )}
            </div>
          )}
          {ready && !selection && (
            <p className="prediction-hint">
              주황색 예측 구간을 누르거나 그래프를 드래그하면 해당 시간의 예측값과 점수를 확인할 수
              있어요.
            </p>
          )}
          {ready && selection && (
            <div className="prediction-points">
              <h3>선택한 구간의 예측값</h3>
              <p>
                {selection.start.timestamp.replace('T', ' ')} —{' '}
                {selection.end.timestamp.replace('T', ' ')}
              </p>
              {pointError && (
                <Notice tone="error">
                  {pointError}{' '}
                  <button
                    className="button secondary small"
                    onClick={() => setPointRetry((version) => version + 1)}
                  >
                    예측값 다시 불러오기
                  </button>
                </Notice>
              )}
              {points && (
                <>
                  <p>
                    {points.items.length.toLocaleString('ko-KR')} /{' '}
                    {points.total.toLocaleString('ko-KR')}행 ·{' '}
                    {points.score_type === 'probability'
                      ? '이상 라벨의 모델 확률'
                      : `재구성 오차 · 학습 기준 ${points.threshold?.toPrecision(5) ?? '—'}`}
                  </p>
                  {!points.total ? (
                    <Notice>선택한 구간에 해당 분할의 예측값이 없습니다.</Notice>
                  ) : (
                    <div className="prediction-table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>시각</th>
                            <th>원본 라벨</th>
                            <th>모델 예측</th>
                            <th>
                              {points.score_type === 'probability' ? '모델 확률' : '재구성 오차'}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {points.items.map((point) => (
                            <tr key={point.row_index}>
                              <td>{point.timestamp.replace('T', ' ')}</td>
                              <td>{point.actual_label}</td>
                              <td>
                                <span className={point.predicted_code ? 'prediction-positive' : ''}>
                                  {point.predicted_label} ({point.predicted_code})
                                </span>
                              </td>
                              <td>
                                {points.score_type === 'probability'
                                  ? `${(point.score * 100).toFixed(2)}%`
                                  : point.score.toPrecision(5)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {points.items.length < points.total &&
                    points.items.length < MAX_DISPLAY_POINTS && (
                      <button
                        className="button secondary small"
                        disabled={loadingPoints}
                        onClick={() => setPointOffset(points.items.length)}
                      >
                        예측값 더 불러오기
                      </button>
                    )}
                  {points.items.length >= MAX_DISPLAY_POINTS &&
                    points.items.length < points.total && (
                      <p className="prediction-hint">
                        처음 1,000행을 표시했어요. 구간을 더 좁혀 나머지 시간을 확인해주세요.
                      </p>
                    )}
                </>
              )}
              {loadingPoints && (
                <p className="prediction-hint">
                  <LoaderCircle className="rv-spin" size={16} />
                  예측값을 불러오고 있어요.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
