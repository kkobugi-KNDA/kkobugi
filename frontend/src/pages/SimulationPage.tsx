import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartLine, FileUp, LoaderCircle, Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useExpertise } from '../context/ExpertiseContext';
import { errorMessage } from '../lib/api';
import { axRequest, type AssistantCostInput, type ReplayPoint } from '../lib/ax-api';
import {
  remainingServiceHours,
  uploadSimulation,
  type SimulationBatch,
  type SimulationManifest,
} from '../lib/simulation-api';
import { SIMULATION_PARTS } from '../lib/simulation-parts';
import {
  openPetAssistant,
  publishSimulationStatus,
  type SimulationAssistantStatus,
} from '../lib/assistant-events';
import LiveChart from '../components/LiveChart';
import { Notice } from '../components/ui';
import '../components/ax.css';
import './simulation.css';
import { DEMO_RUN_DETAIL } from '../data/demo';
import { guestSimulationBatch, guestSimulationManifest } from '../lib/guest-simulation';

const PumpSimulationScene = lazy(() => import('../components/PumpSimulationScene'));

interface PartInputs {
  expectedHours: string;
  usedHours: string;
  quote: string;
  quoteSource: string;
}

const emptyPartInputs: PartInputs = {
  expectedHours: '',
  usedHours: '',
  quote: '',
  quoteSource: '',
};

export default function SimulationPage() {
  const { runs, datasets, user, mode, selectedRunId, setSelectedRunId, refreshRuns } = useApp();

  const isGuest = Boolean(user?.is_guest);

  const { isExpert } = useExpertise();

  const eligibleRuns = useMemo(
    () =>
      isGuest
        ? [DEMO_RUN_DETAIL.run]
        : runs.filter(
            (run) =>
              run.owner_id === user?.id &&
              run.status === 'completed' &&
              run.evaluation_status === 'completed' &&
              ['xgboost', 'autoencoder'].includes(run.selected_model || ''),
          ),
    [runs, user?.id, isGuest],
  );

  const [runId, setRunId] = useState('');

  const [file, setFile] = useState<File | null>(null);

  const [simulations, setSimulations] = useState<SimulationManifest[]>([]);

  const [simulation, setSimulation] = useState<SimulationManifest | null>(null);

  const [channel, setChannel] = useState('');

  const [points, setPoints] = useState<ReplayPoint[]>([]);

  const [cursor, setCursor] = useState(0);

  const [playing, setPlaying] = useState(false);

  const [speed, setSpeed] = useState(isGuest ? 10 : 60);

  const [showGraph, setShowGraph] = useState(false);

  const [showParts, setShowParts] = useState(false);

  const [viewMode, setViewMode] = useState<'pump' | 'parts'>('pump');

  const [pendingSignal, setPendingSignal] = useState(false);

  const [signalCount, setSignalCount] = useState(0);

  const [lastSignal, setLastSignal] = useState<(ReplayPoint & { channel: string }) | null>(null);

  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);

  const [partInputs, setPartInputs] = useState<Record<string, PartInputs>>({});

  const [uploading, setUploading] = useState(false);

  const [error, setError] = useState('');

  const [listError, setListError] = useState('');

  const [partConnection, setPartConnection] = useState('');

  const workspaceRef = useRef<HTMLDivElement>(null);

  const partPanelRef = useRef<HTMLElement>(null);

  const uploadController = useRef<AbortController | null>(null);

  const batchController = useRef<AbortController | null>(null);

  const generation = useRef(0);

  const chosenRun = eligibleRuns.find((run) => run.id === runId);

  const selectedPart = SIMULATION_PARTS.find((part) => part.id === selectedPartId);

  const currentPartInputs = selectedPartId
    ? partInputs[selectedPartId] || emptyPartInputs
    : emptyPartInputs;

  const remainingHours = remainingServiceHours(
    currentPartInputs.expectedHours,
    currentPartInputs.usedHours,
  );

  const latestPoint = points.at(-1);

  const hasSignal = pendingSignal || latestPoint?.predicted_code === 1;

  // 형상 카드에서 현재 검토하는 부품의 입력·안내 창까지 실제 화면 위치로 선을 잇는다.
  useEffect(() => {
    const workspace = workspaceRef.current;

    const panel = partPanelRef.current;

    const part = workspace?.querySelector<HTMLElement>(`[data-part-id="${selectedPartId}"]`);

    if (!workspace || !panel || !part || !showParts) {
      setPartConnection('');
      return;
    }
    const updateConnection = () => {
      const area = workspace.getBoundingClientRect();

      const source = part.getBoundingClientRect();

      const target = panel.getBoundingClientRect();

      const startX = source.left + source.width / 2 - area.left;

      const startY = source.top - area.top;

      const endX = target.left + target.width / 2 - area.left;

      const endY = target.bottom - area.top;

      const middleY = (startY + endY) / 2;

      setPartConnection(
        `${startX},${startY} ${startX},${middleY} ${endX},${middleY} ${endX},${endY}`,
      );
    };

    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateConnection);

    observer?.observe(workspace);
    observer?.observe(panel);
    updateConnection();
    window.addEventListener('resize', updateConnection);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateConnection);
    };
  }, [showParts, selectedPartId, showGraph, viewMode]);

  const simulationStatus = useMemo<SimulationAssistantStatus>(() => {
    const activeSimulation = chosenRun && simulation?.run_id === chosenRun.id ? simulation : null;

    const receivedRows = activeSimulation ? cursor : 0;

    return {
      ownerId: user?.id ?? -1,
      preview: isGuest,
      runId: isGuest ? null : chosenRun?.id || null,
      modelKey: isGuest ? null : chosenRun?.selected_model || null,
      split: 'test',
      contextKey: `simulation:${activeSimulation?.id || 'waiting'}`,
      error: chosenRun ? error : undefined,
      simulationContext: {
        filename: activeSimulation?.filename,
        status: !activeSimulation
          ? 'waiting'
          : receivedRows >= activeSimulation.total_rows
            ? 'completed'
            : playing
              ? 'playing'
              : receivedRows
                ? 'paused'
                : 'waiting',
        cursor: receivedRows,
        total_rows: activeSimulation?.total_rows || 0,
        timestamp: activeSimulation ? latestPoint?.timestamp : undefined,
        signal_count: activeSimulation ? signalCount : 0,
        last_signal_time: activeSimulation ? lastSignal?.timestamp : undefined,
      },
    };
  }, [
    chosenRun,
    simulation,
    cursor,
    playing,
    user?.id,
    error,
    latestPoint,
    signalCount,
    lastSignal,
    isGuest,
  ]);

  useEffect(() => {
    publishSimulationStatus((mode === 'live' || isGuest) && user ? simulationStatus : null);
  }, [simulationStatus, mode, user, isGuest]);

  useEffect(() => () => publishSimulationStatus(null), []);

  // 사용자가 선택한 학습이 준비되지 않았다면 임의의 다른 모델로 바꾸지 않는다.
  useEffect(() => {
    if (eligibleRuns.some((run) => run.id === runId)) return;
    setRunId(
      selectedRunId
        ? eligibleRuns.find((run) => run.id === selectedRunId)?.id || ''
        : eligibleRuns[0]?.id || '',
    );
  }, [eligibleRuns, runId, selectedRunId]);

  useEffect(() => {
    const controller = new AbortController();

    setSimulations(isGuest ? [guestSimulationManifest(DEMO_RUN_DETAIL.run.id)] : []);
    setListError('');
    if (mode === 'live' && !isGuest)
      axRequest<{ items: SimulationManifest[] }>('/simulations', { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted)
            setSimulations((previous) => [
              ...previous,
              ...result.items.filter((item) => !previous.some((saved) => saved.id === item.id)),
            ]);
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setListError(errorMessage(failure));
        });
    return () => controller.abort();
  }, [mode, user?.id, isGuest]);

  function resetPlayback() {
    batchController.current?.abort();
    setPlaying(false);
    setPoints([]);
    setCursor(0);
    setPendingSignal(false);
    setSignalCount(0);
    setLastSignal(null);
  }

  useEffect(() => {
    generation.current += 1;
    uploadController.current?.abort();
    resetPlayback();
    const example = isGuest && runId ? guestSimulationManifest(runId) : null;

    setSimulation(example);
    setChannel(example?.feature_columns[0] || '');
    setUploading(false);
    setError('');
    return () => {
      uploadController.current?.abort();
      batchController.current?.abort();
    };
  }, [runId, user?.id, mode, isGuest]);

  useEffect(() => {
    setFile(null);
    setPartInputs({});
    setSelectedPartId(null);
  }, [user?.id, mode]);

  function chooseSimulation(id: string) {
    const manifest = simulations.find((item) => item.id === id && item.run_id === runId);

    if (!manifest) return;
    generation.current += 1;
    uploadController.current?.abort();
    setUploading(false);
    resetPlayback();
    setSimulation(manifest);
    setChannel(manifest.feature_columns[0] || '');
    setError('');
  }

  async function connectFile() {
    if (!file || !chosenRun?.selected_model || uploading || mode !== 'live' || isGuest) return;
    const controller = new AbortController();

    const requestGeneration = ++generation.current;

    uploadController.current?.abort();
    uploadController.current = controller;
    resetPlayback();
    setSimulation(null);
    setUploading(true);
    setError('');
    try {
      const manifest = await uploadSimulation(
        file,
        runId,
        chosenRun.selected_model,
        controller.signal,
      );

      if (controller.signal.aborted || requestGeneration !== generation.current) return;
      setSimulation(manifest);
      setChannel(manifest.feature_columns[0] || '');
      setSimulations((previous) => [
        manifest,
        ...previous.filter((item) => item.id !== manifest.id),
      ]);
      setSelectedRunId(runId);
    } catch (failure) {
      if (!controller.signal.aborted && requestGeneration === generation.current)
        setError(errorMessage(failure));
    } finally {
      if (requestGeneration === generation.current) setUploading(false);
    }
  }

  // 현재 배치만 추론한다. 화면 이동·정지·모델 전환은 진행 중 요청도 취소한다.
  useEffect(() => {
    if (!playing || !simulation || !channel || (mode !== 'live' && !isGuest)) return;
    const controller = new AbortController();

    batchController.current = controller;
    const timer = setTimeout(
      async () => {
        try {
          const batch = isGuest
            ? guestSimulationBatch(simulation.id, cursor, speed, channel)
            : await axRequest<SimulationBatch>(
                `/simulations/${simulation.id}/batch?cursor=${cursor}&limit=${speed}&channel=${encodeURIComponent(channel)}`,
                { signal: controller.signal },
              );

          if (controller.signal.aborted) return;
          setPoints((previous) => [...previous, ...batch.points].slice(-600));
          const newSignals = batch.points.filter((point) => point.predicted_code === 1);

          if (newSignals.length) {
            setPendingSignal(true);
            setSignalCount((previous) => previous + newSignals.length);
            setLastSignal({ ...newSignals[newSignals.length - 1], channel });
          }
          setCursor(batch.next_cursor);
          if (batch.done) setPlaying(false);
        } catch (failure) {
          if (!controller.signal.aborted) {
            setError(errorMessage(failure));
            setPlaying(false);
          }
        }
      },
      cursor === 0 ? 0 : 1000,
    );

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [playing, simulation?.id, channel, cursor, speed, mode, isGuest]);

  const suggestedCosts = useMemo<AssistantCostInput>(() => {
    const costs: AssistantCostInput = { component_name: selectedPart?.label };

    const quote = Number(currentPartInputs.quote);

    if (currentPartInputs.quote.trim() && Number.isFinite(quote) && quote >= 0)
      costs.parts_cost = quote;
    if (currentPartInputs.quoteSource.trim())
      costs.quote_source = currentPartInputs.quoteSource.trim();
    return costs;
  }, [selectedPart?.label, currentPartInputs.quote, currentPartInputs.quoteSource]);

  function updatePart(field: keyof PartInputs, value: string) {
    if (!selectedPartId) return;
    setPartInputs((previous) => ({
      ...previous,
      [selectedPartId]: { ...(previous[selectedPartId] || emptyPartInputs), [field]: value },
    }));
  }

  function openAssistant() {
    const point = lastSignal || latestPoint;

    const signal = point
      ? `${point.timestamp}, ${lastSignal?.channel || channel}=${point.value}, ${isGuest ? '예시 신호' : '모델 판정'}=${point.predicted_code}, 점수=${point.score}`
      : '아직 수신한 값 없음';

    const serviceLife =
      remainingHours === null
        ? '정비 기준·누적 운전시간 미입력. 잔여수명 추정 불가.'
        : `사용자 입력 기준수명 ${currentPartInputs.expectedHours}시간 - 누적 운전시간 ${currentPartInputs.usedHours}시간 = 입력 기준 잔여 ${remainingHours}시간. 센서 기반 수명 예측이 아님.`;

    const selectedSignal = `${isGuest ? '브라우저에서 생성한 예시 데이터. 실제 학습 모델 추론 아님.' : '업로드한 생성 CSV'} ${simulation?.filename || '미선택'}의 시뮬레이션. ${signal}. ${selectedPart?.label || '전체 펌프'}는 사용자가 확인 대상으로 선택했으며 모델이 고장 부위로 특정하지 않음. ${serviceLife}`;

    openPetAssistant({
      datasetId: isGuest ? null : undefined,
      runId: isGuest ? null : chosenRun?.id || null,
      modelKey: isGuest ? null : chosenRun?.selected_model || null,
      split: 'test',
      selectedSignal,
      suggestedCostInputs: suggestedCosts,
      contextKey: `${simulation?.id || ''}:${selectedPartId || ''}`,
      simulationContext: simulationStatus.simulationContext,
    });
  }

  return (
    <div className="simulation-page">
      <div className="simulation-heading">
        <div>
          <span>SIMULATION / PUMP</span>
          <h1>시뮬레이션</h1>
        </div>
        <p>
          {isGuest
            ? '예시 데이터 · 실제 학습 모델 추론 아님'
            : 'CSV 수신 · 저장 모델 추론 · 3D 확인'}
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {listError && <Notice tone="error">{listError}</Notice>}
      <div
        ref={workspaceRef}
        className={`simulation-workspace ${hasSignal ? 'has-signal' : ''} ${showParts ? 'has-part-panel' : ''}`}
      >
        <Suspense
          fallback={
            <div className="simulation-scene-loading">
              <LoaderCircle /> 3D 화면 준비 중
            </div>
          }
        >
          <PumpSimulationScene
            viewMode={viewMode}
            hasSignal={hasSignal}
            selectedPartId={selectedPartId}
            onSelectPart={(id) => {
              setSelectedPartId(id);
              setShowParts(true);
            }}
            onPartHover={(id) => {
              if (id) {
                setSelectedPartId(id);
                setShowParts(true);
              }
            }}
          />
        </Suspense>
        <aside className="simulation-controls" aria-label="시뮬레이션 옵션">
          <h2>
            <Settings2 size={17} /> 재생 설정
          </h2>
          <div className="simulation-view-tabs" role="group" aria-label="3D 표시 대상">
            <button aria-pressed={viewMode === 'pump'} onClick={() => setViewMode('pump')}>
              설비
            </button>
            <button aria-pressed={viewMode === 'parts'} onClick={() => setViewMode('parts')}>
              부품 전체
            </button>
          </div>
          <label>
            사용할 모델
            <select
              aria-label="시뮬레이션 모델"
              value={runId}
              disabled={uploading}
              onChange={(event) => setRunId(event.target.value)}
            >
              <option value="">학습된 모델 선택</option>
              {eligibleRuns.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.selected_model === 'xgboost' ? 'XGBoost' : 'AutoEncoder'} ·{' '}
                  {datasets.find((dataset) => dataset.id === run.dataset_id)?.filename ||
                    run.id.slice(0, 8)}
                  {isGuest ? ' · 예시' : ''}
                </option>
              ))}
            </select>
          </label>
          <button
            className="simulation-text-button"
            disabled={isGuest}
            onClick={() => {
              void refreshRuns().catch((failure) => setError(errorMessage(failure)));
            }}
          >
            학습 목록 새로고침
          </button>
          {!eligibleRuns.length && (
            <p>
              모델 학습과 최종 확인을 마쳐주세요. <Link to="/models">모델 학습 선택 ↗</Link>
            </p>
          )}
          <label className="simulation-file">
            <FileUp size={21} />
            <strong>시뮬레이션 CSV 선택</strong>
            <span>
              {isGuest
                ? '예시 CSV가 연결되어 있어요'
                : file?.name || '한 달 데이터 · timestamp + 학습 채널'}
            </span>
            <input
              aria-label="시뮬레이션 CSV 업로드"
              type="file"
              accept=".csv,text/csv"
              disabled={uploading || mode !== 'live' || isGuest}
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setError('');
              }}
            />
          </label>
          <button
            className="simulation-connect"
            disabled={!file || !chosenRun || uploading || mode !== 'live' || isGuest}
            onClick={() => void connectFile()}
          >
            {uploading ? (
              <>
                <LoaderCircle size={16} className="spin" /> CSV 검사 중
              </>
            ) : (
              'CSV 연결'
            )}
          </button>
          <label>
            저장한 CSV
            <select
              aria-label="저장한 시뮬레이션 CSV"
              value={simulation?.id || ''}
              disabled={uploading}
              onChange={(event) => chooseSimulation(event.target.value)}
            >
              <option value="">연결한 파일 선택</option>
              {simulations
                .filter((item) => item.run_id === runId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.filename} · {item.total_rows.toLocaleString()}행
                  </option>
                ))}
            </select>
          </label>
          {simulation && (
            <p className="simulation-range">
              {simulation.start_time.replace('T', ' ')}
              <br />~ {simulation.end_time.replace('T', ' ')}
              <br />
              {simulation.total_rows.toLocaleString()}행 · {simulation.feature_columns.length}채널
            </p>
          )}
          <button
            className="simulation-start"
            disabled={
              !simulation ||
              !channel ||
              (mode !== 'live' && !isGuest) ||
              cursor >= (simulation?.total_rows || 0)
            }
            onClick={() => setPlaying((previous) => !previous)}
          >
            {playing ? (
              <>
                <Pause size={17} /> 시뮬레이션 일시 정지
              </>
            ) : (
              <>
                <Play size={17} /> 실시간 시뮬레이션 시작
              </>
            )}
          </button>
          <div className="simulation-play-options">
            <button
              aria-label="시뮬레이션 처음부터"
              title="처음부터"
              disabled={!simulation}
              onClick={resetPlayback}
            >
              <RotateCcw size={17} />
            </button>
            <select
              aria-label="시뮬레이션 재생 속도"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              {[1, 10, 60, 300, 1000].map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString()}행/초
                </option>
              ))}
            </select>
          </div>
          <label className="simulation-toggle">
            <ChartLine size={17} />
            <span>그래프 표시</span>
            <input
              aria-label="그래프 표시"
              type="checkbox"
              checked={showGraph}
              onChange={(event) => setShowGraph(event.target.checked)}
            />
          </label>
          {showGraph && (
            <label>
              표시할 채널
              <select
                aria-label="시뮬레이션 그래프 채널"
                value={channel}
                onChange={(event) => {
                  batchController.current?.abort();
                  setPoints([]);
                  setChannel(event.target.value);
                }}
              >
                {simulation?.feature_columns.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="simulation-text-button"
            onClick={() => setShowParts((previous) => !previous)}
          >
            {showParts ? '부품 설정 닫기' : '부품 수명·견적 입력'}
          </button>
          <p className="simulation-footnote">
            생성 CSV 재생입니다. 학습과 원본 데이터는 변경하지 않습니다.
          </p>
        </aside>
        <div className="simulation-live-status" role="status">
          <span className={playing ? 'is-playing' : ''} />
          {playing
            ? '수신 중'
            : cursor >= (simulation?.total_rows || Infinity)
              ? '재생 완료'
              : '대기 · 일시 정지'}
          <strong>
            {cursor.toLocaleString()} / {(simulation?.total_rows || 0).toLocaleString()}행
          </strong>
          <time>{latestPoint?.timestamp.replace('T', ' ') || '아직 도착한 값 없음'}</time>
        </div>
        {hasSignal && (
          <div className="simulation-alert" role="alert">
            <strong>점검 신호 {signalCount.toLocaleString()}행</strong>
            <span>{lastSignal?.timestamp.replace('T', ' ')}</span>
            <button onClick={() => setPendingSignal(false)}>신호 확인함</button>
            <button onClick={openAssistant}>점검 안내·보고서</button>
          </div>
        )}
        {partConnection && (
          <svg className="simulation-part-connection" aria-hidden="true">
            <polyline points={partConnection} fill="none" stroke="#9ac8e0" strokeWidth="1" />
          </svg>
        )}
        {showParts && (
          <aside ref={partPanelRef} className="simulation-part-panel" aria-label="부품 수명과 견적">
            <h2>부품 확인</h2>
            <div className="simulation-part-tabs">
              {SIMULATION_PARTS.map((part) => (
                <button
                  key={part.id}
                  aria-pressed={selectedPartId === part.id}
                  onClick={() => setSelectedPartId(part.id)}
                >
                  {part.label}
                </button>
              ))}
            </div>
            {selectedPart ? (
              <>
                <p>
                  {selectedPart.modelUrl
                    ? '부품 GLB 연결됨 · 현장 규격 확인 필요'
                    : '부품 GLB·규격 연결 대기'}
                </p>
                <label>
                  현장 기준수명 (시간)
                  <input
                    aria-label="부품 기준수명"
                    type="number"
                    min="1"
                    value={currentPartInputs.expectedHours}
                    onChange={(event) => updatePart('expectedHours', event.target.value)}
                  />
                </label>
                <label>
                  누적 운전시간
                  <input
                    aria-label="부품 누적 운전시간"
                    type="number"
                    min="0"
                    value={currentPartInputs.usedHours}
                    onChange={(event) => updatePart('usedHours', event.target.value)}
                  />
                </label>
                <output aria-label="입력 기준 잔여시간">
                  {remainingHours === null
                    ? '잔여시간 미정'
                    : `입력 기준 잔여 ${remainingHours.toLocaleString()}시간`}
                </output>
                <label>
                  부품 견적 (원)
                  <input
                    aria-label="시뮬레이션 부품 견적"
                    type="number"
                    min="0"
                    value={currentPartInputs.quote}
                    onChange={(event) => updatePart('quote', event.target.value)}
                  />
                </label>
                <label>
                  견적 출처
                  <input
                    aria-label="시뮬레이션 견적 출처"
                    value={currentPartInputs.quoteSource}
                    onChange={(event) => updatePart('quoteSource', event.target.value)}
                    placeholder="업체 견적·사내 기준"
                  />
                </label>
                <p>
                  잔여시간은 입력값의 차이입니다. 센서값으로 수명이나 교체 필요를 확정하지 않습니다.
                </p>
                <button
                  className="simulation-connect"
                  onClick={openAssistant}
                  disabled={!chosenRun}
                >
                  점검 안내·보고서
                </button>
              </>
            ) : (
              <p>부품을 선택해 기준수명과 견적을 입력하세요.</p>
            )}
          </aside>
        )}
        {showGraph && (
          <section className="simulation-graph" aria-label="시뮬레이션 그래프">
            <header>
              <strong>{channel || '채널 미선택'}</strong>
              <span>
                {isGuest
                  ? '합성 예시 신호 · 실제 모델 추론 아님'
                  : isExpert
                    ? '49개 채널의 모델 판정 · 원인 채널 아님'
                    : '여러 채널을 함께 확인한 점검 신호'}
              </span>
            </header>
            <LiveChart points={points} channel={channel || '채널'} />
          </section>
        )}
      </div>
    </div>
  );
}
