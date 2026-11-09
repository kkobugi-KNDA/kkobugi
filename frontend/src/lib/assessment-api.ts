import { API_BASE, ApiError } from './api';
import type { SavedJudgment, SavedObservation } from './review-api';
import type { EvaluationMetrics, ModelKey, Paginated, SplitPart, User } from '../types';

export interface ModelResultReference {
  run_id: string;
  model_key: ModelKey;
  split: 'validation' | 'test';
}

export interface ObservationReference {
  observation_id: string;
  revision: number;
}

export interface CapturedModelResult extends ModelResultReference {
  display_name: string;
  input_sha256: string;
  artifact_sha256: string;
  feature_columns: string[];
  train_end: string;
  validation_end: string;
  partition: SplitPart;
  partition_metrics: EvaluationMetrics;
  metrics_scope: 'full_partition';
  parameters: Record<string, unknown>;
  environment: Record<string, string>;
}

export interface ReviewEvidence {
  model_result: CapturedModelResult | null;
  observations: SavedObservation[];
}

export interface ReviewRecord {
  id: string;
  dataset_id: string;
  channel: string;
  start_time: string;
  end_time: string;
  conclusion: string;
  judgment: SavedJudgment;
  status: 'in_progress' | 'completed';
  revision: number;
  created_at: number;
  updated_at: number;
  author: User;
  last_editor: User;
  completed_at: number | null;
  completed_by: User | null;
  evidence: ReviewEvidence;
}

export interface ReviewCreate {
  dataset_id: string;
  channel: string;
  start_time: string;
  end_time: string;
  conclusion: string;
  judgment: SavedJudgment;
  model_result: ModelResultReference | null;
  observations: ObservationReference[];
}

export interface ReviewPatch {
  revision: number;
  conclusion?: string;
  judgment?: SavedJudgment;
  model_result?: ModelResultReference | null;
  observations?: ObservationReference[];
}

export interface ReviewHistoryItem {
  revision: number;
  action: 'created' | 'updated' | 'completed' | 'reopened';
  reason: string;
  changed_at: number;
  changed_by: User;
  snapshot: ReviewRecord;
}

export interface ReviewHistory extends Paginated<ReviewHistoryItem> {
  review_id: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);

  if (options.body) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('X-Requested-With', 'kkobugi-web');

  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('검토 서버에 연결하지 못했어요. 다시 시도해주세요.', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(
      body.error?.message || '검토 요청을 처리하지 못했어요.',
      response.status,
      body.error?.code,
      body.error?.fields,
    );
  }
  return response.json() as Promise<T>;
}

const reviewPath = (id: string) => `/reviews/${encodeURIComponent(id)}`;

export const assessmentApi = {
  list: (datasetId: string, channel: string, offset = 0, signal?: AbortSignal) =>
    request<Paginated<ReviewRecord>>(
      `/reviews?${new URLSearchParams({ dataset_id: datasetId, channel, limit: '20', offset: String(offset) })}`,
      { signal },
    ),
  get: (id: string, signal?: AbortSignal) => request<ReviewRecord>(reviewPath(id), { signal }),
  create: (input: ReviewCreate) =>
    request<ReviewRecord>('/reviews', { method: 'POST', body: JSON.stringify(input) }),
  patch: (id: string, input: ReviewPatch) =>
    request<ReviewRecord>(reviewPath(id), { method: 'PATCH', body: JSON.stringify(input) }),
  complete: (id: string, revision: number) =>
    request<ReviewRecord>(`${reviewPath(id)}/complete`, {
      method: 'POST',
      body: JSON.stringify({ revision }),
    }),
  reopen: (id: string, revision: number, reason: string) =>
    request<ReviewRecord>(`${reviewPath(id)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ revision, reason }),
    }),
  history: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ReviewHistory>(`${reviewPath(id)}/history?limit=20&offset=${offset}`, { signal }),
};
