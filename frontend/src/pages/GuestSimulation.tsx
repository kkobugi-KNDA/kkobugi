import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ChartLine, Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import LiveChart from '../components/LiveChart';
import type { ReplayPoint } from '../lib/ax-api';
import { SIMULATION_PARTS } from '../lib/simulation-parts';

const PumpSimulationScene = lazy(() => import('../components/PumpSimulationScene'));

const TOTAL_POINTS = 360;

/** 관람객 각자의 브라우저에서만 재생한다. 팀 CSV·모델·저장 API는 호출하지 않는다. */
export function guestPoint(index: number): ReplayPoint {
  const abnormal = (index >= 60 && index < 100) || (index >= 220 && index < 250);

  const value = 40 + Math.sin(index / 7) * 2 + (abnormal ? 11 : 0);

  return {
    row_index: index,
    timestamp: new Date(Date.UTC(2026, 10, 10, 0, 0, index)).toISOString(),
    value,
    predicted_code: abnormal ? 1 : 0,
    score: abnormal ? 0.9 : 0.1,
  };
}

export default function GuestSimulation() {
  const [cursor, setCursor] = useState(0);

  const [playing, setPlaying] = useState(false);

  const [speed, setSpeed] = useState(10);

  const [showGraph, setShowGraph] = useState(true);

  const [viewMode, setViewMode] = useState<'pump' | 'parts'>('pump');

  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);

  const points = useMemo(
    () => Array.from({ length: cursor }, (_, index) => guestPoint(index)).slice(-180),
    [cursor],
  );

  const hasSignal = points.at(-1)?.predicted_code === 1;

  const selectedPart = SIMULATION_PARTS.find((part) => part.id === selectedPartId);

  useEffect(() => {
    if (!playing) return;

    const timer = window.setInterval(() => {
      setCursor((current) => Math.min(TOTAL_POINTS, current + 1));
    }, 1000 / speed);

    return () => window.clearInterval(timer);
  }, [playing, speed]);

  useEffect(() => {
    if (cursor >= TOTAL_POINTS) setPlaying(false);
  }, [cursor]);

  function reset() {
    setPlaying(false);
    setCursor(0);
    setSelectedPartId(null);
  }

  return (
    <div className="simulation-page">
      <div className="simulation-heading">
        <div>
          <span>GUEST / PUMP</span>
          <h1>시뮬레이션 체험</h1>
        </div>
        <p>예시 데이터 · 내 브라우저에서만 재생</p>
      </div>
      <div className={`simulation-workspace ${hasSignal ? 'has-signal' : ''}`}>
        <Suspense fallback={<div className="simulation-scene-loading">3D 화면 준비 중</div>}>
          <PumpSimulationScene
            hasSignal={hasSignal}
            viewMode={viewMode}
            selectedPartId={selectedPartId}
            onSelectPart={setSelectedPartId}
          />
        </Suspense>
        <aside className="simulation-controls" aria-label="관람객 시뮬레이션 옵션">
          <h2>
            <Settings2 size={17} /> 재생 설정
          </h2>
          <p>예시 신호의 변화를 재생해요. 실제 센서 수집이나 학습 모델의 예측 결과는 아니에요.</p>
          <div className="simulation-view-tabs" role="group" aria-label="3D 표시 대상">
            <button aria-pressed={viewMode === 'pump'} onClick={() => setViewMode('pump')}>
              설비
            </button>
            <button aria-pressed={viewMode === 'parts'} onClick={() => setViewMode('parts')}>
              부품 전체
            </button>
          </div>
          <button
            className="simulation-start"
            disabled={cursor >= TOTAL_POINTS}
            onClick={() => setPlaying((current) => !current)}
          >
            {playing ? <Pause size={17} /> : <Play size={17} />}
            {playing ? '시뮬레이션 일시 정지' : '시뮬레이션 시작'}
          </button>
          <div className="simulation-play-options">
            <button aria-label="시뮬레이션 처음부터" title="처음부터" onClick={reset}>
              <RotateCcw size={17} />
            </button>
            <select
              aria-label="시뮬레이션 재생 속도"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              {[1, 10, 30].map((value) => (
                <option key={value} value={value}>
                  {value}행/초
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
          <p role="status">
            {cursor >= TOTAL_POINTS ? '재생 완료' : hasSignal ? '이상 신호 예시' : '정상 신호 예시'}{' '}
            · {cursor} / {TOTAL_POINTS}행
          </p>
          {selectedPart && <p>선택한 부품: {selectedPart.label}</p>}
          <p>빨간 표시는 예시 이상 구간이에요. 부품 고장을 확정한 표시는 아니에요.</p>
        </aside>
        {showGraph && (
          <section className="simulation-graph" aria-label="시뮬레이션 그래프">
            <header>
              <strong>예시 센서</strong>
              <span>합성 예시 값 · 빨간 점은 이상 구간</span>
            </header>
            <LiveChart points={points} channel="예시 센서" />
          </section>
        )}
      </div>
    </div>
  );
}
