import { API_BASE, ApiError, serverErrorMessage } from './api';
import type { ModelKey } from '../types';
import type { SelectedRange } from '../components/TimeSeriesChart';

export type PredictionSplit = 'validation' | 'test';

export interface PredictionContext {
  run_id: string;
  dataset_id: string;
  model_key: ModelKey;
  split: PredictionSplit;
  score_type: 'probability' | 'reconstruction_error';
  threshold: number | null;
  input_sha256: string;
  artifact_sha256: string;
}

export interface PredictionPoint {
  row_index: number;
  timestamp: string;
  actual_label: string;
  actual_code: 0 | 1;
  predicted_label: string;
  predicted_code: 0 | 1;
  score: number;
}

export interface PredictionResponse extends PredictionContext {
  total: number;
  limit: number;
  offset: number;
  items: PredictionPoint[];
}

export interface PredictionIntervalsResponse extends PredictionContext {
  predicted_code: 0 | 1;
  cadence_seconds: number | null;
  items: {
    start_time: string;
    end_time: string;
    start_row: number;
    end_row: number;
    row_count: number;
  }[];
  total: number;
  limit: number;
  offset: number;
}

export interface PredictionQuery {
  model_key: ModelKey;
  split: PredictionSplit;
  limit?: number;
  offset?: number;
  start_time?: string;
  end_time?: string;
}

export interface PredictionOverlay {
  intervals: SelectedRange[];
  label: string;
  status: string;
  truncated: boolean;
  modelResult: {
    run_id: string;
    model_key: ModelKey;
    split: PredictionSplit;
  } | null;
}

export const emptyPredictionOverlay: PredictionOverlay = {
  intervals: [],
  label: '',
  status: '',
  truncated: false,
  modelResult: null,
};

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;

  try {
    // 학습할 때의 계정과 같은 세션으로 조회한다. 새 학습·평가 요청은 보내지 않는다.
    response = await fetch(`${API_BASE}${path}`, { credentials: 'include', signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('예측 서버에 연결하지 못했어요. 다시 시도해주세요.', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(
      body.error?.message || serverErrorMessage(response.status, '예측 결과를 불러오지 못했어요.'),
      response.status,
      body.error?.code,
      body.error?.fields,
    );
  }
  return response.json() as Promise<T>;
}

function queryString(query: PredictionQuery): string {
  const parameters = new URLSearchParams();

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  return parameters.toString();
}

export const predictionApi = {
  intervals: (runId: string, query: PredictionQuery, signal?: AbortSignal) =>
    get<PredictionIntervalsResponse>(
      `/runs/${encodeURIComponent(runId)}/prediction-intervals?${queryString(query)}`,
      signal,
    ),
  points: (runId: string, query: PredictionQuery, signal?: AbortSignal) =>
    get<PredictionResponse>(
      `/runs/${encodeURIComponent(runId)}/predictions?${queryString(query)}`,
      signal,
    ),
};
