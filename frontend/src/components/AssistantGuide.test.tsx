import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AssistantGuide from './AssistantGuide';
import { ASSISTANT_OPEN_EVENT } from '../lib/assistant-events';

describe('포석호 공용 안내', () => {
  it('gives a guide without model context its own draft identity', () => {
    const opened = vi.fn();

    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);
    render(
      <AssistantGuide
        id="upload-help"
        title="CSV를 확인해요"
        message="시각과 채널을 확인하세요."
        question="CSV를 어떻게 확인할까?"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '포석호에게 물어보기' }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      contextKey: 'guide:upload-help',
      initialQuestion: 'CSV를 어떻게 확인할까?',
    });
    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
  });

  it('keeps details optional and opens a prepared question without submitting it', () => {
    const opened = vi.fn();

    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);
    render(
      <AssistantGuide
        id="label-warning"
        title="평가 구간의 라벨을 확인해요"
        message="이상 기록이 없는 구간이에요."
        details={['시간 순서와 이상 발생 시각을 확인하세요.']}
        context={{ runId: 'run-a', modelKey: 'xgboost', contextKey: 'training:run-a' }}
        question="이 평가 결과를 설명해줘"
      />,
    );
    expect(
      screen.getByRole('complementary', { name: '평가 구간의 라벨을 확인해요' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.assistant-guide-pet-slot')).toBeInTheDocument();
    expect(document.querySelector('.assistant-pet')).not.toBeInTheDocument();
    expect(opened).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '포석호에게 물어보기' }));
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      runId: 'run-a',
      modelKey: 'xgboost',
      contextKey: 'training:run-a',
      initialQuestion: '이 평가 결과를 설명해줘',
    });
    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
  });
});
