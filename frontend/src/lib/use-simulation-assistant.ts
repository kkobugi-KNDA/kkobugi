import { useEffect, useRef, useState } from 'react';
import {
  readSimulationStatus,
  SIMULATION_STATUS_EVENT,
  type SimulationAssistantStatus,
} from './assistant-events';

export const SIMULATION_CHECK_INTERVAL_MS = 10 * 60 * 1000;

export function simulationStatusMessage(status: SimulationAssistantStatus | null): string {
  if (!status || !status.simulationContext.total_rows)
    return '시뮬레이션 CSV와 학습된 모델을 연결해주세요. 아직 수신한 값은 없어요.';
  const context = status.simulationContext;

  const stateName = {
    waiting: '수신 대기',
    playing: '수신 중',
    paused: '일시 정지',
    completed: '재생 완료',
  }[context.status];

  const received = `${context.cursor.toLocaleString()} / ${context.total_rows.toLocaleString()}행`;

  if (status.error) return `${stateName} · ${received}. 오류를 확인해주세요: ${status.error}`;
  const signals =
    context.cursor === 0
      ? status.preview
        ? '아직 재생한 예시 값은 없어요.'
        : '아직 모델이 확인한 값은 없어요.'
      : status.preview
        ? `예시 점검 표시는 ${context.signal_count.toLocaleString()}행이에요. 실제 모델의 예측 결과는 아니에요.`
        : `모델의 점검 신호는 ${context.signal_count.toLocaleString()}행이에요. 고장 확정은 아니에요.`;

  return `${stateName} · ${received}. ${context.timestamp ? `마지막 수신 ${context.timestamp.replace('T', ' ')}. ` : ''}${signals}`;
}

/** 화면을 떠나면 타이머와 상태 참조를 모두 버린다. 외부 AI를 주기적으로 호출하지 않는다. */
export function useSimulationAssistant(active: boolean, ownerId: number | undefined) {
  const latestStatus = useRef<SimulationAssistantStatus | null>(null);

  const [notice, setNotice] = useState('');

  useEffect(() => {
    setNotice('');
    latestStatus.current = null;
    if (!active || ownerId === undefined) return;
    const accept = (status: SimulationAssistantStatus | null) => {
      latestStatus.current = status?.ownerId === ownerId ? status : null;
    };

    const receive = (event: Event) =>
      accept((event as CustomEvent<SimulationAssistantStatus | null>).detail);

    accept(readSimulationStatus());
    window.addEventListener(SIMULATION_STATUS_EVENT, receive);
    const timer = setInterval(() => {
      if (!document.hidden) setNotice(simulationStatusMessage(latestStatus.current));
    }, SIMULATION_CHECK_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener(SIMULATION_STATUS_EVENT, receive);
      latestStatus.current = null;
    };
  }, [active, ownerId]);

  return { latestStatus, notice, dismissNotice: () => setNotice('') };
}
