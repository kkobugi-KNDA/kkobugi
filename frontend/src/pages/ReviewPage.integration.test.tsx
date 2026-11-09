import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ReviewPage from './ReviewPage';
import {
  DEMO_CHANNELS,
  DEMO_DATASET_DETAIL,
  DEMO_RESULTS,
  DEMO_RUN_DETAIL,
  demoSeries,
} from '../data/demo';

const mocks = vi.hoisted(() => ({ useApp: vi.fn(), parseCsv: vi.fn() }));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('papaparse', () => ({ default: { parse: mocks.parseCsv } }));

const worker = { id: 1, username: 'worker', display_name: '검토 담당자' };

const dataset = {
  ...DEMO_DATASET_DETAIL,
  dataset: { ...DEMO_DATASET_DETAIL.dataset, owner_id: worker.id },
};

const run = { ...DEMO_RUN_DETAIL, run: { ...DEMO_RUN_DETAIL.run, owner_id: worker.id } };

const source = demoSeries('sensor_04');

const intervalStart = source[211].timestamp;

const intervalEnd = source[212].timestamp;

const csvRows = source.map((point, index) =>
  Object.fromEntries([
    ['timestamp', point.timestamp],
    ...DEMO_CHANNELS.map((channel) => [channel, String(demoSeries(channel)[index].value)]),
    ['label', point.label],
  ]),
);

const csvText = [
  'timestamp,' + DEMO_CHANNELS.join(',') + ',label',
  ...csvRows.map((row) =>
    ['timestamp', ...DEMO_CHANNELS, 'label'].map((column) => row[column]).join(','),
  ),
].join('\n');

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  mocks.useApp.mockReturnValue({
    user: worker,
    mode: 'live',
    datasets: [dataset.dataset],
    runs: [run.run],
    selectedDatasetId: dataset.dataset.id,
    selectedRunId: run.run.id,
    setSelectedDatasetId: vi.fn(),
    setSelectedRunId: vi.fn(),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  });
  // JSDOM에는 CSV Web Worker가 없어 이 경계만 대신하고 실제 페이지·패널은 그대로 렌더링한다.
  mocks.parseCsv.mockImplementation(
    (
      _file: File,
      options: {
        chunk: (result: { data: typeof csvRows }, parser: { abort: () => void }) => void;
        complete: () => void;
      },
    ) => {
      let aborted = false;

      const parser = {
        abort: () => {
          aborted = true;
        },
      };

      queueMicrotask(() => {
        if (aborted) return;
        options.chunk({ data: csvRows }, parser);
        if (!aborted) options.complete();
      });
      return parser;
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('실제 구간 검토 페이지의 패널 통합', () => {
  it('비동기 그래프·예측 갱신과 채널 전환 뒤에도 예측·검토 패널을 하나씩 유지한다', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input), 'https://local.test');

      expect(options?.method ?? 'GET').toBe('GET');
      expect(options?.credentials).toBe('include');
      if (url.pathname === `/api/v1/datasets/${dataset.dataset.id}`) return json(dataset);
      if (url.pathname.endsWith('/file'))
        return new Response(csvText, {
          headers: { 'Content-Type': 'text/csv' },
        });
      if (url.pathname === '/api/v1/observations' || url.pathname === '/api/v1/reviews')
        return json({
          items: [],
          total: 0,
          limit: 20,
          offset: 0,
        });
      if (url.pathname.endsWith('/label-intervals'))
        return json({
          dataset_id: dataset.dataset.id,
          code: 1,
          normal_label: '0',
          abnormal_label: '1',
          timezone_mode: 'naive',
          cadence_seconds: 60,
          total: 1,
          limit: 500,
          offset: 0,
          items: [
            {
              start_time: source[180].timestamp,
              end_time: source[200].timestamp,
              start_row: 180,
              end_row: 201,
              row_count: 21,
            },
          ],
        });
      if (url.pathname === `/api/v1/runs/${run.run.id}`) return json(run);
      if (url.pathname.endsWith('/results')) return json(DEMO_RESULTS);
      const predictionContext = {
        run_id: run.run.id,
        dataset_id: dataset.dataset.id,
        model_key: 'xgboost',
        split: 'validation',
        score_type: 'probability',
        threshold: null,
        input_sha256: 'd'.repeat(64),
        artifact_sha256: 'f'.repeat(64),
        total: 1,
        offset: 0,
      };

      if (url.pathname.endsWith('/prediction-intervals'))
        return json({
          ...predictionContext,
          limit: 500,
          predicted_code: 1,
          cadence_seconds: 60,
          items: [
            {
              start_time: intervalStart,
              end_time: intervalEnd,
              start_row: 211,
              end_row: 213,
              row_count: 2,
            },
          ],
        });
      if (url.pathname.endsWith('/predictions'))
        return json({
          ...predictionContext,
          limit: 50,
          total: 2,
          items: [intervalStart, intervalEnd].map((timestamp, index) => ({
            row_index: 211 + index,
            timestamp,
            actual_label: '0',
            actual_code: 0,
            predicted_label: '1',
            predicted_code: 1,
            score: 0.91,
          })),
        });
      throw new Error(`검증하지 않은 조회: ${url.pathname}`);
    });

    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <ReviewPage />
      </MemoryRouter>,
    );
    const predictionButton = await screen.findByRole('button', { name: /^모델 예측 1 구간/ });

    expect(screen.getAllByRole('heading', { name: '예측 결과' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: '검토 완료와 이력' })).toHaveLength(1);
    await user.click(predictionButton);
    await waitFor(() =>
      expect(
        screen.getByRole('button', {
          name: '선택한 구간 검토하기',
        }),
      ).toBeEnabled(),
    );
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('/predictions?'))).toBe(true),
    );
    expect(screen.getAllByRole('heading', { name: '예측 결과' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: '검토 완료와 이력' })).toHaveLength(1);

    // 실제 페이지의 채널 상태를 바꾸고 새 요청이 반영된 뒤 형제 패널 개수를 다시 검사한다.
    await user.selectOptions(screen.getByLabelText('표시할 채널'), 'sensor_10');
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([rawUrl]) => {
          const url = new URL(String(rawUrl), 'https://local.test');

          return (
            url.pathname === '/api/v1/reviews' && url.searchParams.get('channel') === 'sensor_10'
          );
        }),
      ).toBe(true),
    );
    const changedPrediction = await screen.findByRole('button', { name: /^모델 예측 1 구간/ });

    expect(screen.getByRole('button', { name: '선택한 구간 검토하기' })).toBeDisabled();
    await user.click(changedPrediction);
    expect(screen.getByRole('button', { name: '선택한 구간 검토하기' })).toBeEnabled();
    expect(screen.getAllByRole('heading', { name: '예측 결과' })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: '검토 완료와 이력' })).toHaveLength(1);
    expect(mocks.parseCsv).toHaveBeenCalledTimes(2);
  });
});
