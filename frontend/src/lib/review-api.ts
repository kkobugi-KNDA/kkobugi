import { API_BASE, ApiError } from './api';
import type { Observation, Paginated, User } from '../types';

export type SavedJudgment = 'needs_check' | 'anomaly_candidate' | 'normal';
export interface SavedObservation {
  id: string;
  dataset_id: string;
  run_id: string | null;
  model_key: string | null;
  channel: string;
  start_time: string;
  end_time: string;
  location: string;
  content: string;
  judgment: SavedJudgment;
  revision: number;
  created_at: number;
  updated_at: number;
  author: User;
  last_editor: User;
}
export interface ObservationCreate {
  dataset_id: string;
  channel: string;
  start_time: string;
  end_time: string;
  location: string;
  content: string;
  judgment: SavedJudgment;
}
export interface LabelIntervals {
  dataset_id: string;
  code: 0 | 1;
  normal_label: string;
  abnormal_label: string;
  timezone_mode: 'naive' | 'aware';
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
export const savedJudgment = (judgment: Observation['judgment']): SavedJudgment =>
  (({ pending: 'needs_check', candidate: 'anomaly_candidate', normal: 'normal' }) as const)[
    judgment
  ];
export const displayJudgment = (judgment: SavedJudgment): Observation['judgment'] =>
  (({ needs_check: 'pending', anomaly_candidate: 'candidate', normal: 'normal' }) as const)[
    judgment
  ];
export function observationForDisplay(item: SavedObservation): Observation {
  return {
    id: item.id,
    datasetId: item.dataset_id,
    channel: item.channel,
    start: item.start_time,
    end: item.end_time,
    location: item.location,
    text: item.content,
    judgment: displayJudgment(item.judgment),
    createdAt: new Date(item.created_at * 1000).toISOString(),
  };
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
    throw new ApiError(
      '관찰 서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.',
      0,
      'NETWORK_ERROR',
    );
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(
      body.error?.message || '관찰 요청을 처리하지 못했어요.',
      response.status,
      body.error?.code,
      body.error?.fields,
    );
  }
  return response.json() as Promise<T>;
}
export const reviewApi = {
  labels: (datasetId: string, signal?: AbortSignal) =>
    request<LabelIntervals>(
      `/datasets/${encodeURIComponent(datasetId)}/label-intervals?code=1&limit=500`,
      { signal },
    ),
  list: (datasetId: string, offset = 0, signal?: AbortSignal) =>
    request<Paginated<SavedObservation>>(
      `/observations?${new URLSearchParams({ dataset_id: datasetId, limit: '100', offset: String(offset) })}`,
      { signal },
    ),
  get: (id: string, signal?: AbortSignal) =>
    request<SavedObservation>(`/observations/${encodeURIComponent(id)}`, { signal }),
  create: (input: ObservationCreate) =>
    request<SavedObservation>('/observations', { method: 'POST', body: JSON.stringify(input) }),
  patch: (
    id: string,
    revision: number,
    input: Pick<ObservationCreate, 'location' | 'content' | 'judgment'>,
  ) =>
    request<SavedObservation>(`/observations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ revision, ...input }),
    }),
};
