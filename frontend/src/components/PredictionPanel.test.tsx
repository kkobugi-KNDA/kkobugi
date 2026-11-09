import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import {
  predictionApi,
  type PredictionIntervalsResponse,
  type PredictionOverlay,
} from '../lib/prediction-api';
import type { ModelKey, RunDetail, RunResults } from '../types';
import PredictionPanel from './PredictionPanel';
import { csvTimestampToNumber, type SelectedRange } from './TimeSeriesChart';

const identifiers = { dataset: 'a'.repeat(32), run: 'b'.repeat(32) };

const context = vi.hoisted(() => ({
  user: { id: 1, username: 'worker', display_name: '작업자' },
  runs: [] as unknown[],
  selectedRunId: 'b'.repeat(32),
  setSelectedRunId: vi.fn(),
  refreshRuns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../context/AppContext', () => ({ useApp: () => context }));

function detail(modelKey: ModelKey | null = 'lightgbm'): RunDetail {
  return {
    run: {
      id: identifiers.run,
      dataset_id: identifiers.dataset,
      owner_id: 1,
      status: 'completed',
      created_at: 1,
      updated_at: 1,
      selected_model: modelKey,
      evaluation_status: 'not_started',
      completed_models: 2,
      total_models: 2,
      error_message: null,
    },
    configuration: {
      dataset_id: identifiers.dataset,
      feature_columns: ['sensor_00'],
      models: ['lightgbm', 'autoencoder'],
      train_end: '2026-11-09T00:01:00',
      validation_end: '2026-11-09T00:05:00',
      ranking_metric: 'f1',
      random_seed: 42,
    },
    input_sha256: 'c'.repeat(64),
    split: null,
    environment: {},
    warnings: [],
  };
}

const results = {
  run_id: identifiers.run,
  status: 'completed',
  metric: 'f1',
  selected_model: null,
  items: [
    { model_key: 'lightgbm', display_name: 'LightGBM' },
    { model_key: 'autoencoder', display_name: 'AutoEncoder' },
  ],
} as RunResults;

function intervalResponse(modelKey: ModelKey = 'lightgbm'): PredictionIntervalsResponse {
  return {
    run_id: identifiers.run,
    dataset_id: identifiers.dataset,
    model_key: modelKey,
    split: 'validation',
    score_type: modelKey === 'autoencoder' ? 'reconstruction_error' : 'probability',
    threshold: modelKey === 'autoencoder' ? 1.5 : null,
    input_sha256: 'c'.repeat(64),
    artifact_sha256: 'd'.repeat(64),
    predicted_code: 1,
    cadence_seconds: 60,
    items: [
      {
        start_time: '2026-11-09T00:02:00',
        end_time: '2026-11-09T00:03:00',
        start_row: 2,
        end_row: 4,
        row_count: 2,
      },
    ],
    total: 1,
    limit: 500,
    offset: 0,
  };
}

const selectedRange: SelectedRange = {
  start: {
    time: csvTimestampToNumber('2026-11-09T00:02:00'),
    timestamp: '2026-11-09T00:02:00',
    value: 10,
    label: 'normal',
  },
  end: {
    time: csvTimestampToNumber('2026-11-09T00:03:00'),
    timestamp: '2026-11-09T00:03:00',
    value: 15,
    label: 'normal',
  },
};

function panel(
  onChange = vi.fn(),
  selection: SelectedRange | null = null,
  datasetId = identifiers.dataset,
) {
  return (
    <MemoryRouter>
      <PredictionPanel
        datasetId={datasetId}
        channel="sensor_00"
        mode="live"
        selection={selection}
        onChange={onChange}
      />
    </MemoryRouter>
  );
}

describe('prediction context and result presentation', () => {
  beforeEach(() => {
    context.runs = [detail().run];
    context.selectedRunId = identifiers.run;
    vi.spyOn(api, 'run').mockResolvedValue(detail());
    vi.spyOn(api, 'results').mockResolvedValue(results);
    vi.spyOn(predictionApi, 'intervals').mockResolvedValue(intervalResponse());
    vi.spyOn(predictionApi, 'points').mockResolvedValue({
      ...intervalResponse(),
      items: [],
      total: 0,
      limit: 50,
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('does not pick a model from metric rank when the user has not selected one', async () => {
    vi.mocked(api.run).mockResolvedValue(detail(null));
    const onChange = vi.fn();

    render(panel(onChange));
    await screen.findByRole('option', { name: 'LightGBM' });
    expect(screen.getByLabelText('예측 모델')).toHaveValue('');
    expect(predictionApi.intervals).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByLabelText('예측 모델'), 'lightgbm');
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modelResult: { run_id: identifiers.run, model_key: 'lightgbm', split: 'validation' },
        }),
      ),
    );
  });

  it('does not query Test before the selected model evaluation is completed', async () => {
    render(panel());
    await screen.findByText(/예측 1 구간 1 \/ 1개/);
    expect(screen.getByRole('option', { name: 'Test · 선택 모델 평가 완료 후' })).toBeDisabled();
    expect(
      vi
        .mocked(predictionApi.intervals)
        .mock.calls.every(([, query]) => query.split === 'validation'),
    ).toBe(true);
  });

  it('keeps an unavailable response distinct from a valid result with no anomalies, then retries the same model', async () => {
    vi.mocked(predictionApi.intervals).mockRejectedValueOnce(
      new ApiError('서버가 예측을 읽지 못함', 503),
    );
    const onChange = vi.fn();

    render(panel(onChange));
    await screen.findByRole('alert');
    expect(screen.queryByText(/예측 1 구간 0/)).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: '서버가 예측을 읽지 못함', modelResult: null }),
    );
    await userEvent.click(screen.getByRole('button', { name: '예측 다시 불러오기' }));
    await screen.findByText(/예측 1 구간 1 \/ 1개/);
    expect(screen.getByLabelText('예측 모델')).toHaveValue('lightgbm');
  });

  it('renders AutoEncoder reconstruction error without converting it to a probability', async () => {
    vi.mocked(api.run).mockResolvedValue(detail('autoencoder'));
    vi.mocked(predictionApi.intervals).mockResolvedValue(intervalResponse('autoencoder'));
    vi.mocked(predictionApi.points).mockResolvedValue({
      ...intervalResponse('autoencoder'),
      total: 1,
      limit: 50,
      items: [
        {
          row_index: 2,
          timestamp: selectedRange.start.timestamp,
          actual_label: 'normal',
          actual_code: 0,
          predicted_label: 'abnormal',
          predicted_code: 1,
          score: 4.2,
        },
      ],
    });
    render(panel(vi.fn(), selectedRange));
    await screen.findByRole('columnheader', { name: '재구성 오차' });
    expect(screen.getByText(/학습 기준 1.5000/)).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4.2000' })).toBeInTheDocument();
    expect(screen.queryByText('420.00%')).not.toBeInTheDocument();
  });

  it('does not publish an old dataset response after the context changes', async () => {
    let resolveResponse: (value: PredictionIntervalsResponse) => void = () => {};

    vi.mocked(predictionApi.intervals).mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const onChange = vi.fn<(value: PredictionOverlay) => void>();

    const view = render(panel(onChange));

    await waitFor(() => expect(predictionApi.intervals).toHaveBeenCalled());
    view.rerender(panel(onChange, null, 'e'.repeat(32)));
    await act(async () => resolveResponse(intervalResponse()));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ intervals: [], modelResult: null }),
    );
    expect(screen.queryByText(/예측 1 구간 1 \/ 1개/)).not.toBeInTheDocument();
  });

  it('does not query model APIs in preview mode', async () => {
    render(
      <MemoryRouter>
        <PredictionPanel
          datasetId={identifiers.dataset}
          channel="sensor_00"
          mode="demo"
          selection={selectedRange}
          onChange={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/로그인 후 실제 데이터/)).toBeInTheDocument();
    expect(api.run).not.toHaveBeenCalled();
    expect(predictionApi.intervals).not.toHaveBeenCalled();
    expect(predictionApi.points).not.toHaveBeenCalled();
  });
});
