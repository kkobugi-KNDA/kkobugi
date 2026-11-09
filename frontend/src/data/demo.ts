import type {
  ChartPoint,
  DatasetDetail,
  EvaluationMetrics,
  EvaluationResponse,
  ModelDefinition,
  ModelResult,
  RunDetail,
  RunResults,
} from '../types';

export const DEMO_DATASET_ID = 'dddddddddddddddddddddddddddddddd';
export const DEMO_RUN_ID = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const DEMO_CHANNELS = ['sensor_04', 'sensor_10', 'sensor_20', 'sensor_38'];
export function demoSeries(channel = 'sensor_04'): ChartPoint[] {
  const channelIndex = Math.max(0, DEMO_CHANNELS.indexOf(channel));
  return Array.from({ length: 360 }, (_, i) => {
    const abnormal = (i >= 180 && i <= 200) || (i >= 260 && i <= 268) || (i >= 335 && i <= 342);
    const timestamp = `2018-04-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`;
    const wave = Math.sin(i * 0.1 + channelIndex) * 0.12 + Math.cos(i * 0.31) * 0.05;
    const value = 12 + channelIndex * 4 + wave + (abnormal ? 0.8 + Math.sin(i * 0.05) * 0.15 : 0);
    return {
      time: Date.UTC(2018, 3, 1, 0, i),
      timestamp,
      value: Number(value.toFixed(3)),
      label: abnormal ? '1' : '0',
    };
  });
}
const previewRows = demoSeries()
  .slice(0, 5)
  .map((p, i) =>
    Object.fromEntries([
      ['timestamp', p.timestamp],
      ...DEMO_CHANNELS.map((c) => [c, String(demoSeries(c)[i].value)]),
      ['label', p.label],
    ]),
  );
export const DEMO_DATASET_DETAIL: DatasetDetail = {
  dataset: {
    id: DEMO_DATASET_ID,
    filename: 'pump-demo.csv',
    size_bytes: 24360,
    sha256: 'demo-data-not-a-real-file-hash',
    status: 'valid',
    created_at: 1794180600,
    owner_id: 0,
    row_count: 360,
    column_count: 6,
    timestamp_column: 'timestamp',
    label_column: 'label',
    normal_label: '0',
    abnormal_label: '1',
    channels: DEMO_CHANNELS,
  },
  inspection: {
    row_count: 360,
    column_count: 6,
    columns: ['timestamp', ...DEMO_CHANNELS, 'label'],
    channels: DEMO_CHANNELS,
    timestamp_column: 'timestamp',
    label_column: 'label',
    time_start: '2018-04-01T00:00:00',
    time_end: '2018-04-01T05:59:00',
    timezone_mode: 'naive',
    invalid_timestamp_count: 0,
    duplicate_timestamp_count: 0,
    out_of_order_count: 0,
    missing_counts: {},
    invalid_numeric_counts: {},
    label_counts: { '0': 322, '1': 38 },
    invalid_label_count: 0,
    issues: [],
    preview: previewRows,
    preview_truncated: false,
    is_valid: true,
  },
};
export const DEMO_MODELS: ModelDefinition[] = [
  {
    key: 'lightgbm',
    display_name: 'LightGBM',
    kind: 'classifier',
    description: '같은 시간 분할로 학습하는 지도 분류 모델',
    parameters: { n_estimators: 100 },
  },
  {
    key: 'xgboost',
    display_name: 'XGBoost',
    kind: 'classifier',
    description: '같은 시간 분할로 학습하는 지도 분류 모델',
    parameters: { n_estimators: 100, max_depth: 4, learning_rate: 0.1 },
  },
  {
    key: 'autoencoder',
    display_name: 'AutoEncoder',
    kind: 'anomaly_detector',
    description: '정상 Train의 패턴을 학습하는 재구성 모델',
    parameters: { threshold_quantile: 0.99, training_scope: 'normal_train_only' },
  },
];
export const DEMO_RUN_DETAIL: RunDetail = {
  run: {
    id: DEMO_RUN_ID,
    dataset_id: DEMO_DATASET_ID,
    owner_id: 0,
    status: 'completed',
    created_at: 1794181200,
    updated_at: 1794181260,
    selected_model: 'xgboost',
    evaluation_status: 'not_started',
    completed_models: 3,
    total_models: 3,
    error_message: null,
  },
  configuration: {
    dataset_id: DEMO_DATASET_ID,
    feature_columns: DEMO_CHANNELS,
    models: ['xgboost', 'lightgbm', 'autoencoder'],
    train_end: '2018-04-01T03:29:00',
    validation_end: '2018-04-01T04:49:00',
    ranking_metric: 'f1',
    random_seed: 42,
  },
  input_sha256: 'demo-data-not-a-real-file-hash',
  split: {
    train: { start_row: 0, end_row: 210, row_count: 210 },
    validation: { start_row: 210, end_row: 290, row_count: 80 },
    test: { start_row: 290, end_row: 360, row_count: 70 },
  },
  environment: { mode: 'UI preview' },
  warnings: ['화면 구성 확인을 위한 예시 결과입니다. 실제 학습 지표가 아닙니다.'],
};
function metrics(confusion_matrix: number[][], roc_auc: number): EvaluationMetrics {
  const [[tn, fp], [fn, tp]] = confusion_matrix,
    sample_count = tn + fp + fn + tp;
  const precision = tp + fp ? tp / (tp + fp) : null,
    recall = tp / (tp + fn);
  const f1 =
    precision == null || precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return {
    accuracy: (tp + tn) / sample_count,
    precision,
    recall,
    f1,
    balanced_accuracy: (recall + tn / (tn + fp)) / 2,
    roc_auc,
    average_precision: roc_auc,
    confusion_matrix,
    class_metrics: {
      normal: {
        precision: tn / (tn + fn),
        recall: tn / (tn + fp),
        f1: (2 * tn) / (2 * tn + fp + fn),
        support: tn + fp,
      },
      abnormal: { precision, recall, f1, support: tp + fn },
    },
    sample_count,
    warnings: ['화면 미리보기용 예시 지표'],
  };
}
const results: ModelResult[] = [
  {
    model_key: 'xgboost',
    display_name: 'XGBoost',
    parameters: {},
    validation_metrics: metrics(
      [
        [69, 2],
        [1, 8],
      ],
      0.95,
    ),
    training_seconds: 2.4,
    artifact_sha256: 'demo',
    warnings: [],
    rank: 1,
    sort_value: 0.842,
  },
  {
    model_key: 'lightgbm',
    display_name: 'LightGBM',
    parameters: {},
    validation_metrics: metrics(
      [
        [68, 3],
        [1, 8],
      ],
      0.93,
    ),
    training_seconds: 1.6,
    artifact_sha256: 'demo',
    warnings: [],
    rank: 2,
    sort_value: 0.8,
  },
  {
    model_key: 'autoencoder',
    display_name: 'AutoEncoder',
    parameters: {},
    validation_metrics: metrics(
      [
        [67, 4],
        [2, 7],
      ],
      0.88,
    ),
    training_seconds: 4.1,
    artifact_sha256: 'demo',
    warnings: [],
    rank: 3,
    sort_value: 0.7,
  },
];
export const DEMO_RESULTS: RunResults = {
  run_id: DEMO_RUN_ID,
  status: 'completed',
  metric: 'f1',
  items: results,
  selected_model: 'xgboost',
};
export const DEMO_EVALUATION: EvaluationResponse = {
  run_id: DEMO_RUN_ID,
  status: 'completed',
  model_key: 'xgboost',
  metrics: metrics(
    [
      [60, 2],
      [1, 7],
    ],
    0.94,
  ),
  error_message: null,
};
