import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PredictionPanel from '../components/PredictionPanel';
import ReviewWorkflowPanel from '../components/ReviewWorkflowPanel';
import TimeSeriesChart, { type SelectedRange } from '../components/TimeSeriesChart';
import { emptyPredictionOverlay } from '../lib/prediction-api';
import type { ReviewHistoryItem, ReviewRecord } from '../lib/assessment-api';
import type { SavedObservation } from '../lib/review-api';
import { DEMO_DATASET_DETAIL, DEMO_RESULTS, DEMO_RUN_DETAIL, demoSeries } from '../data/demo';

const mocks = vi.hoisted(() => ({ useApp: vi.fn() }));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));

const datasetId = DEMO_DATASET_DETAIL.dataset.id;

const runId = DEMO_RUN_DETAIL.run.id;

const reviewId = 'c'.repeat(32);

const worker = { id: 1, username: 'worker', display_name: '현장 확인자' };

const ownerRun = {
  ...DEMO_RUN_DETAIL,
  run: { ...DEMO_RUN_DETAIL.run, owner_id: worker.id },
};

const sourcePoints = demoSeries('sensor_04').slice(209, 215);

const predictionRange = { start: sourcePoints[2], end: sourcePoints[3] };

const observation: SavedObservation = {
  id: 'a'.repeat(32),
  dataset_id: datasetId,
  run_id: null,
  model_key: null,
  channel: 'sensor_04',
  start_time: predictionRange.start.timestamp,
  end_time: predictionRange.end.timestamp,
  location: '사용자가 확인한 위치',
  content: '처음 확인한 누수 흔적',
  judgment: 'needs_check',
  revision: 1,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
  author: worker,
  last_editor: worker,
};

const conclusion = '모델의 변화와 현장 누수 흔적을 함께 확인함. 원인 판단은 보류.';

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function connectedView() {
  return render(
    <MemoryRouter>
      <ConnectedReviewFlow />
    </MemoryRouter>,
  );
}

function ConnectedReviewFlow() {
  const [selection, setSelection] = useState<SelectedRange | null>(null);

  const [overlay, setOverlay] = useState(emptyPredictionOverlay);

  return (
    <>
      <PredictionPanel
        datasetId={datasetId}
        channel="sensor_04"
        mode="live"
        selection={selection}
        onChange={setOverlay}
      />
      <TimeSeriesChart
        points={sourcePoints}
        channel="sensor_04"
        abnormalLabel="1"
        selection={selection}
        onSelection={setSelection}
        labelIntervals={[{ start: sourcePoints[1], end: sourcePoints[1] }]}
        predictionIntervals={overlay.intervals}
        predictionLabel={overlay.label}
        predictionStatus={overlay.status}
        predictionIntervalsTruncated={overlay.truncated}
      />
      <ReviewWorkflowPanel
        datasetId={datasetId}
        channel="sensor_04"
        mode="live"
        selection={selection}
        modelResult={overlay.modelResult}
        observations={[observation]}
      />
    </>
  );
}

beforeEach(() => {
  mocks.useApp.mockReturnValue({
    user: worker,
    mode: 'live',
    runs: [ownerRun.run],
    selectedRunId: runId,
    setSelectedRunId: vi.fn(),
    refreshRuns: vi.fn().mockResolvedValue(undefined),
    toast: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('예측 그래프에서 검토 완료까지 연결', () => {
  it('모델 구간을 골라 실제 모델 참조와 관찰 버전으로 저장하고 완료·이력을 읽는다', async () => {
    let review: ReviewRecord | null = null;

    const history: ReviewHistoryItem[] = [];

    const writes: { path: string; body: Record<string, unknown> }[] = [];

    const keepHistory = (action: ReviewHistoryItem['action']) => {
      if (!review) throw new Error('아직 생성하지 않은 검토');
      history.unshift({
        revision: review.revision,
        action,
        reason: '',
        changed_at: review.updated_at,
        changed_by: worker,
        snapshot: structuredClone(review),
      });
    };

    // 화면이나 API 모듈을 흉내 내지 않고 서버 경계에서 요청·응답을 검사한다.
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(String(input), 'https://local.test');

      const method = options?.method || 'GET';

      expect(options?.credentials).toBe('include');
      if (method !== 'GET') {
        expect(new Headers(options?.headers).get('X-Requested-With')).toBe('kkobugi-web');
      }
      const body = options?.body
        ? (JSON.parse(String(options.body)) as Record<string, unknown>)
        : {};

      if (method !== 'GET') writes.push({ path: url.pathname, body });
      if (url.pathname === `/api/v1/runs/${runId}`) return response(ownerRun);
      if (url.pathname === `/api/v1/runs/${runId}/results`) return response(DEMO_RESULTS);
      if (url.pathname.endsWith('/prediction-intervals') || url.pathname.endsWith('/predictions')) {
        const context = {
          run_id: runId,
          dataset_id: datasetId,
          model_key: 'xgboost',
          split: 'validation',
          score_type: 'probability',
          threshold: null,
          input_sha256: 'd'.repeat(64),
          artifact_sha256: 'f'.repeat(64),
          total: 1,
          limit: 500,
          offset: 0,
        };

        expect(url.searchParams.get('model_key')).toBe('xgboost');
        expect(url.searchParams.get('split')).toBe('validation');
        if (url.pathname.endsWith('/prediction-intervals'))
          return response({
            ...context,
            predicted_code: 1,
            cadence_seconds: 60,
            items: [
              {
                start_time: predictionRange.start.timestamp,
                end_time: predictionRange.end.timestamp,
                start_row: 211,
                end_row: 213,
                row_count: 2,
              },
            ],
          });
        expect(url.searchParams.get('start_time')).toBe(predictionRange.start.timestamp);
        expect(url.searchParams.get('end_time')).toBe(predictionRange.end.timestamp);
        return response({
          ...context,
          total: 2,
          limit: 50,
          items: [predictionRange.start, predictionRange.end].map((point, index) => ({
            row_index: 211 + index,
            timestamp: point.timestamp,
            actual_label: '0',
            actual_code: 0,
            predicted_label: '1',
            predicted_code: 1,
            score: 0.92,
          })),
        });
      }
      if (url.pathname === '/api/v1/reviews' && method === 'GET') {
        expect(url.searchParams.get('dataset_id')).toBe(datasetId);
        expect(url.searchParams.get('channel')).toBe('sensor_04');
        return response({
          items: review ? [review] : [],
          total: review ? 1 : 0,
          limit: 20,
          offset: 0,
        });
      }
      if (url.pathname === '/api/v1/reviews' && method === 'POST') {
        expect(body).toMatchObject({
          dataset_id: datasetId,
          channel: 'sensor_04',
          start_time: predictionRange.start.timestamp,
          end_time: predictionRange.end.timestamp,
          conclusion,
          judgment: 'needs_check',
          model_result: { run_id: runId, model_key: 'xgboost', split: 'validation' },
          observations: [{ observation_id: observation.id, revision: 1 }],
        });
        review = {
          id: reviewId,
          dataset_id: datasetId,
          channel: 'sensor_04',
          start_time: predictionRange.start.timestamp,
          end_time: predictionRange.end.timestamp,
          conclusion,
          judgment: 'needs_check',
          status: 'in_progress',
          revision: 1,
          created_at: 1_700_000_000,
          updated_at: 1_700_000_000,
          author: worker,
          last_editor: worker,
          completed_at: null,
          completed_by: null,
          evidence: {
            model_result: {
              run_id: runId,
              model_key: 'xgboost',
              split: 'validation',
              display_name: 'XGBoost',
              input_sha256: 'd'.repeat(64),
              artifact_sha256: 'f'.repeat(64),
              feature_columns: ['sensor_04'],
              train_end: DEMO_RUN_DETAIL.configuration.train_end,
              validation_end: DEMO_RUN_DETAIL.configuration.validation_end,
              partition: DEMO_RUN_DETAIL.split!.validation,
              partition_metrics: { ...DEMO_RESULTS.items[0].validation_metrics, sample_count: 80 },
              metrics_scope: 'full_partition',
              parameters: {},
              environment: { python: '3.12' },
            },
            observations: [structuredClone(observation)],
          },
        };
        keepHistory('created');
        return response(review, 201);
      }
      if (url.pathname === `/api/v1/reviews/${reviewId}` && method === 'GET')
        return response(review);
      if (url.pathname === `/api/v1/reviews/${reviewId}/complete`) {
        if (!review) throw new Error('검토 생성 전 완료 요청');
        expect(body).toEqual({ revision: 1 });
        review = {
          ...review,
          status: 'completed',
          revision: 2,
          completed_at: 1_700_000_060,
          completed_by: worker,
          updated_at: 1_700_000_060,
        };
        keepHistory('completed');
        return response(review);
      }
      if (url.pathname === `/api/v1/reviews/${reviewId}/history`)
        return response({
          review_id: reviewId,
          items: history,
          total: history.length,
          limit: 20,
          offset: 0,
        });
      throw new Error(`검증하지 않은 서버 요청: ${method} ${url.pathname}`);
    });

    vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup();

    connectedView();
    const predicted = await screen.findByRole('button', { name: /^모델 예측 1 구간/ });

    // 원본 라벨과 모델 예측은 서로 다른 시간 구간으로 동시에 표시한다.
    expect(screen.getByRole('button', { name: /^라벨 1 구간/ })).toBeInTheDocument();
    await user.click(predicted);
    await user.click(screen.getByRole('button', { name: '선택한 구간 검토하기' }));
    const createDialog = await screen.findByRole('dialog', { name: '검토 기록 만들기' });

    await user.type(within(createDialog).getByLabelText('검토 내용'), conclusion);
    const modelCheckbox = within(createDialog).getByRole('checkbox', {
      name: '선택한 모델 결과 연결',
    });

    if (!(modelCheckbox as HTMLInputElement).checked) await user.click(modelCheckbox);
    await user.click(within(createDialog).getByRole('checkbox', { name: /처음 확인한 누수 흔적/ }));
    await user.click(within(createDialog).getByRole('button', { name: '검토 초안 저장' }));
    await waitFor(() => expect(writes.some((item) => item.path === '/api/v1/reviews')).toBe(true));
    if (!screen.queryByRole('dialog', { name: '검토 기록' })) {
      await user.click(await screen.findByRole('button', { name: `검토 열기: ${conclusion}` }));
    }
    const detailDialog = await screen.findByRole('dialog', { name: '검토 기록' });

    await user.click(within(detailDialog).getByRole('button', { name: /^검토 완료$/ }));
    await waitFor(() =>
      expect(within(detailDialog).getByRole('button', { name: '다시 열기' })).toBeInTheDocument(),
    );
    await user.click(within(detailDialog).getByRole('button', { name: '수정 이력 보기' }));
    const originalHistory = await within(detailDialog).findByText(/^수정 1 당시 내용 보기/);

    expect(within(detailDialog).getByText(/^수정 2 당시 내용 보기/)).toBeInTheDocument();
    await user.click(originalHistory);
    expect(originalHistory.closest('details')).toHaveAttribute('open');
    expect(writes.map((item) => item.path)).toEqual([
      '/api/v1/reviews',
      `/api/v1/reviews/${reviewId}/complete`,
    ]);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/predictions?'))).toBe(true);
  });
});
