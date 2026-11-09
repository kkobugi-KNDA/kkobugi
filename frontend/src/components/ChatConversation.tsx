import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, FileText, LoaderCircle, Send, Settings2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useExpertise } from '../context/ExpertiseContext';
import { errorMessage } from '../lib/api';
import { axRequest, type AssistantCostInput, type ReportJob } from '../lib/ax-api';
import {
  recentChatHistory,
  sendChat,
  type ChatHistoryMessage,
  type ChatReply,
  type SimulationChatContext,
} from '../lib/chat-api';
import { ReportPreview } from './AxAssistantPanel';
import './chat-conversation.css';

export interface ChatConversationProps {
  runId?: string | null;
  modelKey?: string | null;
  split?: 'validation' | 'test';
  simulationContext?: SimulationChatContext | null;
  getSimulationContext?: () => SimulationChatContext | null;
  selectedSignal?: string;
  suggestedCostInputs?: AssistantCostInput;
  contextKey?: string;
  initialQuestion?: string;
}

interface ChatEntry extends ChatHistoryMessage {
  id: string;
  reply?: ChatReply;
  report?: ReportJob;
  reportError?: string;
  reportPending?: boolean;
}

const costFields: { key: keyof AssistantCostInput; label: string }[] = [
  { key: 'parts_cost', label: '부품 견적 (원)' },
  { key: 'inspection_cost', label: '점검비 (원)' },
  { key: 'labor_hours', label: '작업 시간' },
  { key: 'labor_hourly_rate', label: '시간당 작업비 (원)' },
  { key: 'downtime_hours', label: '생산 정지 시간' },
  { key: 'downtime_loss_per_hour', label: '시간당 정지 손실 (원)' },
];

export default function ChatConversation({
  runId = null,
  modelKey = null,
  split = 'validation',
  simulationContext = null,
  getSimulationContext,
  selectedSignal = '',
  suggestedCostInputs,
  contextKey = '',
  initialQuestion = '',
}: ChatConversationProps) {
  const { user, mode } = useApp();

  const { expertise } = useExpertise();

  const [messages, setMessages] = useState<ChatEntry[]>([]);

  const [question, setQuestion] = useState('');

  const [pendingQuestion, setPendingQuestion] = useState('');

  const [observation, setObservation] = useState('');

  const [costInputs, setCostInputs] = useState<Record<string, string>>({});

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState('');

  const [previewReport, setPreviewReport] = useState<ReportJob | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);

  const requestController = useRef<AbortController | null>(null);

  const generation = useRef(0);

  const reportControllers = useRef(new Set<AbortController>());

  const sequence = useRef(0);

  const transcriptRef = useRef<HTMLDivElement>(null);

  const accountContext = useRef({ userId: user?.id, mode });

  const suggestedCostsKey = JSON.stringify(suggestedCostInputs || {});

  // 창을 닫는 동작은 대화를 지우지 않는다. 계정이나 실제 근거가 바뀔 때만 정리한다.
  useEffect(() => {
    const accountChanged =
      accountContext.current.userId !== user?.id || accountContext.current.mode !== mode;

    accountContext.current = { userId: user?.id, mode };
    generation.current += 1;
    requestController.current?.abort();
    for (const controller of reportControllers.current) controller.abort();
    reportControllers.current.clear();
    setMessages([]);
    // 새 문맥의 추천 질문은 초안일 뿐이다. 사용자가 전송하기 전에는 API를 호출하지 않는다.
    // 계정 전환 시에는 이전 화면의 추천 질문도 가져오지 않는다.
    setQuestion(accountChanged ? '' : initialQuestion.trim().slice(0, 3000));
    setPendingQuestion('');
    setObservation('');
    setCostInputs({});
    setBusy(false);
    setError('');
    setPreviewOpen(false);
    setPreviewReport(null);
    return () => {
      requestController.current?.abort();
      for (const controller of reportControllers.current) controller.abort();
      reportControllers.current.clear();
    };
    // 추천 질문만 바뀌거나 같은 문맥을 다시 열 때 작성 중인 질문과 대화를 덮어쓰지 않는다.
  }, [user?.id, mode, runId, modelKey, split, contextKey]);

  useEffect(() => {
    const suggested = JSON.parse(suggestedCostsKey) as AssistantCostInput;

    setCostInputs(
      Object.fromEntries(
        Object.entries(suggested).map(([key, value]) => [
          key,
          typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value),
        ]),
      ),
    );
  }, [suggestedCostsKey, user?.id, mode, runId, modelKey, split, contextKey]);

  useEffect(() => {
    const transcript = transcriptRef.current;

    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'auto' });
  }, [messages.length, busy]);

  // 보고서 작성은 대화 전송과 별개다. 실패해도 이미 받은 답변과 다음 질문은 유지한다.
  useEffect(() => {
    const pending = messages.filter(
      (entry) => entry.report && ['queued', 'generating'].includes(entry.report.status),
    );

    if (!pending.length) return;
    const controller = new AbortController();

    const currentGeneration = generation.current;

    const timer = setTimeout(async () => {
      await Promise.all(
        pending.map(async (entry) => {
          try {
            const report = await axRequest<ReportJob>(`/reports/${entry.report!.id}`, {
              signal: controller.signal,
            });

            if (controller.signal.aborted || generation.current !== currentGeneration) return;
            setMessages((previous) =>
              previous.map((item) =>
                item.id === entry.id ? { ...item, report, reportError: '' } : item,
              ),
            );
          } catch (failure) {
            if (controller.signal.aborted || generation.current !== currentGeneration) return;
            setMessages((previous) =>
              previous.map((item) =>
                item.id === entry.id
                  ? {
                      ...item,
                      reportError: errorMessage(failure),
                      report: { ...item.report!, status: 'failed' },
                    }
                  : item,
              ),
            );
          }
        }),
      );
    }, 1000);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [messages]);

  async function createReport(entryId: string, messageId: string, currentGeneration: number) {
    const controller = new AbortController();

    reportControllers.current.add(controller);
    setMessages((previous) =>
      previous.map((item) =>
        item.id === entryId ? { ...item, reportPending: true, reportError: '' } : item,
      ),
    );
    try {
      const report = await axRequest<ReportJob>('/reports', {
        method: 'POST',
        body: JSON.stringify({ message_id: messageId }),
        signal: controller.signal,
      });

      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setMessages((previous) =>
        previous.map((item) =>
          item.id === entryId ? { ...item, report, reportPending: false, reportError: '' } : item,
        ),
      );
    } catch (failure) {
      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      setMessages((previous) =>
        previous.map((item) =>
          item.id === entryId
            ? { ...item, reportPending: false, reportError: errorMessage(failure) }
            : item,
        ),
      );
    } finally {
      reportControllers.current.delete(controller);
    }
  }

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    const text = question.trim();

    if (!text || busy || mode !== 'live' || !user) return;
    const costs: AssistantCostInput = {};

    // 비운 비용은 누락 상태로 전송한다. 0을 넣거나 견적을 채워야 대화가 열리는 조건은 없다.
    for (const { key, label } of costFields) {
      const raw = costInputs[key]?.trim();

      if (!raw) continue;
      const value = Number(raw);

      if (!Number.isFinite(value) || value < 0) {
        setError(`${label}은 0 이상의 숫자로 입력하거나 비워주세요.`);
        return;
      }
      Object.assign(costs, { [key]: value });
    }
    if (costInputs.component_name?.trim()) costs.component_name = costInputs.component_name.trim();
    if (costInputs.quote_source?.trim()) costs.quote_source = costInputs.quote_source.trim();
    const controller = new AbortController();

    const currentGeneration = generation.current;

    const userEntryId = `user-${++sequence.current}`;

    const requestObservation = [
      observation.trim(),
      selectedSignal ? `현재 확인할 문맥: ${selectedSignal}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);

    const currentSimulation = getSimulationContext?.() ?? simulationContext;

    requestController.current?.abort();
    requestController.current = controller;
    setBusy(true);
    setPendingQuestion(text);
    setError('');
    try {
      const reply = await sendChat(
        {
          question: text,
          history: recentChatHistory(messages.map(({ role, content }) => ({ role, content }))),
          ...(runId && modelKey ? { run_id: runId, model_key: modelKey, split } : {}),
          ...(requestObservation ? { observation: requestObservation } : {}),
          ...(Object.keys(costs).length ? { cost_inputs: costs } : {}),
          ...(currentSimulation ? { simulation_context: currentSimulation } : {}),
          expertise,
        },
        controller.signal,
      );

      if (controller.signal.aborted || currentGeneration !== generation.current) return;
      const assistantEntry: ChatEntry = {
        id: reply.message_id,
        role: 'assistant',
        content: reply.answer,
        reply,
      };

      setMessages((previous) => [
        ...previous,
        { id: userEntryId, role: 'user', content: text },
        assistantEntry,
      ]);
      setQuestion('');
      setPendingQuestion('');
      if (reply.report_message_id)
        void createReport(reply.message_id, reply.report_message_id, currentGeneration);
    } catch (failure) {
      if (!controller.signal.aborted && currentGeneration === generation.current)
        setError(errorMessage(failure));
    } finally {
      if (currentGeneration === generation.current) {
        setBusy(false);
        setPendingQuestion('');
      }
    }
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask();
    }
  }

  return (
    <div className="chat-conversation">
      <div
        ref={transcriptRef}
        className="chat-transcript"
        role="log"
        aria-label="포석호와 대화"
        aria-live="polite"
        aria-relevant="additions"
      >
        {!messages.length && !busy && (
          <div className="chat-welcome">
            <strong>무엇을 함께 확인할까요?</strong>
            <p>
              시뮬레이션 상태나 점검 방법을 물어보세요.
              <br />
              견적과 비용은 비워도 대화할 수 있어요.
            </p>
          </div>
        )}
        {messages.map((entry) => (
          <article
            key={entry.id}
            className={`chat-message chat-message-${entry.role}`}
            aria-label={entry.role === 'user' ? '내 질문' : '포석호 답변'}
          >
            <span className="chat-speaker">{entry.role === 'user' ? '나' : '포석호'}</span>
            <p>{entry.content}</p>
            {entry.reply && (
              <>
                <span className="chat-source-mode">
                  {entry.reply.source_mode === 'llm'
                    ? 'AI · 문헌 근거 확인'
                    : '문헌 검색 안내 · 외부 AI 응답 없음'}
                </span>
                {!!entry.reply.citations.length && (
                  <details className="chat-sources">
                    <summary>답변 근거 {entry.reply.citations.length}개</summary>
                    {entry.reply.citations.map((source) => (
                      <a key={source.id} href={source.url} target="_blank" rel="noreferrer">
                        {source.title} · {source.pages}
                      </a>
                    ))}
                  </details>
                )}
                {entry.reply.cost &&
                  (entry.reply.cost.total !== null || entry.reply.cost.missing.length < 4) && (
                    <div className="chat-cost-result">
                      {entry.reply.cost.total === null ? '입력 견적 소계' : '입력 비용 합계'}{' '}
                      <strong>
                        {(
                          entry.reply.cost.total ?? entry.reply.cost.known_subtotal
                        ).toLocaleString()}
                        원
                      </strong>
                      {entry.reply.cost.missing.length > 0 && (
                        <span>추가 확인: {entry.reply.cost.missing.join(' · ')}</span>
                      )}
                    </div>
                  )}
                {entry.reply.limitations.length > 0 && (
                  <details className="chat-limitations">
                    <summary>확인하지 못한 내용</summary>
                    {entry.reply.limitations.map((limit, index) => (
                      <p key={index}>{limit}</p>
                    ))}
                  </details>
                )}
                {entry.reportError && (
                  <p className="chat-report-error" role="status">
                    보고서: {entry.reportError}
                  </p>
                )}
                {entry.reply.report_message_id && (
                  <button
                    type="button"
                    className="chat-report-button"
                    disabled={
                      entry.reportPending ||
                      (!entry.report && !entry.reportError) ||
                      (!!entry.report && ['queued', 'generating'].includes(entry.report.status))
                    }
                    onClick={() => {
                      if (entry.report?.status === 'completed') {
                        setPreviewReport(entry.report);
                        setPreviewOpen(true);
                      } else if (entry.reply?.report_message_id)
                        void createReport(
                          entry.id,
                          entry.reply.report_message_id,
                          generation.current,
                        );
                    }}
                  >
                    {entry.report?.status === 'completed' ? (
                      <Check size={14} />
                    ) : entry.report?.status === 'failed' || entry.reportError ? (
                      <FileText size={14} />
                    ) : (
                      <LoaderCircle size={14} className="spin" />
                    )}
                    {entry.reportPending
                      ? '보고서 작성 중'
                      : entry.report?.status === 'completed'
                        ? '보고서 작성 완료'
                        : entry.report?.status === 'failed' || entry.reportError
                          ? '보고서 다시 작성'
                          : '보고서 작성 중'}
                  </button>
                )}
              </>
            )}
          </article>
        ))}
        {busy && (
          <>
            <article className="chat-message chat-message-user" aria-label="전송 중인 내 질문">
              <span className="chat-speaker">나</span>
              <p>{pendingQuestion}</p>
            </article>
            <div className="chat-pending" role="status">
              <LoaderCircle size={17} className="spin" /> 포석호가 근거를 확인하고 있어요.
            </div>
          </>
        )}
      </div>
      <form className="chat-composer" onSubmit={(event) => void ask(event)}>
        <details className="chat-optional-inputs">
          <summary>
            <Settings2 size={15} /> 현장 관찰·견적 / 비용 조건 입력 <span>선택</span>
          </summary>
          <div className="chat-optional-grid">
            <label className="chat-observation">
              직접 확인한 내용
              <textarea
                aria-label="채팅 현장 관찰"
                value={observation}
                maxLength={4000}
                onChange={(event) => setObservation(event.target.value)}
                placeholder="직접 본 누수·소음·점검 기록이 있으면 남겨주세요."
              />
            </label>
            <label>
              확인할 부품명
              <input
                aria-label="채팅 부품명"
                value={costInputs.component_name || ''}
                maxLength={120}
                onChange={(event) =>
                  setCostInputs((previous) => ({ ...previous, component_name: event.target.value }))
                }
              />
            </label>
            <label>
              견적·단가 출처
              <input
                aria-label="채팅 견적 출처"
                value={costInputs.quote_source || ''}
                maxLength={500}
                onChange={(event) =>
                  setCostInputs((previous) => ({ ...previous, quote_source: event.target.value }))
                }
              />
            </label>
            {costFields.map(({ key, label }) => (
              <label key={key}>
                {label}
                <input
                  aria-label={`채팅 ${label}`}
                  type="number"
                  min="0"
                  step="any"
                  value={costInputs[key] || ''}
                  onChange={(event) =>
                    setCostInputs((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                />
              </label>
            ))}
          </div>
        </details>
        {mode !== 'live' && <p className="chat-feedback">대화는 로그인 후 사용할 수 있어요.</p>}
        {error && (
          <p className="chat-feedback chat-feedback-error" role="alert">
            {error} 질문은 남아 있어요. 다시 전송할 수 있습니다.
          </p>
        )}
        <div className="chat-compose-row">
          <textarea
            aria-label="포석호에게 질문"
            value={question}
            maxLength={3000}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={composerKeyDown}
            disabled={busy || mode !== 'live'}
            placeholder="메시지를 입력하세요. 비용 없이 질문해도 괜찮아요."
            rows={2}
          />
          <button
            aria-label="메시지 보내기"
            type="submit"
            disabled={!question.trim() || busy || mode !== 'live' || !user}
          >
            {busy ? <LoaderCircle size={19} className="spin" /> : <Send size={19} />}
          </button>
        </div>
        <p className="chat-input-hint">Enter 전송 · Shift+Enter 줄바꿈</p>
      </form>
      <ReportPreview job={previewReport} open={previewOpen} onOpenChange={setPreviewOpen} />
    </div>
  );
}
