import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertiseProvider } from '../context/ExpertiseContext';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';
import type { SimulationBatch, SimulationManifest } from '../lib/simulation-api';
import SimulationPage from './SimulationPage';

const mocks = vi.hoisted(() => ({
  useApp: vi.fn(),
  axRequest: vi.fn(),
  uploadSimulation: vi.fn(),
  assistantProps: vi.fn(),
}));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('../lib/ax-api', () => ({ axRequest: mocks.axRequest }));
vi.mock('../lib/simulation-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/simulation-api')>()),
  uploadSimulation: mocks.uploadSimulation,
}));
vi.mock('../components/PumpSimulationScene', () => ({
  default: ({
    hasSignal,
    onSelectPart,
  }: {
    hasSignal: boolean;
    onSelectPart: (id: string) => void;
  }) => (
    <div data-testid="pump-scene" data-signal={String(hasSignal)}>
      <button onClick={() => onSelectPart('part-1')}>첫 부품 선택</button>
    </div>
  ),
}));
vi.mock('../components/AxAssistantPanel', () => ({
  default: (props: unknown) => {
    mocks.assistantProps(props);
    return <div data-testid="simulation-assistant">점검 안내</div>;
  },
}));

const manifest: SimulationManifest = {
  id: 'f'.repeat(32),
  run_id: DEMO_RUN_DETAIL.run.id,
  model_key: 'xgboost',
  filename: 'sensor_demo_2026_11.csv',
  total_rows: 43200,
  feature_columns: ['sensor_00', 'sensor_04'],
  start_time: '2026-11-01T00:00:00',
  end_time: '2026-11-30T23:59:00',
  synthetic: true,
  created_at: 1794260000,
};

function context() {
  return {
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
    refreshRuns: vi.fn().mockResolvedValue(undefined),
  };
}

function batch(): SimulationBatch {
  return {
    simulation_id: manifest.id,
    channel: 'sensor_00',
    next_cursor: 2,
    total_rows: manifest.total_rows,
    done: false,
    score_type: 'probability',
    threshold: null,
    synthetic: true,
    points: [
      { row_index: 0, timestamp: manifest.start_time, value: 12, predicted_code: 0, score: 0.1 },
      { row_index: 1, timestamp: '2026-11-01T00:01:00', value: 18, predicted_code: 1, score: 0.9 },
    ],
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <ExpertiseProvider>
        <SimulationPage />
      </ExpertiseProvider>
    </MemoryRouter>,
  );
}

async function mountAndChoose() {
  const view = mount();

  await act(async () => {});
  fireEvent.change(screen.getByLabelText('저장한 시뮬레이션 CSV'), {
    target: { value: manifest.id },
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.resetAllMocks();
  mocks.useApp.mockReturnValue(context());
  mocks.axRequest.mockResolvedValue({ items: [manifest] });
  mocks.uploadSimulation.mockResolvedValue(manifest);
});

afterEach(() => vi.useRealTimers());

describe('업로드한 한 달 CSV로 실행하는 시뮬레이션', () => {
  it('파일과 본인 모델을 고른 뒤 연결해야 재생할 수 있고 원래 기간과 행 수를 표시한다', async () => {
    const app = context();

    mocks.useApp.mockReturnValue({
      ...app,
      selectedRunId: 'b'.repeat(32),
      runs: [...app.runs, { ...app.runs[0], id: '9'.repeat(32), owner_id: 2 }],
    });
    mocks.axRequest.mockResolvedValue({ items: [] });
    mount();
    await act(async () => {});
    expect(screen.getByLabelText('시뮬레이션 모델')).toHaveValue('');
    expect(screen.getByRole('option', { name: /XGBoost/ })).toBeInTheDocument();
    expect(screen.getAllByRole('option', { name: /XGBoost/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'CSV 연결' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeDisabled();
    const file = new File(['timestamp,sensor_00\n2026-11-01T00:00:00,1\n'], manifest.filename, {
      type: 'text/csv',
    });

    fireEvent.change(screen.getByLabelText('시뮬레이션 CSV 업로드'), { target: { files: [file] } });
    expect(screen.getByRole('button', { name: 'CSV 연결' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('시뮬레이션 모델'), {
      target: { value: manifest.run_id },
    });
    expect(screen.getByRole('button', { name: 'CSV 연결' })).toBeEnabled();
    expect(mocks.uploadSimulation).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'CSV 연결' })));
    expect(mocks.uploadSimulation).toHaveBeenCalledExactlyOnceWith(
      file,
      manifest.run_id,
      'xgboost',
      expect.any(AbortSignal),
    );
    const range = document.querySelector('.simulation-range');

    expect(range).toHaveTextContent('2026-11-01 00:00:00');
    expect(range).toHaveTextContent('2026-11-30 23:59:00');
    expect(range).toHaveTextContent('43,200행 · 2채널');
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeEnabled();
    expect(mocks.axRequest.mock.calls.some(([path]) => String(path).includes('/batch?'))).toBe(
      false,
    );
  });

  it('시작 버튼에서만 배치를 받고 요청을 겹치지 않으며 정지·종료 시 취소한다', async () => {
    let resolveFirst: (value: SimulationBatch) => void = () => {};

    let batchCalls = 0;

    const batchSignals: AbortSignal[] = [];

    mocks.axRequest.mockImplementation((path: string, request: RequestInit) => {
      if (path === '/simulations') return Promise.resolve({ items: [manifest] });
      batchCalls += 1;
      batchSignals.push(request.signal as AbortSignal);
      if (batchCalls === 1)
        return new Promise<SimulationBatch>((resolve) => {
          resolveFirst = resolve;
        });
      if (batchCalls === 2) return Promise.resolve(batch());
      return new Promise<SimulationBatch>(() => {});
    });
    const { unmount } = await mountAndChoose();

    expect(batchCalls).toBe(0);
    expect(screen.queryByRole('region', { name: '시뮬레이션 그래프' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(batchCalls).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(batchCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 일시 정지' }));
    expect(batchSignals[0].aborted).toBe(true);
    await act(async () => resolveFirst(batch()));
    expect(screen.getByTestId('pump-scene')).toHaveAttribute('data-signal', 'false');
    fireEvent.click(screen.getByRole('checkbox', { name: '그래프 표시' }));
    expect(
      screen.getByRole('img', { name: 'sensor_00 수신된 값 그래프. 0개 표시' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(batchCalls).toBe(2);
    expect(
      screen.getByRole('img', { name: 'sensor_00 수신된 값 그래프. 2개 표시' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('pump-scene')).toHaveAttribute('data-signal', 'true');
    expect(screen.getByRole('button', { name: '신호 확인함' })).toBeInTheDocument();
    const countBeforeToggle = mocks.axRequest.mock.calls.length;

    fireEvent.click(screen.getByRole('checkbox', { name: '그래프 표시' }));
    expect(screen.queryByRole('region', { name: '시뮬레이션 그래프' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '그래프 표시' }));
    expect(
      screen.getByRole('img', { name: 'sensor_00 수신된 값 그래프. 2개 표시' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.simulation-live-status')).toHaveTextContent('2 / 43,200행');
    expect(mocks.axRequest).toHaveBeenCalledTimes(countBeforeToggle);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(batchCalls).toBe(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(batchCalls).toBe(3);
    expect(mocks.axRequest.mock.calls.at(-1)?.[0]).toContain('cursor=2&limit=60&channel=sensor_00');
    expect(batchSignals[2].aborted).toBe(false);
    unmount();
    expect(batchSignals[2].aborted).toBe(true);
  });

  it('느린 초기 목록이 도착해도 방금 업로드한 CSV 선택과 기록을 유지한다', async () => {
    let resolveList: (value: { items: SimulationManifest[] }) => void = () => {};

    mocks.axRequest.mockImplementation(
      () =>
        new Promise<{ items: SimulationManifest[] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    mount();
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('시뮬레이션 CSV 업로드'), {
      target: { files: [new File(['csv'], manifest.filename)] },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'CSV 연결' })));
    const storedCsv = screen.getByLabelText('저장한 시뮬레이션 CSV');

    expect(storedCsv).toHaveValue(manifest.id);
    await act(async () => resolveList({ items: [] }));
    expect(storedCsv).toHaveValue(manifest.id);
    expect(
      within(storedCsv).getByRole('option', { name: `${manifest.filename} · 43,200행` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeEnabled();
  });

  it('학습 목록 새로고침 실패를 숨기지 않고 화면에 표시한다', async () => {
    const app = context();

    app.refreshRuns.mockRejectedValueOnce(new Error('학습 목록 서버에 연결하지 못했어요.'));
    mocks.useApp.mockReturnValue(app);
    await mountAndChoose();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '학습 목록 새로고침' })),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('학습 목록 서버에 연결하지 못했어요.');
    expect(app.refreshRuns).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeEnabled();
  });

  it('계정을 바꾸면 진행 중 업로드를 취소하고 늦은 결과와 파일 선택을 버린다', async () => {
    let resolveUpload: (value: SimulationManifest) => void = () => {};

    mocks.uploadSimulation.mockImplementation(
      () =>
        new Promise<SimulationManifest>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const view = mount();

    await act(async () => {});
    fireEvent.change(screen.getByLabelText('시뮬레이션 CSV 업로드'), {
      target: { files: [new File(['csv'], manifest.filename)] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'CSV 연결' }));
    const requestSignal = mocks.uploadSimulation.mock.calls[0][3] as AbortSignal;

    const app = mocks.useApp();

    mocks.useApp.mockReturnValue({ ...app, user: { ...app.user, id: 2 }, selectedRunId: null });
    view.rerender(
      <MemoryRouter>
        <ExpertiseProvider>
          <SimulationPage />
        </ExpertiseProvider>
      </MemoryRouter>,
    );
    await act(async () => resolveUpload(manifest));
    expect(requestSignal.aborted).toBe(true);
    expect(screen.queryByText('2026-11-30 23:59:00')).not.toBeInTheDocument();
    expect(screen.getByText('한 달 데이터 · timestamp + 학습 채널')).toBeInTheDocument();
    expect(screen.getByLabelText('시뮬레이션 모델')).toHaveValue('');
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'CSV 연결' })).toBeDisabled();
  });

  it('수신 오류를 점검 신호 없음으로 바꾸지 않고 오류를 표시한 뒤 재생을 멈춘다', async () => {
    mocks.axRequest.mockImplementation((path: string) =>
      path === '/simulations'
        ? Promise.resolve({ items: [manifest] })
        : Promise.reject(new Error('모델 입력 채널을 확인할 수 없어요.')),
    );
    await mountAndChoose();
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('alert')).toHaveTextContent('모델 입력 채널을 확인할 수 없어요.');
    expect(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' })).toBeInTheDocument();
    const requestCount = mocks.axRequest.mock.calls.length;

    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(mocks.axRequest).toHaveBeenCalledTimes(requestCount);
  });

  it('계정을 바꾸면 재생 요청과 그래프·점검 신호·부품 입력도 함께 초기화한다', async () => {
    let resolveLateBatch: (value: SimulationBatch) => void = () => {};

    let batchCount = 0;

    mocks.axRequest.mockImplementation((path: string) => {
      if (path === '/simulations')
        return Promise.resolve({ items: mocks.useApp().user.id === 1 ? [manifest] : [] });
      batchCount += 1;
      if (batchCount === 1) return Promise.resolve(batch());
      return new Promise<SimulationBatch>((resolve) => {
        resolveLateBatch = resolve;
      });
    });
    const view = await mountAndChoose();

    fireEvent.click(screen.getByRole('checkbox', { name: '그래프 표시' }));
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('pump-scene')).toHaveAttribute('data-signal', 'true');
    fireEvent.click(screen.getByRole('button', { name: '첫 부품 선택' }));
    fireEvent.change(screen.getByLabelText('부품 기준수명'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('부품 누적 운전시간'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('시뮬레이션 부품 견적'), { target: { value: '500' } });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const batchSignal = mocks.axRequest.mock.calls.at(-1)?.[1]?.signal as AbortSignal;

    const app = mocks.useApp();

    mocks.useApp.mockReturnValue({ ...app, user: { ...app.user, id: 2 }, selectedRunId: null });
    view.rerender(
      <MemoryRouter>
        <ExpertiseProvider>
          <SimulationPage />
        </ExpertiseProvider>
      </MemoryRouter>,
    );
    await act(async () => resolveLateBatch(batch()));
    expect(batchSignal.aborted).toBe(true);
    expect(document.querySelector('.simulation-range')).not.toBeInTheDocument();
    expect(screen.getByTestId('pump-scene')).toHaveAttribute('data-signal', 'false');
    expect(screen.queryByRole('button', { name: '신호 확인함' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: '채널 수신된 값 그래프. 0개 표시' }),
    ).toBeInTheDocument();
    expect(screen.getByText('부품을 선택해 기준수명과 견적을 입력하세요.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '첫 부품 선택' }));
    expect(screen.getByLabelText('부품 기준수명')).toHaveValue(null);
    expect(screen.getByLabelText('부품 누적 운전시간')).toHaveValue(null);
    expect(screen.getByLabelText('시뮬레이션 부품 견적')).toHaveValue(null);
    expect(screen.getByLabelText('입력 기준 잔여시간')).toHaveTextContent('잔여시간 미정');
  });

  it('부품 수명 미입력을 0으로 만들지 않고 명시한 0시간·0원만 그대로 사용한다', async () => {
    await mountAndChoose();
    fireEvent.click(screen.getByRole('button', { name: '첫 부품 선택' }));
    const panel = screen.getByRole('complementary', { name: '부품 수명과 견적' });

    expect(within(panel).getByLabelText('입력 기준 잔여시간')).toHaveTextContent('잔여시간 미정');
    fireEvent.change(screen.getByLabelText('부품 기준수명'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('부품 누적 운전시간'), { target: { value: '0' } });
    expect(within(panel).getByLabelText('입력 기준 잔여시간')).toHaveTextContent(
      '입력 기준 잔여 100시간',
    );
    fireEvent.change(screen.getByLabelText('부품 누적 운전시간'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('시뮬레이션 부품 견적'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('시뮬레이션 견적 출처'), {
      target: { value: '검증용 입력' },
    });
    expect(within(panel).getByLabelText('입력 기준 잔여시간')).toHaveTextContent(
      '입력 기준 잔여 0시간',
    );
    fireEvent.click(within(panel).getByRole('button', { name: '점검 안내·보고서' }));
    await act(async () => {});
    const assistant = mocks.assistantProps.mock.calls.at(-1)?.[0];

    expect(assistant).toMatchObject({
      runId: manifest.run_id,
      modelKey: 'xgboost',
      split: 'test',
      suggestedCostInputs: { component_name: '임펠러', parts_cost: 0, quote_source: '검증용 입력' },
    });
    expect(assistant.selectedSignal).toContain('입력 기준 잔여 0시간');
    expect(assistant.selectedSignal).toContain('센서 기반 수명 예측이 아님');
  });
});
