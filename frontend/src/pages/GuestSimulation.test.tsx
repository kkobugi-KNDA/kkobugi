import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GuestSimulation from './GuestSimulation';

vi.mock('../components/PumpSimulationScene', () => ({
  default: ({ hasSignal }: { hasSignal: boolean }) => (
    <div data-testid="guest-scene">{hasSignal ? 'red' : 'normal'}</div>
  ),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('관람객 브라우저 시뮬레이션', () => {
  it('팀 API 없이 재생하고 이상을 표시하며 정지·리셋·그래프 숨김을 제공한다', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch');

    const view = render(<GuestSimulation />);

    await screen.findByTestId('guest-scene');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 시작' }));
    act(() => vi.advanceTimersByTime(6500));
    expect(screen.getByTestId('guest-scene')).toHaveTextContent('red');
    expect(screen.getByRole('status')).toHaveTextContent('65 / 360행');
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 일시 정지' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole('status')).toHaveTextContent('65 / 360행');
    fireEvent.click(screen.getByLabelText('그래프 표시'));
    expect(screen.queryByLabelText('시뮬레이션 그래프')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '시뮬레이션 처음부터' }));
    expect(screen.getByRole('status')).toHaveTextContent('0 / 360행');
    expect(screen.getByTestId('guest-scene')).toHaveTextContent('normal');
    expect(fetchSpy).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
