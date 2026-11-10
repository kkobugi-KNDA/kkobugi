import type { ReplayPoint } from './ax-api';
import type { SimulationBatch, SimulationManifest } from './simulation-api';

const TOTAL_POINTS = 360;

/** 화면은 기존 시뮬레이션을 재사용하고, 관람객의 데이터 공급원만 브라우저로 바꾼다. */
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

export function guestSimulationManifest(runId: string): SimulationManifest {
  return {
    id: 'guest-example',
    run_id: runId,
    model_key: 'xgboost',
    filename: 'pump-example.csv (예시 데이터)',
    total_rows: TOTAL_POINTS,
    feature_columns: ['example_sensor'],
    start_time: guestPoint(0).timestamp,
    end_time: guestPoint(TOTAL_POINTS - 1).timestamp,
    synthetic: true,
    created_at: 1794268800,
  };
}

export function guestSimulationBatch(
  simulationId: string,
  cursor: number,
  limit: number,
  channel: string,
): SimulationBatch {
  const end = Math.min(TOTAL_POINTS, cursor + limit);

  return {
    simulation_id: simulationId,
    channel,
    points: Array.from({ length: Math.max(0, end - cursor) }, (_, index) =>
      guestPoint(cursor + index),
    ),
    next_cursor: end,
    total_rows: TOTAL_POINTS,
    done: end >= TOTAL_POINTS,
    score_type: 'probability',
    threshold: null,
    synthetic: true,
  };
}
