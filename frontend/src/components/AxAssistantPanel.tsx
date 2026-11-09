import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileText, LoaderCircle, Send } from 'lucide-react';
import { useExpertise } from '../context/ExpertiseContext';
import { useApp } from '../context/AppContext';
import { errorMessage } from '../lib/api';
import {
  axDownload,
  axRequest,
  type AssistantCostInput,
  type AssistantReply,
  type AssistantRequest,
  type ReportJob,
} from '../lib/ax-api';
import { Field, Modal, Notice } from './ui';
import './ax.css';

interface Props {
  runId: string | null;
  modelKey: string | null;
  split?: 'validation' | 'test';
  selectedSignal?: string;
  contextKey?: string;
}

const costFields: { key: keyof AssistantCostInput; label: string }[] = [
  { key: 'parts_cost', label: '부품 견적 (원)' },
  { key: 'inspection_cost', label: '점검비 (원)' },
  { key: 'labor_hours', label: '작업 시간' },
  { key: 'labor_hourly_rate', label: '시간당 작업비 (원)' },
  { key: 'downtime_hours', label: '생산 정지 시간' },
  { key: 'downtime_loss_per_hour', label: '시간당 정지 손실 (원)' },
];

export function ReportPreview({
  job,
  open,
  onOpenChange,
}: {
  job: ReportJob | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [downloadError, setDownloadError] = useState('');

  async function download(extension: 'pdf' | 'docx') {
    if (!job || job.status !== 'completed') return;
    setDownloadError('');
    try {
      await axDownload(
        `/reports/${job.id}/download.${extension}`,
        `점검보고서-${job.id.slice(0, 8)}.${extension}`,
      );
    } catch (error) {
      setDownloadError(errorMessage(error));
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="점검 보고서 미리보기"
      description="모델 결과·현장 관찰·비용 가정과 출처를 함께 확인하세요."
      className="ax-report-modal"
      footer={
        <>
          <button
            className="button secondary"
            onClick={() => download('docx')}
            disabled={job?.status !== 'completed'}
          >
            <Download size={16} />
            Word 다운로드
          </button>
          <button
            className="button primary"
            onClick={() => download('pdf')}
            disabled={job?.status !== 'completed'}
          >
            <Download size={16} />
            PDF 다운로드
          </button>
        </>
      }
    >
      {downloadError && <Notice tone="error">{downloadError}</Notice>}
      {job?.preview ? (
        <article className="ax-report-paper">
          <h2>{job.preview.title}</h2>
          {job.preview.sections.map((section, index) => (
            <section key={index}>
              <h3>{section.heading}</h3>
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={paragraphIndex}>{paragraph}</p>
              ))}
            </section>
          ))}
          <h3>출처</h3>
          {(job.preview.citations || []).map((citation) => (
            <p key={citation.id}>
              <a href={citation.url} target="_blank" rel="noreferrer">
                {citation.title}
              </a>{' '}
              · {citation.pages}
            </p>
          ))}
        </article>
      ) : (
        <p>보고서 내용을 불러오지 못했어요.</p>
      )}
    </Modal>
  );
}

export default function AxAssistantPanel({
  runId,
  modelKey,
  split = 'validation',
  selectedSignal = '',
  contextKey = '',
}: Props) {
  const { expertise, isExpert } = useExpertise();

  const { mode, user } = useApp();

  const [question, setQuestion] = useState(
    '이상 신호가 나왔어요. 점검할 항목과 비용에 필요한 정보를 알려줘.',
  );

  const [observation, setObservation] = useState('');

  const [costInputs, setCostInputs] = useState<Record<string, string>>({});

  const [reply, setReply] = useState<AssistantReply | null>(null);

  const [job, setJob] = useState<ReportJob | null>(null);

  const [busy, setBusy] = useState(false);

  const [error, setError] = useState('');

  const [reportError, setReportError] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);

  const controller = useRef<AbortController | null>(null);

  const generation = useRef(0);

  // 데이터·계정이 바뀌면 이전 답변과 보고서를 새 모델의 결과로 보여주지 않는다.
  useEffect(() => {
    generation.current += 1;
    controller.current?.abort();
    setReply(null);
    setJob(null);
    setBusy(false);
    setError('');
    setReportError('');
    setPreviewOpen(false);
    return () => controller.current?.abort();
  }, [runId, modelKey, split, user?.id, mode, expertise, selectedSignal, contextKey]);

  useEffect(() => {
    setObservation('');
    setCostInputs({});
  }, [runId, modelKey, split, user?.id, mode]);

  // 화면을 닫거나 다른 기록으로 옮기면 해당 보고서의 상태 조회도 종료한다.
  useEffect(() => {
    if (!job || !['queued', 'generating'].includes(job.status)) return;
    const pollingController = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const updated = await axRequest<ReportJob>(`/reports/${job.id}`, {
          signal: pollingController.signal,
        });

        if (!pollingController.signal.aborted) setJob(updated);
      } catch (pollError) {
        if (!pollingController.signal.aborted) setReportError(errorMessage(pollError));
      }
    }, 1000);

    return () => {
      clearTimeout(timer);
      pollingController.abort();
    };
  }, [job]);

  async function createReport(messageId: string, currentGeneration: number) {
    setReportError('');
    try {
      const report = await axRequest<ReportJob>('/reports', {
        method: 'POST',
        body: JSON.stringify({ message_id: messageId }),
        signal: controller.current?.signal,
      });

      if (currentGeneration === generation.current) setJob(report);
    } catch (reportFailure) {
      if (currentGeneration === generation.current && !controller.current?.signal.aborted)
        setReportError(errorMessage(reportFailure));
    }
  }

  async function ask() {
    if (!runId || !modelKey || !question.trim() || busy || mode !== 'live') return;
    controller.current?.abort();
    controller.current = new AbortController();
    const currentGeneration = ++generation.current;

    const costs: AssistantCostInput = {};

    for (const { key } of costFields) {
      const raw = costInputs[key];

      if (raw !== undefined && raw.trim() !== '') {
        const amount = Number(raw);

        if (!Number.isFinite(amount) || amount < 0) {
          setError('비용과 시간은 0 이상의 숫자로 입력해주세요.');
          return;
        }
        Object.assign(costs, { [key]: amount });
      }
    }
    if (costInputs.component_name?.trim()) costs.component_name = costInputs.component_name.trim();
    if (costInputs.quote_source?.trim()) costs.quote_source = costInputs.quote_source.trim();
    if (costInputs.standby_available !== undefined && costInputs.standby_available !== '')
      costs.standby_available = costInputs.standby_available === 'yes';
    const request: AssistantRequest = {
      question: selectedSignal ? `${question}\n현재 확인한 신호: ${selectedSignal}` : question,
      run_id: runId,
      model_key: modelKey,
      split,
      observation: observation || undefined,
      cost_inputs: costs,
      expertise,
    };

    setBusy(true);
    setError('');
    setReply(null);
    setJob(null);
    try {
      const response = await axRequest<AssistantReply>('/assistant/messages', {
        method: 'POST',
        body: JSON.stringify(request),
        signal: controller.current.signal,
      });

      if (currentGeneration !== generation.current) return;
      setReply(response);
      await createReport(response.message_id, currentGeneration);
    } catch (requestError) {
      if (currentGeneration === generation.current && !controller.current?.signal.aborted)
        setError(errorMessage(requestError));
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  }

  const waitingForReport = job?.status === 'queued' || job?.status === 'generating';

  return (
    <section className="surface ax-assistant">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ACTION ASSISTANT</span>
          <h2>{isExpert ? 'RAG 점검·비용 안내' : '다음에 무엇을 확인할까요?'}</h2>
        </div>
        <FileText size={20} />
      </div>
      {!runId || !modelKey ? <Notice>학습을 마친 모델을 먼저 선택해주세요.</Notice> : null}
      {mode !== 'live' && <Notice>실제 계정으로 로그인한 뒤 저장된 모델을 연결해주세요.</Notice>}
      <Field
        label="직접 확인한 내용"
        htmlFor="ax-observation"
        hint="누수 위치·소음·점검 결과처럼 직접 확인한 사실을 적어주세요."
      >
        <textarea
          id="ax-observation"
          className="input"
          value={observation}
          maxLength={4000}
          onChange={(event) => setObservation(event.target.value)}
          placeholder="예: 축봉 주변에 물방울이 보여요. 축봉 형식은 아직 확인하지 못했어요."
        />
      </Field>
      <details className="ax-cost-inputs">
        <summary>견적·비용 조건 입력</summary>
        <p>문헌에는 현재 부품 단가가 없어요. 견적서나 사내 기준으로 입력해주세요.</p>
        <div className="ax-input-grid">
          {[
            { key: 'component_name', label: '확인할 부품명' },
            { key: 'quote_source', label: '견적·단가 출처' },
          ].map(({ key, label }) => (
            <Field key={key} label={label} htmlFor={`ax-${key}`}>
              <input
                className="input"
                id={`ax-${key}`}
                value={costInputs[key] || ''}
                maxLength={key === 'component_name' ? 120 : 500}
                onChange={(event) =>
                  setCostInputs((previous) => ({ ...previous, [key]: event.target.value }))
                }
              />
            </Field>
          ))}
          {costFields.map(({ key, label }) => (
            <Field key={key} label={label} htmlFor={`ax-${key}`}>
              <input
                className="input"
                type="number"
                id={`ax-${key}`}
                min="0"
                step="any"
                value={costInputs[key] || ''}
                onChange={(event) =>
                  setCostInputs((previous) => ({ ...previous, [key]: event.target.value }))
                }
              />
            </Field>
          ))}
          <Field label="예비 펌프 상태" htmlFor="ax-standby">
            <select
              className="input"
              id="ax-standby"
              value={costInputs.standby_available || ''}
              onChange={(event) =>
                setCostInputs((previous) => ({
                  ...previous,
                  standby_available: event.target.value,
                }))
              }
            >
              <option value="">아직 확인하지 않음</option>
              <option value="yes">정상 절체 가능함</option>
              <option value="no">사용 가능한 예비 펌프 없음</option>
            </select>
          </Field>
        </div>
      </details>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
        className="ax-question-form"
      >
        <label htmlFor="ax-question">
          {isExpert ? '모델 결과와 현장 관찰에 대해 질문' : '궁금한 점'}
        </label>
        <textarea
          id="ax-question"
          className="input"
          value={question}
          maxLength={2500}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <div className="ax-actions">
          <button
            className="button primary"
            disabled={busy || !runId || !modelKey || !question.trim() || mode !== 'live'}
          >
            {busy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{' '}
            {busy ? '근거 확인 중' : '안내·보고서 작성'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={job?.status !== 'completed'}
            onClick={() => setPreviewOpen(true)}
          >
            {waitingForReport ? (
              <LoaderCircle className="spin" size={16} />
            ) : job?.status === 'completed' ? (
              <Check size={16} />
            ) : (
              <FileText size={16} />
            )}
            {waitingForReport
              ? '보고서 작성 중'
              : job?.status === 'completed'
                ? '보고서 작성 완료'
                : '보고서 대기'}
          </button>
        </div>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {(reportError || job?.status === 'failed') && (
        <Notice tone="error">
          {reportError || job?.error_message || '보고서 작성에 실패했어요.'}
          {reply && (
            <button
              className="text-link"
              onClick={() => createReport(reply.message_id, generation.current)}
            >
              보고서 다시 요청
            </button>
          )}
        </Notice>
      )}
      {reply && (
        <div className="ax-reply" aria-live="polite">
          <BadgeMode mode={reply.source_mode} />
          <p className="ax-answer">{reply.answer}</p>
          {reply.cost && (
            <div className="ax-cost-total">
              <span>
                {reply.cost.total === null ? '확인된 항목의 소계' : '입력 조건의 예상 비용'}
              </span>
              <strong>
                {reply.cost.total === null &&
                reply.cost.known_subtotal === 0 &&
                reply.cost.missing.length >= 4
                  ? '계산할 입력값 없음'
                  : `${(reply.cost.total ?? reply.cost.known_subtotal).toLocaleString('ko-KR')}원`}
              </strong>
              {reply.cost.missing.length > 0 && <p>확인 필요: {reply.cost.missing.join(' · ')}</p>}
            </div>
          )}
          {reply.suggested_checks?.length > 0 && (
            <>
              <h3>다음 점검</h3>
              <ul>
                {reply.suggested_checks.map((check, index) => (
                  <li key={index}>{check}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary>답변의 출처와 적용 한계</summary>
            {reply.citations.map((citation) => (
              <p key={citation.id}>
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {citation.title}
                </a>{' '}
                · {citation.pages}
                <br />
                {citation.summary}
              </p>
            ))}
            {reply.limitations.map((limit, index) => (
              <p key={index}>{limit}</p>
            ))}
          </details>
        </div>
      )}
      <ReportPreview job={job} open={previewOpen} onOpenChange={setPreviewOpen} />
    </section>
  );
}

function BadgeMode({ mode }: { mode: AssistantReply['source_mode'] }) {
  return (
    <small className="ax-source-badge">
      {mode === 'llm' ? 'AI 설명 · 문헌 근거 포함' : '문헌 검색 요약 · 외부 AI 미연결'}
    </small>
  );
}
