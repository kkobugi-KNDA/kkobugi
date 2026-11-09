import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Download, LoaderCircle, Pause, Play, RotateCcw, Radio } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useExpertise } from '../context/ExpertiseContext';
import { api, errorMessage } from '../lib/api';
import {
  axDownload,
  axRequest,
  type ReplayBatch,
  type ReplayManifest,
  type ReplayPoint,
} from '../lib/ax-api';
import AxAssistantPanel from '../components/AxAssistantPanel';
import PumpScene from '../components/PumpScene';
import { Badge, EmptyState, Field, Notice, PageHeader } from '../components/ui';
import '../components/ax.css';

interface Signal {
  key: string;
  timestamp: string;
  channel: string;
  value: number | null;
  score: number;
}

function LiveChart({ points, channel }: { points: ReplayPoint[]; channel: string }) {
  const finite = points.filter((point) => point.value !== null && Number.isFinite(point.value));

  const minimum = finite.length ? Math.min(...finite.map((point) => point.value as number)) : 0;

  const maximum = finite.length ? Math.max(...finite.map((point) => point.value as number)) : 1;

  const span = Math.max(maximum - minimum, Math.abs(maximum) * 0.01, 0.001);

  const firstRow = points[0]?.row_index ?? 0;

  const lastRow = points.at(-1)?.row_index ?? firstRow + 1;

  const x = (point: ReplayPoint) =>
    65 + ((point.row_index - firstRow) / Math.max(1, lastRow - firstRow)) * 900;

  const y = (point: ReplayPoint) => 225 - (((point.value ?? minimum) - minimum) / span) * 170;

  const path = points
    .map((point, index) =>
      point.value === null
        ? ''
        : `${index === 0 || points[index - 1].value === null ? 'M' : 'L'}${x(point)},${y(point)}`,
    )
    .join(' ');

  return (
    <div className="ax-live-chart">
      <svg
        viewBox="0 0 1000 280"
        role="img"
        aria-label={`${channel} 수신된 값 그래프. ${points.length}개 표시`}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1="65"
              x2="965"
              y1={225 - fraction * 170}
              y2={225 - fraction * 170}
              stroke="var(--border, #dfe6ef)"
            />
            <text x="55" y={230 - fraction * 170} textAnchor="end" fill="#718096" fontSize="12">
              {(minimum + span * fraction).toFixed(2)}
            </text>
          </g>
        ))}
        <path d={path} stroke="#2f6aab" strokeWidth="2" fill="none" />
        {finite
          .filter((point) => point.predicted_code === 1)
          .map((point) => (
            <circle key={point.row_index} cx={x(point)} cy={y(point)} r="3" fill="#e34e53" />
          ))}
        <text x="65" y="261" fontSize="12" fill="#718096">
          {points[0]?.timestamp.replace('T', ' ').slice(0, 19)}
        </text>
        <text x="965" y="261" textAnchor="end" fontSize="12" fill="#718096">
          {points.at(-1)?.timestamp.replace('T', ' ').slice(0, 19)}
        </text>
      </svg>
      {!points.length && (
        <div className="ax-chart-await">재생을 시작하면 도착한 값부터 표시됩니다.</div>
      )}
    </div>
  );
}

export default function MonitorPage() {
  const { runs, datasets, selectedRunId, setSelectedRunId, refreshRuns, mode, user } = useApp();

  const { isExpert } = useExpertise();

  const eligibleRuns = useMemo(
    () =>
      runs.filter(
        (run) =>
          run.status === 'completed' &&
          run.owner_id === user?.id &&
          run.evaluation_status === 'completed' &&
          ['xgboost', 'autoencoder'].includes(run.selected_model || ''),
      ),
    [runs, user?.id],
  );

  const [runId, setRunId] = useState('');

  const [replays, setReplays] = useState<ReplayManifest[]>([]);

  const [replay, setReplay] = useState<ReplayManifest | null>(null);

  const [channel, setChannel] = useState('');

  const [points, setPoints] = useState<ReplayPoint[]>([]);

  const [signals, setSignals] = useState<Signal[]>([]);

  const [selectedSignal, setSelectedSignal] = useState<Signal | null>(null);

  const [pendingAlert, setPendingAlert] = useState(false);

  const [cursor, setCursor] = useState(0);

  const [playing, setPlaying] = useState(false);

  const [speed, setSpeed] = useState(60);

  const [sourceSplit, setSourceSplit] = useState<'full' | 'test'>('full');

  const [creating, setCreating] = useState(false);

  const [loadingBatch, setLoadingBatch] = useState(false);

  const [error, setError] = useState('');

  const [replayListError, setReplayListError] = useState('');

  const [sourceType, setSourceType] = useState<ReplayBatch['score_type']>('probability');

  const activeRequest = useRef<AbortController | null>(null);

  const creationRequest = useRef<AbortController | null>(null);

  const generation = useRef(0);

  const chosenRun = eligibleRuns.find((run) => run.id === runId);

  useEffect(() => {
    if (!eligibleRuns.some((run) => run.id === runId))
      setRunId(
        selectedRunId
          ? eligibleRuns.find((run) => run.id === selectedRunId)?.id || ''
          : eligibleRuns[0]?.id || '',
      );
  }, [eligibleRuns, selectedRunId, runId]);

  useEffect(() => {
    const controller = new AbortController();

    setReplays([]);
    setReplayListError('');
    if (mode === 'live')
      axRequest<{ items: ReplayManifest[] }>('/replays', { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) setReplays(response.items);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setReplayListError(errorMessage(failure));
        });
    return () => controller.abort();
  }, [mode, user?.id]);

  // 각 브라우저가 자기 재생 위치만 관리한다. 다른 사용자의 재생 위치를 덮어쓰지 않는다.
  useEffect(() => {
    generation.current += 1;
    activeRequest.current?.abort();
    creationRequest.current?.abort();
    setCreating(false);
    setPlaying(false);
    setReplay(null);
    setChannel('');
    setPoints([]);
    setSignals([]);
    setSelectedSignal(null);
    setPendingAlert(false);
    setCursor(0);
    setLoadingBatch(false);
    setError('');
    return () => {
      activeRequest.current?.abort();
      creationRequest.current?.abort();
    };
  }, [runId, user?.id, mode]);

  async function createReplay() {
    if (!chosenRun?.selected_model || creating || mode !== 'live') return;
    const requestGeneration = ++generation.current;

    const controller = new AbortController();

    creationRequest.current = controller;
    setCreating(true);
    setError('');
    try {
      const manifest = await axRequest<ReplayManifest>('/replays', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          run_id: runId,
          model_key: chosenRun.selected_model,
          row_count: 230000,
          source_split: sourceSplit,
        }),
      });

      if (requestGeneration !== generation.current || controller.signal.aborted) return;
      setReplay(manifest);
      setReplays((previous) => [manifest, ...previous.filter((item) => item.id !== manifest.id)]);
      setChannel(manifest.feature_columns[0] || '');
      setSelectedRunId(runId);
      resetPlayback();
    } catch (failure) {
      if (!controller.signal.aborted && requestGeneration === generation.current)
        setError(errorMessage(failure));
    } finally {
      if (requestGeneration === generation.current) setCreating(false);
    }
  }

  function resetPlayback() {
    activeRequest.current?.abort();
    setLoadingBatch(false);
    setPlaying(false);
    setCursor(0);
    setPoints([]);
    setSignals([]);
    setSelectedSignal(null);
    setPendingAlert(false);
  }

  function chooseReplay(id: string) {
    const manifest = replays.find((item) => item.id === id && item.run_id === runId);

    if (!manifest) return;
    generation.current += 1;
    resetPlayback();
    setReplay(manifest);
    setChannel(manifest.feature_columns[0] || '');
    setError('');
  }

  // 아직 도착하지 않은 뒷부분을 한꺼번에 보내지 않고, 표시할 행만 서버에서 예측한다.
  useEffect(() => {
    if (!playing || !replay || !channel || mode !== 'live') return;
    const controller = new AbortController();

    activeRequest.current = controller;
    const timer = setTimeout(
      async () => {
        setLoadingBatch(true);
        try {
          const batch = await axRequest<ReplayBatch>(
            `/replays/${replay.id}/batch?cursor=${cursor}&limit=${speed}&channel=${encodeURIComponent(channel)}`,
            { signal: controller.signal },
          );

          if (controller.signal.aborted) return;
          setSourceType(batch.score_type);
          setPoints((previous) => [...previous, ...batch.points].slice(-600));
          const newSignals = batch.points
            .filter((point) => point.predicted_code === 1)
            .map((point) => ({
              key: `${replay.id}:${point.row_index}:${channel}`,
              timestamp: point.timestamp,
              channel,
              value: point.value,
              score: point.score,
            }));

          setSignals((previous) => [...newSignals.reverse(), ...previous].slice(0, 40));
          if (newSignals.length) setPendingAlert(true);
          setCursor(batch.next_cursor);
          if (batch.done) setPlaying(false);
        } catch (failure) {
          if (!controller.signal.aborted) {
            setError(errorMessage(failure));
            setPlaying(false);
          }
        } finally {
          if (!controller.signal.aborted) setLoadingBatch(false);
        }
      },
      cursor === 0 ? 0 : 1000,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [playing, replay?.id, channel, cursor, speed, mode]);

  const latest = points.at(-1);

  const alertActive = pendingAlert || latest?.predicted_code === 1;

  const runReplays = replays.filter((item) => item.run_id === runId);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="LIVE / SIGNALS"
        title={isExpert ? '실시간 추론 모니터링' : '실시간 모니터링'}
        description="생성한 데이터를 차례로 수신하며 학습된 모델로 점검 신호를 확인합니다."
      >
        <Badge tone={playing ? 'green' : 'slate'}>{playing ? '수신 중' : '일시 정지'}</Badge>
      </PageHeader>
      <section className="surface ax-monitor-controls">
        <div className="ax-input-grid">
          <Field
            label={isExpert ? 'Test 평가를 마친 모델 실행' : '사용할 AI'}
            htmlFor="ax-monitor-run"
          >
            <select
              className="input"
              id="ax-monitor-run"
              value={runId}
              onChange={(event) => setRunId(event.target.value)}
            >
              <option value="" disabled>
                평가를 마친 학습을 선택해주세요
              </option>
              {eligibleRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {datasets.find((dataset) => dataset.id === run.dataset_id)?.filename ||
                    '학습 기록'}{' '}
                  · {run.selected_model === 'xgboost' ? 'XGBoost' : 'AutoEncoder'} ·{' '}
                  {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="재생할 원본 범위" htmlFor="ax-replay-source">
            <select
              className="input"
              id="ax-replay-source"
              value={sourceSplit}
              disabled={creating}
              onChange={(event) => setSourceSplit(event.target.value as 'full' | 'test')}
            >
              <option value="full">전체 원본 · 학습 구간 포함</option>
              <option value="test">Test 구간만</option>
            </select>
          </Field>
          <Field label="생성한 재생 데이터" htmlFor="ax-replay-file">
            <select
              className="input"
              id="ax-replay-file"
              value={replay?.id || ''}
              disabled={creating}
              onChange={(event) => chooseReplay(event.target.value)}
            >
              <option value="">새로 생성하거나 기존 데이터를 선택하세요</option>
              {runReplays.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.total_rows.toLocaleString()}행 ·{' '}
                  {item.source_split === 'full' ? '전체 원본' : 'Test'} · {item.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="ax-actions">
          <button
            className="button ghost"
            onClick={() => refreshRuns().catch((failure) => setError(errorMessage(failure)))}
          >
            학습 목록 새로고침
          </button>
          <button
            className="button secondary"
            disabled={!chosenRun || creating || mode !== 'live'}
            onClick={createReplay}
          >
            {creating ? <LoaderCircle className="spin" size={16} /> : <Radio size={16} />}{' '}
            {creating ? '23만 행 생성 중' : '23만 행 데이터 생성'}
          </button>
          {replay && (
            <button
              className="button ghost"
              onClick={() =>
                axDownload(
                  `/replays/${replay.id}/file`,
                  `pump-replay-${replay.id.slice(0, 8)}.csv`,
                ).catch((failure) => setError(errorMessage(failure)))
              }
            >
              <Download size={16} />
              CSV
            </button>
          )}
          <Link className="text-link" to="/models">
            모델 학습으로 이동
          </Link>
        </div>
        <p className="ax-provenance">
          생성 데이터 ·{' '}
          {(replay?.source_split || sourceSplit) === 'full'
            ? '학습에 사용한 구간을 포함한 전체 원본'
            : '원본 Test 구간'}
          의 값을 시간순으로 반복한 자료입니다. 실제 설비의 새 측정값이나 독립적인 성능 평가 자료가
          아닙니다.
        </p>
        {(error || replayListError) && <Notice tone="error">{error || replayListError}</Notice>}
      </section>
      {replay ? (
        <>
          <div className="ax-monitor-grid">
            <section
              className={`surface ax-equipment ${alertActive ? 'has-signal' : ''}`}
              aria-label="펌프 점검 신호 표시"
            >
              <div className="section-heading">
                <h2>펌프 상태</h2>
                <Badge tone={alertActive ? 'red' : 'slate'}>
                  {!latest
                    ? '수신 대기'
                    : alertActive
                      ? pendingAlert
                        ? '점검 신호 · 미확인'
                        : '점검 신호 · 확인함'
                      : '현재 이상 신호 없음'}
                </Badge>
              </div>
              <PumpScene />
              {alertActive && <div className="ax-equipment-glow" aria-hidden="true" />}
              <div className="ax-equipment-caption">
                <strong>{channel}</strong>
                <span>
                  {latest?.value?.toFixed(3) ?? '—'} <small>단위 미확인</small>
                </span>
              </div>
              {pendingAlert && (
                <button className="button secondary" onClick={() => setPendingAlert(false)}>
                  신호 확인함
                </button>
              )}
              <p>
                부품 위치가 확인되기 전까지 펌프 전체에 신호를 표시합니다. 설비 이미지는 이후 교체할
                수 있습니다.
              </p>
            </section>
            <section className="surface ax-monitor-chart-panel">
              <div className="section-heading">
                <h2>도착한 채널값</h2>
                <small>
                  {cursor.toLocaleString()} / {replay.total_rows.toLocaleString()}행
                </small>
              </div>
              <div className="ax-playback">
                <button
                  className="icon-button"
                  aria-label={playing ? '재생 일시 정지' : '실시간 재생 시작'}
                  disabled={cursor >= replay.total_rows}
                  onClick={() => {
                    setError('');
                    setPlaying(!playing);
                  }}
                >
                  {playing ? <Pause size={21} /> : <Play size={21} />}
                </button>
                <button className="icon-button" aria-label="처음부터 재생" onClick={resetPlayback}>
                  <RotateCcw size={18} />
                </button>
                <select
                  className="input"
                  aria-label="표시할 실시간 채널"
                  value={channel}
                  onChange={(event) => {
                    generation.current += 1;
                    resetPlayback();
                    setChannel(event.target.value);
                  }}
                >
                  {replay.feature_columns.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label="재생 배속"
                  value={speed}
                  onChange={(event) => setSpeed(Number(event.target.value))}
                >
                  {[1, 10, 60, 300, 1000].map((value) => (
                    <option key={value} value={value}>
                      {value}배속
                    </option>
                  ))}
                </select>
                {loadingBatch && <LoaderCircle className="spin" size={16} />}
              </div>
              <LiveChart points={points} channel={channel} />
              <p className="ax-provenance">
                {isExpert
                  ? `${replay.feature_columns.length}개 입력 채널을 함께 사용한 모델 예측입니다. 채널별 원인 기여도는 계산하지 않았습니다.`
                  : `AI는 ${replay.feature_columns.length}개 채널을 함께 확인해요. 지금 표시한 채널이 원인으로 확인된 것은 아닙니다.`}
              </p>
              <div className="ax-live-legend">
                <i />
                채널값 <i />
                모델이 찾은 점검 신호{' '}
                <span>최근 600행 표시 · 아직 도착하지 않은 값은 표시하지 않음</span>
              </div>
            </section>
          </div>
          <div className="ax-review-grid">
            <section className="surface ax-signal-list">
              <div className="section-heading">
                <h2>점검 신호</h2>
                <AlertTriangle size={19} />
              </div>
              {!signals.length ? (
                <p className="muted">도착한 데이터에서 발견한 신호가 여기 쌓입니다.</p>
              ) : (
                signals.map((signal) => (
                  <button
                    key={signal.key}
                    className={selectedSignal?.key === signal.key ? 'selected' : ''}
                    onClick={() => setSelectedSignal(signal)}
                  >
                    <span>{signal.timestamp.replace('T', ' ').slice(0, 19)}</span>
                    <strong>
                      {signal.channel} · {signal.value?.toFixed(3) ?? '—'}
                    </strong>
                    <small>
                      {isExpert
                        ? `${sourceType === 'probability' ? '이상 클래스 확률' : '재구성 오차'} ${sourceType === 'probability' ? (signal.score * 100).toFixed(1) + '%' : signal.score.toPrecision(4)}`
                        : '직접 점검할 후보'}
                    </small>
                  </button>
                ))
              )}
            </section>
            <AxAssistantPanel
              runId={runId || null}
              modelKey={chosenRun?.selected_model || null}
              split="test"
              contextKey={`${replay.id}:${channel}`}
              selectedSignal={
                selectedSignal
                  ? `${selectedSignal.timestamp} / 표시 채널 ${selectedSignal.channel} / 값 ${selectedSignal.value} / 합성 재생 데이터의 다채널 모델 점검 후보. 표시 채널의 원인 기여도와 센서·부품 대응 관계는 미확인.`
                  : ''
              }
            />
          </div>
        </>
      ) : (
        <EmptyState
          title="학습한 모델로 수신을 시작해보세요"
          description="모델 학습·최종 평가를 마친 뒤 23만 행 데이터를 생성하거나 기존 재생 데이터를 선택하세요."
        />
      )}
    </div>
  );
}
