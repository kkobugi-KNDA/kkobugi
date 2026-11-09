import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertiseProvider } from '../context/ExpertiseContext';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';
import type { ReplayBatch, ReplayManifest } from '../lib/ax-api';
import MonitorPage from './MonitorPage';

const mocks = vi.hoisted(() => ({ useApp: vi.fn() }));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));

const manifest: ReplayManifest = {
  id: 'f'.repeat(32),
  run_id: DEMO_RUN_DETAIL.run.id,
  model_key: 'xgboost',
  dataset_id: 'c'.repeat(32),
  total_rows: 230000,
  feature_columns: ['sensor_04'],
  start_time: '2026-11-09T00:00:00',
  end_time: '2026-11-11T15:53:19',
  synthetic: true,
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function batch(): ReplayBatch {
  return {
    replay_id: manifest.id,
    channel: 'sensor_04',
    next_cursor: 2,
    total_rows: 230000,
    done: false,
    score_type: 'probability',
    threshold: null,
    synthetic: true,
    points: [
      { row_index: 0, timestamp: '2026-11-09T00:00:00', value: 12, predicted_code: 0, score: 0.1 },
      { row_index: 1, timestamp: '2026-11-09T00:00:01', value: 18, predicted_code: 1, score: 0.9 },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.useApp.mockReturnValue({
    mode: 'live',
    user: { id: 1, username: 'worker', display_name: '작업자' },
    runs: [
      {
        ...DEMO_RUN_DETAIL.run,
        owner_id: 1,
        status: 'completed',
        selected_model: 'xgboost',
        evaluation_status: 'completed',
      },
    ],
    datasets: [DEMO_DATASET_DETAIL.dataset],
    selectedRunId: DEMO_RUN_DETAIL.run.id,
    setSelectedRunId: vi.fn(),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountAndChoose() {
  const view = render(
    <MemoryRouter>
      <ExpertiseProvider>
        <MonitorPage />
      </ExpertiseProvider>
    </MemoryRouter>,
  );

  await act(async () => {});
  fireEvent.change(screen.getByLabelText('생성한 재생 데이터'), { target: { value: manifest.id } });
  return view;
}

describe('수신한 행만 표시하는 실시간 재생', () => {
  it('선택한 실행이 아직 준비되지 않았으면 다른 과거 모델로 자동 전환하지 않는다', async () => {
    const context = mocks.useApp();

    mocks.useApp.mockReturnValue({
      ...context,
      selectedRunId: 'b'.repeat(32),
      runs: [...context.runs, { ...context.runs[0], id: '9'.repeat(32), owner_id: 2 }],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ items: [] })));
    render(
      <MemoryRouter>
        <ExpertiseProvider>
          <MonitorPage />
        </ExpertiseProvider>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(screen.getByLabelText('사용할 AI')).toHaveValue('');
    expect(screen.getByRole('button', { name: '23만 행 데이터 생성' })).toBeDisabled();
    expect(screen.queryByRole('option', { name: /99999999/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('사용할 AI'), { target: { value: context.runs[0].id } });
    expect(screen.getByRole('button', { name: '23만 행 데이터 생성' })).toBeEnabled();
  });
  it('요청을 겹치지 않고 일시정지·화면 종료 시 진행 중 요청을 취소하며 이어지는 cursor로만 받는다', async () => {
    let resolveFirst: (response: Response) => void = () => {};

    let batchCalls = 0;

    const batchSignals: AbortSignal[] = [];

    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);

      if (path === '/api/v1/replays') return Promise.resolve(json({ items: [manifest] }));
      if (path.includes('/batch?')) {
        batchCalls += 1;
        batchSignals.push(init?.signal as AbortSignal);
        if (batchCalls === 1)
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        if (batchCalls === 2) return Promise.resolve(json(batch()));
        return new Promise<Response>(() => {});
      }
      throw new Error(`예상하지 않은 API ${path}`);
    });

    vi.stubGlobal('fetch', fetcher);
    const { unmount } = await mountAndChoose();

    expect(batchCalls).toBe(0);
    expect(
      screen.getByRole('img', { name: 'sensor_04 수신된 값 그래프. 0개 표시' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '실시간 재생 시작' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(batchCalls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(batchCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '재생 일시 정지' }));
    expect(batchSignals[0].aborted).toBe(true);
    await act(async () => {
      resolveFirst(json(batch()));
    });
    expect(
      screen.getByRole('img', { name: 'sensor_04 수신된 값 그래프. 0개 표시' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '실시간 재생 시작' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(batchCalls).toBe(2);
    expect(
      screen.getByRole('img', { name: 'sensor_04 수신된 값 그래프. 2개 표시' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '신호 확인함' })).toBeInTheDocument();
    expect(screen.getByLabelText('펌프 점검 신호 표시')).toHaveClass('has-signal');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(batchCalls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(batchCalls).toBe(3);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain('cursor=2&limit=60&channel=sensor_04');
    expect(batchSignals[2].aborted).toBe(false);
    unmount();
    expect(batchSignals[2].aborted).toBe(true);
  });

  it('수신 실패를 정상 상태로 처리하지 않고 오류를 알린 뒤 재생을 멈춘다', async () => {
    const fetcher = vi.fn((input: string | URL | Request) =>
      String(input) === '/api/v1/replays'
        ? Promise.resolve(json({ items: [manifest] }))
        : Promise.resolve(json({ error: { message: '모델 입력을 확인할 수 없어요.' } }, 422)),
    );

    vi.stubGlobal('fetch', fetcher);
    await mountAndChoose();

    fireEvent.click(screen.getByRole('button', { name: '실시간 재생 시작' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('모델 입력을 확인할 수 없어요.');
    expect(screen.getByRole('button', { name: '실시간 재생 시작' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'sensor_04 수신된 값 그래프. 0개 표시' }),
    ).toBeInTheDocument();
    const before = fetcher.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetcher).toHaveBeenCalledTimes(before);
  });
});
