import type {
  AuthResponse,
  DatasetDetail,
  DatasetSummary,
  EvaluationResponse,
  ModelDefinition,
  ModelKey,
  Paginated,
  RankingMetric,
  RunCreate,
  RunDetail,
  RunResults,
  RunSummary,
} from '../types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = 'REQUEST_FAILED',
    public fields?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const API_BASE = (import.meta.env.VITE_API_BASE || '/api/v1').replace(/\/$/, '');
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('X-Requested-With', 'kkobugi-web');
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('서버에 연결하지 못했어요. 잠시 후 다시 시도해주세요.', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(
      body.error?.message || `요청을 처리하지 못했어요. (${response.status})`,
      response.status,
      body.error?.code,
      body.error?.fields,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const api = {
  me: (signal?: AbortSignal) => request<AuthResponse>('/auth/me', { signal }),
  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  datasets: (signal?: AbortSignal) =>
    request<Paginated<DatasetSummary>>('/datasets?limit=100', { signal }),
  dataset: (id: string, signal?: AbortSignal) =>
    request<DatasetDetail>(`/datasets/${encodeURIComponent(id)}`, { signal }),
  upload: (form: FormData, signal?: AbortSignal) =>
    request<DatasetDetail>('/datasets', { method: 'POST', body: form, signal }),
  models: (signal?: AbortSignal) => request<{ items: ModelDefinition[] }>('/models', { signal }),
  runs: (signal?: AbortSignal) => request<Paginated<RunSummary>>('/runs?limit=100', { signal }),
  run: (id: string, signal?: AbortSignal) =>
    request<RunDetail>(`/runs/${encodeURIComponent(id)}`, { signal }),
  createRun: (configuration: RunCreate) =>
    request<RunDetail>('/runs', { method: 'POST', body: JSON.stringify(configuration) }),
  results: (id: string, sort: RankingMetric = 'f1', signal?: AbortSignal) =>
    request<RunResults>(`/runs/${encodeURIComponent(id)}/results?sort_by=${sort}`, { signal }),
  selectModel: (id: string, model_key: ModelKey) =>
    request<RunDetail>(`/runs/${encodeURIComponent(id)}/selection`, {
      method: 'POST',
      body: JSON.stringify({ model_key }),
    }),
  evaluate: (id: string) =>
    request<EvaluationResponse>(`/runs/${encodeURIComponent(id)}/evaluation`, { method: 'POST' }),
  evaluation: (id: string, signal?: AbortSignal) =>
    request<EvaluationResponse>(`/runs/${encodeURIComponent(id)}/evaluation`, { signal }),
  async datasetFile(id: string, signal?: AbortSignal): Promise<File> {
    const response = await fetch(`${API_BASE}/datasets/${encodeURIComponent(id)}/file`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
      throw new ApiError('CSV를 불러오지 못했어요.', response.status);
    }
    return new File([await response.blob()], 'dataset.csv', { type: 'text/csv' });
  },
};
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : '요청을 처리하지 못했어요.';
