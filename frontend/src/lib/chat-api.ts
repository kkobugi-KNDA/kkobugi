import { axRequest, type AssistantCostInput, type Citation } from './ax-api';

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SimulationChatContext {
  filename?: string | null;
  status: 'waiting' | 'playing' | 'paused' | 'completed';
  cursor: number;
  total_rows: number;
  timestamp?: string | null;
  signal_count: number;
  last_signal_time?: string | null;
}

export interface ChatRequest {
  question: string;
  history?: ChatHistoryMessage[];
  run_id?: string | null;
  model_key?: string | null;
  split?: 'validation' | 'test';
  observation?: string;
  cost_inputs?: AssistantCostInput;
  expertise: 'pro' | 'pro-plus';
  simulation_context?: SimulationChatContext | null;
}

export interface ChatReply {
  message_id: string;
  created_at: number;
  answer: string;
  source_mode: 'llm' | 'retrieval';
  citations: Citation[];
  limitations: string[];
  cost: {
    currency: string;
    total: number | null;
    known_subtotal: number;
    missing: string[];
    assumptions: string[];
  } | null;
  model_snapshot: Record<string, unknown> | null;
  report_message_id: string | null;
}

// 대화는 최근 문맥만 전송한다. 긴 대화를 자르더라도 화면의 원문은 그대로 남긴다.
export function recentChatHistory(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const selected: ChatHistoryMessage[] = [];

  let remainingCharacters = 30_000;

  for (const message of messages.slice(-20).reverse()) {
    const content = message.content.slice(0, Math.min(6000, remainingCharacters));

    if (!content) break;
    selected.unshift({ role: message.role, content });
    remainingCharacters -= content.length;
  }
  return selected;
}

export function sendChat(request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
  return axRequest<ChatReply>('/assistant/chat', {
    method: 'POST',
    body: JSON.stringify(request),
    signal,
  });
}
