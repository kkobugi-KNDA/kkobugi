import { API_BASE, ApiError } from './api';
import type { RunCreate } from '../types';

export type TrainingModel = 'xgboost' | 'autoencoder';

export interface TrainingConfiguration extends RunCreate {
  model_options?: Record<string, Record<string, number>>;
}

export interface TrainingPlan {
  configuration: TrainingConfiguration;
  split: { train_rows: number; validation_rows: number; test_rows: number };
  notes: string[];
  warnings?: string[];
  label_counts?: Record<'train' | 'validation' | 'test', { normal: number; abnormal: number }>;
}

export interface TrainingPlanRequest {
  dataset_id: string;
  model_key: TrainingModel;
  train_ratio: number;
  validation_ratio: number;
  feature_columns?: string[];
}

export async function prepareTraining(
  request: TrainingPlanRequest,
  signal?: AbortSignal,
): Promise<TrainingPlan> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/training/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kkobugi-web' },
      credentials: 'include',
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('학습 설정 서버에 연결하지 못했어요.', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(body.error?.message || '자동 설정을 만들지 못했어요.', response.status);
  }
  return response.json() as Promise<TrainingPlan>;
}
