import { afterEach, describe, expect, it, vi } from 'vitest';
import { recentChatHistory, sendChat, type ChatHistoryMessage } from './chat-api';

afterEach(() => vi.unstubAllGlobals());

describe('대화 API와 문맥 제한', () => {
  it('모델·비용이 없는 질문도 세션·CSRF·취소 신호로 전송한다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ answer: '안녕하세요.' }), { status: 200 }));

    const controller = new AbortController();

    vi.stubGlobal('fetch', fetcher);
    await sendChat({ question: '안녕', expertise: 'pro', history: [] }, controller.signal);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];

    const headers = new Headers(init.headers);

    expect(url).toBe('/api/v1/assistant/chat');
    expect(init.credentials).toBe('include');
    expect(init.signal).toBe(controller.signal);
    expect(headers.get('X-Requested-With')).toBe('kkobugi-web');
    expect(JSON.parse(String(init.body))).toEqual({
      question: '안녕',
      expertise: 'pro',
      history: [],
    });
  });

  it('최근 순서와 역할을 유지하며 20개·개별 6000자·합계 30000자를 넘지 않는다', () => {
    const history: ChatHistoryMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `${index}:` + '가'.repeat(7000),
    }));

    const selected = recentChatHistory(history);

    expect(selected.length).toBeLessThanOrEqual(20);
    expect(selected.every((message) => message.content.length <= 6000)).toBe(true);
    expect(
      selected.reduce((total, message) => total + message.content.length, 0),
    ).toBeLessThanOrEqual(30000);
    expect(selected.at(-1)?.content).toMatch(/^29:/);
    expect(selected.map((message) => Number(message.content.split(':')[0]))).toEqual([
      25, 26, 27, 28, 29,
    ]);
    expect(history[29].content.length).toBeGreaterThan(6000);
  });

  it('짧은 대화는 그대로 보내고 원본 배열은 바꾸지 않는다', () => {
    const history: ChatHistoryMessage[] = [
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답변' },
    ];

    expect(recentChatHistory(history)).toEqual(history);
    expect(recentChatHistory([])).toEqual([]);
  });
});
