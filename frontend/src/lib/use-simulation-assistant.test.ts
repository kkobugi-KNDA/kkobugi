import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishSimulationStatus, type SimulationAssistantStatus } from './assistant-events';
import { SIMULATION_CHECK_INTERVAL_MS, useSimulationAssistant } from './use-simulation-assistant';

const status: SimulationAssistantStatus = {
  ownerId: 1,
  simulationContext: {
    status: 'playing',
    filename: 'month.csv',
    cursor: 100,
    total_rows: 43200,
    signal_count: 2,
    timestamp: '2026-11-01T01:39:00',
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  publishSimulationStatus(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  publishSimulationStatus(null);
});

describe('시뮬레이션에서만 10분마다 상태를 확인하는 포석호', () => {
  it('10분 전에는 알리지 않고 최신 수신 상태로 말풍선을 만든다', () => {
    publishSimulationStatus(status);
    const { result } = renderHook(() => useSimulationAssistant(true, 1));

    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS - 1));
    expect(result.current.notice).toBe('');
    act(() =>
      publishSimulationStatus({
        ...status,
        simulationContext: { ...status.simulationContext, cursor: 1200, signal_count: 3 },
      }),
    );
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.notice).toContain('1,200 / 43,200행');
    expect(result.current.notice).toContain('3행');
    expect(result.current.notice).not.toContain('고장 확정이에요');
  });

  it('페이지를 떠나면 타이머와 안내를 지우고 다시 들어오면 새로 10분을 센다', () => {
    const { result, rerender } = renderHook(({ active }) => useSimulationAssistant(active, 1), {
      initialProps: { active: true },
    });

    act(() => publishSimulationStatus(status));
    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS));
    expect(result.current.notice).not.toBe('');
    rerender({ active: false });
    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS * 3));
    expect(result.current.notice).toBe('');
    expect(result.current.latestStatus.current).toBeNull();
    rerender({ active: true });
    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS - 1));
    expect(result.current.notice).toBe('');
  });

  it('다른 계정의 상태와 숨겨진 브라우저의 자동 안내를 사용하지 않는다', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    const { result, rerender } = renderHook(({ owner }) => useSimulationAssistant(true, owner), {
      initialProps: { owner: 1 },
    });

    act(() => publishSimulationStatus(status));
    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS));
    expect(result.current.notice).toBe('');
    rerender({ owner: 2 });
    hidden.mockReturnValue(false);
    act(() => publishSimulationStatus(status));
    act(() => vi.advanceTimersByTime(SIMULATION_CHECK_INTERVAL_MS));
    expect(result.current.latestStatus.current).toBeNull();
    expect(result.current.notice).not.toContain('1:39');
    expect(result.current.notice).toContain('아직 수신한 값은 없어요');
  });
});
