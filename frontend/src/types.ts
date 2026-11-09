export interface User {
  id: number;
  username: string;
  display_name: string;
}
export interface AuthResponse {
  user: User;
  expires_in: number;
}
export type AppMode = 'live' | 'demo';
export interface InspectionIssue {
  code: string;
  message: string;
  column: string | null;
  count: number;
  severity: 'error' | 'warning';
}
export interface DatasetSummary {
  id: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  status: 'valid' | 'needs_review';
  created_at: number;
  owner_id: number;
  row_count: number;
  column_count: number;
  timestamp_column: string;
  label_column: string;
  normal_label: string;
  abnormal_label: string;
  channels: string[];
}
export interface CsvInspection {
  row_count: number;
  column_count: number;
  columns: string[];
  channels: string[];
  timestamp_column: string;
  label_column: string;
  time_start: string | null;
  time_end: string | null;
  timezone_mode: 'naive' | 'aware' | 'mixed' | null;
  invalid_timestamp_count: number;
  duplicate_timestamp_count: number;
  out_of_order_count: number;
  missing_counts: Record<string, number>;
  invalid_numeric_counts: Record<string, number>;
  label_counts: Record<string, number>;
  invalid_label_count: number;
  issues: InspectionIssue[];
  preview: Record<string, string>[];
  preview_truncated: boolean;
  is_valid: boolean;
}
export interface DatasetDetail {
  dataset: DatasetSummary;
  inspection: CsvInspection;
}
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export type ModelKey = 'dummy' | 'xgboost' | 'lightgbm' | 'autoencoder';
export type RankingMetric =
  | 'f1'
  | 'precision'
  | 'recall'
  | 'accuracy'
  | 'balanced_accuracy'
  | 'roc_auc'
  | 'average_precision';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed';
export type EvaluationStatus = 'not_started' | RunStatus;
export interface RunCreate {
  dataset_id: string;
  feature_columns: string[];
  models: ModelKey[];
  train_end: string;
  validation_end: string;
  ranking_metric: RankingMetric;
  random_seed: number;
}
export interface RunSummary {
  id: string;
  dataset_id: string;
  owner_id: number;
  status: RunStatus;
  created_at: number;
  updated_at: number;
  selected_model: ModelKey | null;
  evaluation_status: EvaluationStatus;
  completed_models: number;
  total_models: number;
  error_message: string | null;
}
export interface SplitPart {
  start_row: number;
  end_row: number;
  row_count: number;
}
export type TrainingStage =
  'data_check' | 'split' | 'input_preparation' | 'training' | 'validation' | 'saving' | 'completed';

export interface TrainingProgressEvent {
  stage: TrainingStage;
  status: 'running' | 'completed' | 'failed';
  timestamp: number;
  message: string;
  model_key?: ModelKey | null;
}

export interface RunDetail {
  run: RunSummary;
  configuration: RunCreate;
  input_sha256: string;
  split: { train: SplitPart; validation: SplitPart; test: SplitPart } | null;
  environment: Record<string, string>;
  warnings: string[];
  // 과거 실행에는 단계별 기록이 없을 수 있다. 빈 기록에서 완료 단계를 추측하지 않는다.
  training_progress?: TrainingProgressEvent[];
}
export interface ClassMetrics {
  precision: number | null;
  recall: number | null;
  f1: number | null;
  support: number;
}
export interface EvaluationMetrics {
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  balanced_accuracy: number | null;
  roc_auc: number | null;
  average_precision: number | null;
  confusion_matrix: number[][];
  class_metrics: Record<string, ClassMetrics>;
  sample_count: number;
  warnings: string[];
}
export interface ModelResult {
  model_key: ModelKey;
  display_name: string;
  parameters: Record<string, unknown>;
  validation_metrics: EvaluationMetrics;
  training_seconds: number;
  artifact_sha256: string;
  warnings: string[];
  rank: number | null;
  sort_value: number | null;
}
export interface RunResults {
  run_id: string;
  status: RunStatus;
  metric: RankingMetric;
  items: ModelResult[];
  selected_model: ModelKey | null;
}
export interface EvaluationResponse {
  run_id: string;
  status: EvaluationStatus;
  model_key: ModelKey | null;
  metrics: EvaluationMetrics | null;
  error_message: string | null;
}
export interface ModelDefinition {
  key: ModelKey;
  display_name: string;
  kind: 'baseline' | 'classifier' | 'anomaly_detector';
  description: string;
  parameters: Record<string, unknown>;
}
export interface ChartPoint {
  time: number;
  timestamp: string;
  value: number | null;
  label: string;
}
export interface Observation {
  id: string;
  datasetId: string;
  channel: string;
  start: string;
  end: string;
  location: string;
  text: string;
  judgment: 'pending' | 'candidate' | 'normal';
  createdAt: string;
}
