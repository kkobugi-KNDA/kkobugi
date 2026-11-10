import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExpertiseProvider } from '../context/ExpertiseContext';
import type { ReportJob } from '../lib/ax-api';
import type { ChatReply, ChatRequest, SimulationChatContext } from '../lib/chat-api';
import ChatConversation, { type ChatConversationProps } from './ChatConversation';

const mocks = vi.hoisted(() => ({ useApp: vi.fn(), sendChat: vi.fn(), axRequest: vi.fn() }));

vi.mock('../context/AppContext', () => ({ useApp: mocks.useApp }));
vi.mock('../lib/chat-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/chat-api')>()),
  sendChat: mocks.sendChat,
}));
vi.mock('../lib/ax-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/ax-api')>()),
  axRequest: mocks.axRequest,
}));

function reply(
  id = 'message-one',
  answer = '현재 자료에서 확인할 수 있는 점검 순서를 안내할게요.',
): ChatReply {
  return {
    message_id: id,
    created_at: 1,
    answer,
    source_mode: 'retrieval',
    citations: [
      {
        id: 'DOE-DATA-SCOPE',
        title: '펌프 점검 근거',
        url: 'https://example.com/pump',
        pages: '40',
        summary: '자료의 범위',
      },
    ],
    limitations: ['익명 채널로 고장 부위를 확정하지 않아요.'],
    cost: null,
    model_snapshot: null,
    report_message_id: null,
  };
}

function chat(props: ChatConversationProps = {}) {
  return (
    <ExpertiseProvider>
      <ChatConversation {...props} />
    </ExpertiseProvider>
  );
}

async function send(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '포석호에게 질문' }), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: '메시지 보내기' }));
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.useApp.mockReturnValue({
    mode: 'live',
    user: { id: 1, username: 'worker', display_name: '작업자' },
  });
  mocks.sendChat.mockReset().mockResolvedValue(reply());
  mocks.axRequest.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('포석호의 대화형 점검 도우미', () => {
  it('게스트는 실제 대화 API를 사용하되 팀 데이터 식별자와 보고서는 연결하지 않는다', async () => {
    mocks.useApp.mockReturnValue({
      mode: 'demo',
      user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
    });
    mocks.sendChat.mockResolvedValue({
      ...reply('guest-answer', '안녕하세요. 사용 방법을 알려드릴게요.'),
      source_mode: 'llm',
    });
    render(
      chat({
        datasetId: 'team-csv',
        runId: 'team-run',
        modelKey: 'xgboost',
        selectedSignal: '팀 비공개 문맥',
        simulationContext: {
          filename: 'example.csv',
          status: 'playing',
          cursor: 10,
          total_rows: 100,
          signal_count: 2,
        },
      }),
    );
    expect(screen.getByLabelText('포석호가 참조하는 데이터')).toHaveTextContent(
      '관람용 예시 화면 · 팀 데이터 연결 없음',
    );
    await send('무엇을 할 수 있어?');

    const sent = mocks.sendChat.mock.calls[0][0] as ChatRequest;

    expect(sent.question).toBe('무엇을 할 수 있어?');
    expect(sent).not.toHaveProperty('dataset_id');
    expect(sent).not.toHaveProperty('run_id');
    expect(sent).not.toHaveProperty('model_key');
    expect(sent.simulation_context).toMatchObject({
      filename: 'example.csv',
      cursor: 10,
      signal_count: 2,
    });
    expect(sent.observation).toContain('관람용 예시 화면');
    expect(sent.observation).not.toContain('팀 비공개 문맥');
    expect(screen.getByText('안녕하세요. 사용 방법을 알려드릴게요.')).toBeInTheDocument();
    expect(mocks.axRequest).not.toHaveBeenCalled();
  });

  it('새 CSV로 바꾸면 이전 답변과 진행 중 요청을 분리하고 새 ID만 전송한다', async () => {
    const view = render(chat({ datasetId: 'old-csv', datasetName: 'old.csv' }));

    await send('기존 CSV 확인해줘');
    expect(mocks.sendChat.mock.calls[0][0]).toHaveProperty('dataset_id', 'old-csv');
    view.rerender(chat({ datasetId: 'new-csv', datasetName: 'cal01_base_v7.csv' }));
    expect(screen.queryByText('기존 CSV 확인해줘')).not.toBeInTheDocument();
    expect(screen.getByLabelText('포석호가 참조하는 데이터')).toHaveTextContent(
      'cal01_base_v7.csv',
    );
    await send('새로 올린 파일 확인해줘');
    expect(mocks.sendChat.mock.calls[1][0]).toMatchObject({ dataset_id: 'new-csv', history: [] });
    expect(mocks.sendChat.mock.calls[1][0]).not.toHaveProperty('run_id');
  });

  it('CSV 변경 뒤 늦게 도착한 이전 파일 답변을 표시하지 않는다', async () => {
    let resolveOld: (value: ChatReply) => void = () => {};

    mocks.sendChat.mockReturnValueOnce(
      new Promise<ChatReply>((resolve) => {
        resolveOld = resolve;
      }),
    );
    const view = render(chat({ datasetId: 'old-csv' }));

    await send('확인해줘');
    const signal = mocks.sendChat.mock.calls[0][1] as AbortSignal;

    view.rerender(chat({ datasetId: 'new-csv' }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveOld(reply('late', '이전 CSV 답변'));
    });
    expect(screen.queryByText('이전 CSV 답변')).not.toBeInTheDocument();
  });

  it('모델과 견적을 전혀 입력하지 않아도 질문만으로 대화한다', async () => {
    render(chat());
    const button = screen.getByRole('button', { name: '메시지 보내기' });

    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '포석호에게 질문' }), {
      target: { value: '시뮬레이션은 어떻게 시작해?' },
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await act(async () => {});
    const request = mocks.sendChat.mock.calls[0][0] as ChatRequest;

    expect(request).toMatchObject({
      question: '시뮬레이션은 어떻게 시작해?',
      history: [],
      expertise: 'pro',
    });
    expect(request).not.toHaveProperty('cost_inputs');
    expect(request).not.toHaveProperty('run_id');
    expect(request).not.toHaveProperty('model_key');
    expect(screen.getByRole('log', { name: '포석호와 대화' })).toHaveTextContent(reply().answer);
    expect(screen.getByText('문헌 검색 안내 · 외부 AI 응답 없음')).toBeInTheDocument();
    expect(mocks.axRequest).not.toHaveBeenCalled();
  });

  it('다음 질문에 앞선 사용자·도우미 대화를 순서대로 보낸다', async () => {
    mocks.sendChat
      .mockResolvedValueOnce(reply('one', '먼저 누수 위치를 확인해요.'))
      .mockResolvedValueOnce(reply('two', '사진과 정비 이력을 함께 남겨주세요.'));
    render(chat());
    await send('물이 조금 보여.');
    await send('그러면 어떤 기록을 남겨?');
    expect(mocks.sendChat.mock.calls[1][0]).toMatchObject({
      question: '그러면 어떤 기록을 남겨?',
      history: [
        { role: 'user', content: '물이 조금 보여.' },
        { role: 'assistant', content: '먼저 누수 위치를 확인해요.' },
      ],
    });
    expect(screen.getAllByRole('article', { name: '내 질문' })).toHaveLength(2);
    expect(screen.getAllByRole('article', { name: '포석호 답변' })).toHaveLength(2);
  });

  it('Enter는 전송하고 Shift+Enter와 한글 조합 중 Enter는 전송하지 않는다', async () => {
    render(chat());
    const input = screen.getByRole('textbox', { name: '포석호에게 질문' });

    fireEvent.change(input, { target: { value: '어떤 점검부터 할까?' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(mocks.sendChat).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => {});
    expect(mocks.sendChat).toHaveBeenCalledOnce();
  });

  it('실패한 질문과 이전 답변을 유지하고 다시 전송해도 대화를 중복하지 않는다', async () => {
    mocks.sendChat
      .mockResolvedValueOnce(reply('one', '첫 번째 안내'))
      .mockRejectedValueOnce(new Error('연결을 확인해주세요.'))
      .mockResolvedValueOnce(reply('two', '다시 받은 안내'));
    render(chat());
    await send('첫 질문');
    await send('두 번째 질문');
    expect(screen.getByRole('alert')).toHaveTextContent('연결을 확인해주세요.');
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue('두 번째 질문');
    expect(screen.getByText('첫 번째 안내')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '메시지 보내기' }));
    await act(async () => {});
    expect(screen.getAllByRole('article', { name: '내 질문' })).toHaveLength(2);
    expect(screen.getByText('다시 받은 안내')).toBeInTheDocument();
  });

  it('계정 전환은 진행 중 요청을 취소하고 이전 계정의 늦은 답변을 표시하지 않는다', async () => {
    let resolveReply: (value: ChatReply) => void = () => {};

    mocks.sendChat.mockReturnValueOnce(
      new Promise<ChatReply>((resolve) => {
        resolveReply = resolve;
      }),
    );
    const view = render(chat());

    await send('이전 계정의 질문');
    const signal = mocks.sendChat.mock.calls[0][1] as AbortSignal;

    mocks.useApp.mockReturnValue({ mode: 'live', user: { id: 2, username: 'other' } });
    view.rerender(chat());
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveReply(reply('old', '이전 계정의 비공개 답변'));
    });
    expect(screen.queryByText('이전 계정의 비공개 답변')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue('');
  });

  it('창을 다시 그려도 같은 계정·문맥의 대화는 남는다', async () => {
    const view = render(chat({ contextKey: 'same' }));

    await send('지금 확인해줘');
    view.rerender(chat({ contextKey: 'same' }));
    expect(screen.getByText('지금 확인해줘')).toBeInTheDocument();
    expect(screen.getByText(reply().answer)).toBeInTheDocument();
  });

  it('경고에서 넘어온 질문은 초안에만 채우고 사용자가 보내기 전에는 전송하지 않는다', async () => {
    render(
      chat({
        contextKey: 'training:dataset-a:validation-warning',
        initialQuestion: '  중간 확인 구간에 비정상이 없다는 뜻이 뭐야?  ',
      }),
    );
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue(
      '중간 확인 구간에 비정상이 없다는 뜻이 뭐야?',
    );
    expect(mocks.sendChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '메시지 보내기' }));
    await act(async () => {});
    expect(mocks.sendChat.mock.calls[0][0].question).toBe(
      '중간 확인 구간에 비정상이 없다는 뜻이 뭐야?',
    );
  });

  it('같은 경고 문맥을 다시 열어도 이전 대화와 사용자가 고친 초안을 유지한다', async () => {
    const view = render(chat({ contextKey: 'training:same', initialQuestion: '처음 추천 질문' }));

    await send('이 경고를 확인하고 있어.');
    fireEvent.change(screen.getByRole('textbox', { name: '포석호에게 질문' }), {
      target: { value: '내가 직접 작성 중인 다음 질문' },
    });
    view.rerender(chat({ contextKey: 'training:same', initialQuestion: '다시 전달된 추천 질문' }));
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue(
      '내가 직접 작성 중인 다음 질문',
    );
    expect(screen.getByText('이 경고를 확인하고 있어.')).toBeInTheDocument();
    expect(screen.getByText(reply().answer)).toBeInTheDocument();
    expect(mocks.sendChat).toHaveBeenCalledOnce();
  });

  it('새 경고 문맥으로 바뀌면 기존 격리를 유지하며 새 질문만 초안에 채운다', async () => {
    const view = render(chat({ contextKey: 'training:first', initialQuestion: '첫 경고 질문' }));

    await send('첫 문맥의 질문');
    view.rerender(chat({ contextKey: 'training:second', initialQuestion: '새 경고 질문' }));
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue('새 경고 질문');
    expect(screen.queryByText('첫 문맥의 질문')).not.toBeInTheDocument();
    expect(screen.queryByText(reply().answer)).not.toBeInTheDocument();
    expect(mocks.sendChat).toHaveBeenCalledOnce();
  });

  it('다른 계정으로 바뀌면 이전 계정의 추천 질문도 남기지 않는다', () => {
    const props = { contextKey: 'training:same', initialQuestion: '이전 계정의 경고 내용' };

    const view = render(chat(props));

    mocks.useApp.mockReturnValue({ mode: 'live', user: { id: 2, username: 'other' } });
    view.rerender(chat(props));
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue('');
    expect(mocks.sendChat).not.toHaveBeenCalled();
  });

  it('빈 견적은 보내지 않고 사용자가 명시한 0원은 그대로 보낸다', async () => {
    render(chat());
    fireEvent.click(screen.getByText('현장 관찰·견적 / 비용 조건 입력'));
    fireEvent.change(screen.getByRole('spinbutton', { name: '채팅 부품 견적 (원)' }), {
      target: { value: '0' },
    });
    await send('이 조건으로 정리해줘.');
    expect(mocks.sendChat.mock.calls[0][0]).toMatchObject({ cost_inputs: { parts_cost: 0 } });
    expect(mocks.sendChat.mock.calls[0][0].cost_inputs).not.toHaveProperty('inspection_cost');
  });

  it('열린 창에서도 전송할 때 최신 시뮬레이션 상태를 읽는다', async () => {
    let status: SimulationChatContext = {
      status: 'playing',
      cursor: 10,
      total_rows: 43200,
      signal_count: 0,
    };

    render(chat({ simulationContext: status, getSimulationContext: () => status }));
    status = { ...status, cursor: 600, signal_count: 7, timestamp: '2026-11-01T09:59:00' };
    await send('지금 상태는?');
    expect(mocks.sendChat.mock.calls[0][0].simulation_context).toEqual(status);
  });

  it('부품·수명 문맥을 질문 길이와 분리하고 받은 견적만 선택적으로 보낸다', async () => {
    render(
      chat({
        selectedSignal: '사용자 입력 기준 잔여 2800시간 · 센서 수명 추정 아님',
        suggestedCostInputs: {
          component_name: '임펠러',
          parts_cost: 100000,
          quote_source: '검증용 가정',
        },
      }),
    );
    await send('점검 방법을 알려줘.');
    expect(mocks.sendChat.mock.calls[0][0]).toMatchObject({
      question: '점검 방법을 알려줘.',
      observation: '현재 확인할 문맥: 사용자 입력 기준 잔여 2800시간 · 센서 수명 추정 아님',
      cost_inputs: { component_name: '임펠러', parts_cost: 100000, quote_source: '검증용 가정' },
    });
  });

  it('모델 문맥의 답변만 보고서를 만들고 완료 뒤 미리보기를 연다', async () => {
    mocks.sendChat.mockResolvedValue({ ...reply(), report_message_id: 'r'.repeat(32) });
    const completed: ReportJob = {
      id: 'report-one',
      status: 'completed',
      title: '검토 보고서',
      preview: {
        title: '검토 보고서',
        sections: [{ heading: '확인한 내용', paragraphs: ['저장한 모델과 현장 관찰'] }],
        citations: [],
      },
    };

    mocks.axRequest
      .mockResolvedValueOnce({ id: completed.id, status: 'queued', title: completed.title })
      .mockResolvedValueOnce(completed);
    render(chat({ runId: 'a'.repeat(32), modelKey: 'xgboost', split: 'test' }));
    await send('보고서로 남겨줘.');
    expect(mocks.axRequest.mock.calls[0][0]).toBe('/reports');
    expect(JSON.parse(mocks.axRequest.mock.calls[0][1].body)).toEqual({
      message_id: 'r'.repeat(32),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    fireEvent.click(screen.getByRole('button', { name: '보고서 작성 완료' }));
    const dialog = screen.getByRole('dialog', { name: '점검 보고서 미리보기' });

    expect(within(dialog).getByText('저장한 모델과 현장 관찰')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'PDF 다운로드' })).toBeEnabled();
  });

  it('다음 질문을 전송해도 앞선 답변의 보고서 생성 요청을 취소하지 않는다', async () => {
    mocks.sendChat
      .mockResolvedValueOnce({ ...reply('one'), report_message_id: 'r'.repeat(32) })
      .mockResolvedValueOnce(reply('two', '다음 질문 안내'));
    let resolveReport: (value: ReportJob) => void = () => {};

    mocks.axRequest.mockReturnValueOnce(
      new Promise<ReportJob>((resolve) => {
        resolveReport = resolve;
      }),
    );
    render(chat({ runId: 'a'.repeat(32), modelKey: 'xgboost' }));
    await send('보고서 부탁해.');
    const reportSignal = mocks.axRequest.mock.calls[0][1].signal as AbortSignal;

    await send('그다음은?');
    expect(reportSignal.aborted).toBe(false);
    await act(async () => {
      resolveReport({ id: 'done', status: 'completed', title: '보고서' });
    });
    expect(screen.getByRole('button', { name: '보고서 작성 완료' })).toBeEnabled();
  });
});
