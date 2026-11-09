import { API_BASE, ApiError } from './api';

// 모든 AX 화면도 기존 로그인 세션과 변경 요청 검사를 그대로 사용한다.
export async function axRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);

  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET') headers.set('X-Requested-With', 'kkobugi-web');
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));

    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError(body.error?.message || '요청을 완료하지 못했어요.', response.status);
  }
  return response.json() as Promise<T>;
}

export async function axDownload(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' });

  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('kkobugi:unauthorized'));
    throw new ApiError('파일을 내려받지 못했어요.', response.status);
  }
  const downloadUrl = URL.createObjectURL(await response.blob());

  const anchor = document.createElement('a');

  anchor.href = downloadUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

export interface ReplayManifest {
  id: string;
  run_id: string;
  model_key: 'xgboost' | 'autoencoder';
  dataset_id: string;
  total_rows: number;
  feature_columns: string[];
  start_time: string;
  end_time: string;
  synthetic: true;
  source_dataset_id?: string;
  source_split?: string;
}

export interface ReplayPoint {
  row_index: number;
  timestamp: string;
  value: number | null;
  predicted_code: 0 | 1;
  score: number;
}

export interface ReplayBatch {
  replay_id: string;
  channel: string;
  points: ReplayPoint[];
  next_cursor: number;
  total_rows: number;
  done: boolean;
  score_type: 'probability' | 'reconstruction_error';
  threshold: number | null;
  synthetic: true;
}

export interface AssistantCostInput {
  component_name?: string;
  quote_source?: string;
  parts_cost?: number;
  inspection_cost?: number;
  labor_hours?: number;
  labor_hourly_rate?: number;
  downtime_hours?: number;
  downtime_loss_per_hour?: number;
  standby_available?: boolean;
}

export interface AssistantRequest {
  question: string;
  run_id: string;
  model_key: string;
  split: 'validation' | 'test';
  observation?: string;
  cost_inputs?: AssistantCostInput;
  expertise: 'pro' | 'pro-plus';
}

export interface Citation {
  id: string;
  title: string;
  url: string;
  pages: string;
  summary: string;
}

export interface AssistantReply {
  message_id: string;
  created_at: number | string;
  answer: string;
  source_mode: 'retrieval' | 'llm';
  model_snapshot: Record<string, unknown>;
  citations: Citation[];
  cost: {
    currency: string;
    total: number | null;
    known_subtotal: number;
    missing: string[];
    assumptions: string[];
  };
  suggested_checks: string[];
  limitations: string[];
}

export interface ReportJob {
  id: string;
  status: 'queued' | 'generating' | 'completed' | 'failed';
  title: string;
  error_message?: string | null;
  preview?: {
    title: string;
    sections: { heading: string; paragraphs: string[] }[];
    citations: Citation[];
  } | null;
}
