import { axRequest, type ReplayBatch } from './ax-api';

export interface SimulationManifest {
  id: string;
  run_id: string;
  model_key: 'xgboost' | 'autoencoder';
  filename: string;
  total_rows: number;
  feature_columns: string[];
  start_time: string;
  end_time: string;
  synthetic: true;
  created_at: number;
}

export type SimulationBatch = Omit<ReplayBatch, 'replay_id'> & { simulation_id: string };

export function uploadSimulation(file: File, runId: string, modelKey: string, signal: AbortSignal) {
  const form = new FormData();

  form.append('file', file);
  form.append('run_id', runId);
  form.append('model_key', modelKey);
  return axRequest<SimulationManifest>('/simulations', { method: 'POST', body: form, signal });
}

// 이 값은 사용자가 넣은 정비 기준의 차이다. 센서로 추정한 잔여수명이 아니다.
export function remainingServiceHours(expected: string, used: string): number | null {
  if (!expected.trim() || !used.trim()) return null;
  const expectedHours = Number(expected);

  const usedHours = Number(used);

  if (
    !Number.isFinite(expectedHours) ||
    !Number.isFinite(usedHours) ||
    expectedHours <= 0 ||
    usedHours < 0
  )
    return null;
  return Math.max(0, expectedHours - usedHours);
}
