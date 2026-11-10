import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';
import { ASSISTANT_OPEN_EVENT, SIMULATION_STATUS_EVENT } from '../lib/assistant-events';
import SimulationPage from './SimulationPage';

const mocks = vi.hoisted(() => ({ axRequest: vi.fn() }));

vi.mock('../context/AppContext', () => ({
  useApp: () => ({
    runs: [DEMO_RUN_DETAIL.run],
    datasets: [DEMO_DATASET_DETAIL.dataset],
    user: { id: 99, is_guest: true },
    mode: 'demo',
    selectedRunId: DEMO_RUN_DETAIL.run.id,
    setSelectedRunId: vi.fn(),
    refreshRuns: vi.fn(),
  }),
}));
vi.mock('../context/ExpertiseContext', () => ({ useExpertise: () => ({ isExpert: false }) }));
vi.mock('../lib/ax-api', () => ({ axRequest: mocks.axRequest }));
vi.mock('../components/PumpSimulationScene', () => ({
  default: ({
    hasSignal,
    onSelectPart,
  }: {
    hasSignal: boolean;
    onSelectPart: (id: string) => void;
  }) => (
    <div data-testid="scene" data-signal={String(hasSignal)}>
      <button onClick={() => onSelectPart('part-1')}>부품 선택</button>
    </div>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('기존 시뮬레이션의 관람객 데이터 공급원', () => {
  it('모바일은 설정을 접고 시작하며 패널을 닫아도 재생과 입력 상태를 유지한다', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    render(
      <MemoryRouter>
        <SimulationPage />
      </MemoryRouter>,
    );
    await screen.findByTestId('scene');
    expect(
      screen.queryByRole('complementary', { name: '시뮬레이션 옵션' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '재생 설정' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.getByRole('status')).toHaveTextContent('10 / 360행');
    fireEvent.click(screen.getByRole('button', { name: '재생 설정' }));
    expect(screen.getByLabelText('시뮬레이션 재생 속도')).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: '재생 설정 접기' }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('20 / 360행');
    fireEvent.click(screen.getByRole('button', { name: '부품' }));
    fireEvent.click(screen.getByRole('button', { name: '임펠러' }));
    fireEvent.change(screen.getByLabelText('시뮬레이션 부품 견적'), { target: { value: '70000' } });
    fireEvent.click(screen.getByRole('button', { name: '부품 설정 접기' }));
    fireEvent.click(screen.getByRole('button', { name: '부품' }));
    expect(screen.getByLabelText('시뮬레이션 부품 견적')).toHaveValue(70000);
    fireEvent.click(screen.getByRole('button', { name: '그래프' }));
    expect(screen.getByLabelText('시뮬레이션 그래프')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '그래프 접기' }));
    expect(screen.queryByLabelText('시뮬레이션 그래프')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시뮬레이션 일시 정지' })).toBeEnabled();
  });

  it('같은 화면에서 재생·부품 견적·포부기를 연결하고 팀 API는 호출하지 않는다', async () => {
    const opened = vi.fn();

    const statuses = vi.fn();

    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);
    window.addEventListener(SIMULATION_STATUS_EVENT, statuses);
    const view = render(
      <MemoryRouter>
        <SimulationPage />
      </MemoryRouter>,
    );

    await screen.findByTestId('scene');
    expect(screen.getByRole('heading', { name: '시뮬레이션' })).toBeInTheDocument();
    expect(screen.getByLabelText('시뮬레이션 CSV 업로드')).toBeDisabled();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '실시간 시뮬레이션 시작' }));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    for (let second = 0; second < 6; second += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByTestId('scene')).toHaveAttribute('data-signal', 'true');
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 일시 정지' }));
    fireEvent.click(screen.getByRole('button', { name: '부품 선택' }));
    fireEvent.change(screen.getByLabelText('시뮬레이션 부품 견적'), { target: { value: '50000' } });
    fireEvent.click(screen.getAllByRole('button', { name: '점검 안내·보고서' }).at(-1)!);
    expect(opened).toHaveBeenCalled();
    const detail = opened.mock.calls.at(-1)![0].detail;

    expect(detail.runId).toBeNull();
    expect(detail.selectedSignal).toContain('실제 학습 모델 추론 아님');
    expect(detail.suggestedCostInputs.parts_cost).toBe(50000);
    expect(statuses.mock.calls.some(([event]) => event.detail?.preview === true)).toBe(true);
    expect(mocks.axRequest).not.toHaveBeenCalled();
    view.unmount();
    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
    window.removeEventListener(SIMULATION_STATUS_EVENT, statuses);
  });
});
