import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertiseProvider } from '../context/ExpertiseContext';
import type { AssistantReply, ReportJob } from '../lib/ax-api';
import AxAssistantPanel from './AxAssistantPanel';

const mocks = vi.hoisted(() => ({ useApp: vi.fn() }));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));

const reply: AssistantReply = {
  message_id: 'a'.repeat(32),
  created_at: 1,
  source_mode: 'retrieval',
  answer: '모델 신호와 누수 관찰을 확인했습니다. 축봉 상태를 점검하세요.',
  model_snapshot: { run_id: 'r'.repeat(32), model_key: 'xgboost', split: 'test' },
  citations: [
    {
      id: 'doe',
      title: '펌프 점검 근거',
      url: 'https://example.com/source',
      pages: '10',
      summary: '점검 항목',
    },
  ],
  cost: {
    currency: 'KRW',
    total: null,
    known_subtotal: 30000,
    missing: ['부품 견적'],
    assumptions: [],
  },
  suggested_checks: ['축봉 형식과 누수 위치 확인'],
  limitations: ['센서와 부품 대응 미확인'],
};

const queued: ReportJob = { id: 'b'.repeat(32), status: 'queued', title: '점검 보고서' };

const complete: ReportJob = {
  ...queued,
  status: 'completed',
  preview: {
    title: '펌프 점검 보고서',
    sections: [{ heading: '확인한 근거', paragraphs: ['모델 Test 결과와 현장 누수 관찰.'] }],
    citations: reply.citations,
  },
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.useApp.mockReturnValue({
    mode: 'live',
    user: { id: 1, username: 'worker', display_name: '작업자' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function panel(contextKey = 'replay1:sensor_04') {
  return (
    <ExpertiseProvider>
      <AxAssistantPanel
        runId={'r'.repeat(32)}
        modelKey="xgboost"
        split="test"
        selectedSignal="2026-11-09 00:00:01 / sensor_04 / 값18 / 합성 재생 후보"
        contextKey={contextKey}
      />
    </ExpertiseProvider>
  );
}

describe('실제 모델 문맥을 연결한 안내·보고서', () => {
  it('모델과 관찰로 안내를 요청한 뒤 보고서를 자동 작성하고 완료 상태에서 미리보기를 연다', async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);

      if (path.endsWith('/assistant/messages')) return Promise.resolve(json(reply));
      if (path.endsWith('/reports') && init?.method === 'POST')
        return Promise.resolve(json(queued));
      if (path.endsWith(`/reports/${queued.id}`)) return Promise.resolve(json(complete));
      if (path.includes('/file?') || path.endsWith('/pdf'))
        return Promise.resolve(json({ error: { message: '파일 오류' } }, 500));
      throw new Error(`예상하지 않은 API ${path}`);
    });

    vi.stubGlobal('fetch', fetcher);
    render(panel());
    fireEvent.change(screen.getByLabelText('직접 확인한 내용'), {
      target: { value: '축봉 주변에 물방울이 보입니다.' },
    });
    fireEvent.click(screen.getByRole('button', { name: '안내·보고서 작성' }));
    await act(async () => {});
    expect(screen.getByText(reply.answer)).toBeInTheDocument();
    const assistantCall = fetcher.mock.calls.find(([input]) =>
      String(input).endsWith('/assistant/messages'),
    )!;

    expect(JSON.parse(String(assistantCall[1]?.body))).toMatchObject({
      run_id: 'r'.repeat(32),
      model_key: 'xgboost',
      split: 'test',
      expertise: 'pro',
      observation: '축봉 주변에 물방울이 보입니다.',
    });
    expect(JSON.parse(String(assistantCall[1]?.body)).question).toContain('합성 재생 후보');
    const reportCall = fetcher.mock.calls.find(
      ([input, init]) => String(input).endsWith('/reports') && init?.method === 'POST',
    )!;

    expect(JSON.parse(String(reportCall[1]?.body))).toEqual({ message_id: reply.message_id });
    expect(screen.getByRole('button', { name: '보고서 작성 중' })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: '보고서 작성 완료' }));
    const modal = screen.getByRole('dialog', { name: '점검 보고서 미리보기' });

    expect(within(modal).getByText('모델 Test 결과와 현장 누수 관찰.')).toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: 'Word 다운로드' })).toBeEnabled();
    expect(within(modal).getByRole('button', { name: 'PDF 다운로드' })).toBeEnabled();
    expect(within(modal).getByRole('link', { name: '펌프 점검 근거' })).toHaveAttribute(
      'href',
      'https://example.com/source',
    );
  });

  it('AI 요청 실패를 완료로 표시하지 않고 보고서를 만들지 않는다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(json({ error: { message: '모델 결과를 확인하지 못했어요.' } }, 422));

    vi.stubGlobal('fetch', fetcher);
    render(panel());
    fireEvent.click(screen.getByRole('button', { name: '안내·보고서 작성' }));
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('모델 결과를 확인하지 못했어요.');
    expect(screen.getByRole('button', { name: '보고서 대기' })).toBeDisabled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('다른 재생 문맥으로 이동하면 이전 안내 요청을 취소하고 늦게 도착한 답변을 버린다', async () => {
    let resolveReply: (response: Response) => void = () => {};

    const pending = { signal: null as AbortSignal | null };

    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      pending.signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        resolveReply = resolve;
      });
    });

    vi.stubGlobal('fetch', fetcher);
    const view = render(panel());

    fireEvent.click(screen.getByRole('button', { name: '안내·보고서 작성' }));
    view.rerender(panel('replay2:sensor_04'));
    expect(pending.signal?.aborted).toBe(true);
    await act(async () => {
      resolveReply(json(reply));
    });
    expect(screen.queryByText(reply.answer)).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '보고서 대기' })).toBeDisabled();
  });
});
