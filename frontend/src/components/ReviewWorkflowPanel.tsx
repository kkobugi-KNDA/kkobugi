import { useEffect, useRef, useState } from 'react';
import { Check, FileCheck2, History, LoaderCircle, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { ApiError, errorMessage } from '../lib/api';
import {
  assessmentApi,
  type ModelResultReference,
  type ObservationReference,
  type ReviewHistory,
  type ReviewPatch,
  type ReviewRecord,
} from '../lib/assessment-api';
import type { SavedJudgment, SavedObservation } from '../lib/review-api';
import type { AppMode } from '../types';
import { csvTimestampToNumber, type SelectedRange } from './TimeSeriesChart';
import { Badge, EmptyState, Field, Modal, Notice } from './ui';
import './review-workflow.css';

interface Props {
  datasetId: string | null;
  channel: string;
  selection: SelectedRange | null;
  modelResult: ModelResultReference | null;
  observations: SavedObservation[];
  observationsTotal?: number;
  mode: AppMode;
}

const judgmentText: Record<SavedJudgment, string> = {
  needs_check: '판단 보류',
  anomaly_candidate: '이상 후보',
  normal: '정상으로 판단',
};

const actionText = {
  created: '검토 생성',
  updated: '검토 수정',
  completed: '검토 완료',
  reopened: '다시 열기',
};

const formatTime = (time: string) => time.replace('T', ' ');

const actorTime = (time: number) => new Date(time * 1000).toLocaleString('ko-KR');

export function matchingObservations(
  observations: SavedObservation[],
  channel: string,
  range: SelectedRange | null,
): SavedObservation[] {
  if (!range) return [];

  return observations.filter((observation) => {
    const start = csvTimestampToNumber(observation.start_time);

    const end = csvTimestampToNumber(observation.end_time);

    return observation.channel === channel && start <= range.end.time && end >= range.start.time;
  });
}

function SavedEvidence({ review }: { review: ReviewRecord }) {
  const model = review.evidence.model_result;

  return (
    <div className="rw-evidence">
      <h4>당시 확인한 근거</h4>
      {model ? (
        <div className="rw-model-evidence">
          <strong>
            {model.display_name} · {model.split === 'validation' ? 'Valid' : 'Test'}
          </strong>
          <p>아래 지표는 해당 분할 전체 기준이에요. 선택한 짧은 구간의 지표가 아닙니다.</p>
          <dl className="rw-metrics">
            <div>
              <dt>표본 수</dt>
              <dd>{model.partition_metrics.sample_count.toLocaleString('ko-KR')}</dd>
            </div>
            <div>
              <dt>F1</dt>
              <dd>{model.partition_metrics.f1?.toFixed(4) ?? '계산 불가'}</dd>
            </div>
            <div>
              <dt>정밀도</dt>
              <dd>{model.partition_metrics.precision?.toFixed(4) ?? '계산 불가'}</dd>
            </div>
            <div>
              <dt>재현율</dt>
              <dd>{model.partition_metrics.recall?.toFixed(4) ?? '계산 불가'}</dd>
            </div>
          </dl>
          <details>
            <summary>모델 실행과 입력 확인</summary>
            <dl className="rw-identifiers">
              <dt>실행 ID</dt>
              <dd>{model.run_id}</dd>
              <dt>학습 채널</dt>
              <dd>{model.feature_columns.join(', ')}</dd>
              <dt>입력 SHA256</dt>
              <dd>{model.input_sha256}</dd>
              <dt>모델 SHA256</dt>
              <dd>{model.artifact_sha256}</dd>
            </dl>
          </details>
        </div>
      ) : (
        <p>연결한 모델 결과가 없습니다.</p>
      )}
      {review.evidence.observations.map((observation) => (
        <article
          className="rw-observation-evidence"
          key={`${observation.id}:${observation.revision}`}
        >
          <strong>
            현장 관찰 · 수정 {observation.revision} · {observation.author.display_name}
          </strong>
          <p>
            {formatTime(observation.start_time)} — {formatTime(observation.end_time)}
          </p>
          {observation.location && <p>{observation.location}</p>}
          <p className="rw-preserve-text">{observation.content}</p>
          <span>{judgmentText[observation.judgment]}</span>
        </article>
      ))}
      {!review.evidence.observations.length && <p>연결한 현장 관찰이 없습니다.</p>}
    </div>
  );
}

export default function ReviewWorkflowPanel({
  datasetId,
  channel,
  selection,
  modelResult,
  observations,
  observationsTotal = observations.length,
  mode,
}: Props) {
  const { user } = useApp();

  const contextKey = `${mode}:${user?.id ?? 0}:${datasetId ?? ''}:${channel}`;

  const currentContext = useRef(contextKey);

  currentContext.current = contextKey;

  const detailRequest = useRef(0);

  const detailController = useRef<AbortController | null>(null);

  const historyController = useRef<AbortController | null>(null);

  const [records, setRecords] = useState<ReviewRecord[]>([]);

  const [total, setTotal] = useState(0);

  const [listVersion, setListVersion] = useState(0);

  const [loading, setLoading] = useState(false);

  const [listError, setListError] = useState('');

  const [createOpen, setCreateOpen] = useState(false);

  const [createRange, setCreateRange] = useState<SelectedRange | null>(null);

  const [choices, setChoices] = useState<SavedObservation[]>([]);

  const [createModel, setCreateModel] = useState<ModelResultReference | null>(null);

  const [attachModel, setAttachModel] = useState(false);

  const [selectedObservations, setSelectedObservations] = useState<string[]>([]);

  const [newConclusion, setNewConclusion] = useState('');

  const [newJudgment, setNewJudgment] = useState<SavedJudgment>('needs_check');

  const [detailOpen, setDetailOpen] = useState(false);

  const [detail, setDetail] = useState<ReviewRecord | null>(null);

  const [openedId, setOpenedId] = useState<string | null>(null);

  const [detailLoading, setDetailLoading] = useState(false);

  const [editConclusion, setEditConclusion] = useState('');

  const [editJudgment, setEditJudgment] = useState<SavedJudgment>('needs_check');

  const [editingEvidence, setEditingEvidence] = useState(false);

  const [evidenceChoices, setEvidenceChoices] = useState<SavedObservation[]>([]);

  const [editObservations, setEditObservations] = useState<ObservationReference[]>([]);

  const [editModelAction, setEditModelAction] = useState<'keep' | 'current' | 'remove'>('keep');

  const [availableModel, setAvailableModel] = useState<ModelResultReference | null>(null);

  const [reopenReason, setReopenReason] = useState('');

  const [busy, setBusy] = useState(false);

  const [saveError, setSaveError] = useState('');

  const [conflict, setConflict] = useState(false);

  const [history, setHistory] = useState<ReviewHistory | null>(null);

  const [historyLoading, setHistoryLoading] = useState(false);

  const [historyError, setHistoryError] = useState('');

  // 사용자·자료·채널이 바뀌면 이전 요청과 입력창을 닫아 다른 문맥의 기록을 섞지 않는다.
  useEffect(() => {
    detailRequest.current += 1;

    detailController.current?.abort();
    historyController.current?.abort();
    setRecords([]);
    setTotal(0);
    setCreateOpen(false);
    setCreateRange(null);
    setChoices([]);
    setDetailOpen(false);
    setDetail(null);
    setOpenedId(null);
    setEditingEvidence(false);
    setEvidenceChoices([]);
    setEditObservations([]);
    setAvailableModel(null);
    setSaveError('');
    setConflict(false);
    setBusy(false);
    setDetailLoading(false);
    setHistory(null);
    setHistoryError('');
    setHistoryLoading(false);
    return () => {
      detailRequest.current += 1;

      detailController.current?.abort();
      historyController.current?.abort();
    };
  }, [contextKey]);

  useEffect(() => {
    setListError('');
    if (mode !== 'live' || !datasetId || !channel) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();

    setLoading(true);
    assessmentApi
      .list(datasetId, channel, 0, controller.signal)
      .then((page) => {
        if (!controller.signal.aborted && currentContext.current === contextKey) {
          setRecords(page.items);
          setTotal(page.total);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted && currentContext.current === contextKey)
          setListError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && currentContext.current === contextKey) setLoading(false);
      });
    return () => controller.abort();
  }, [contextKey, datasetId, channel, mode, listVersion]);

  const applyDetail = (record: ReviewRecord) => {
    setDetail(record);
    setEditConclusion(record.conclusion);
    setEditJudgment(record.judgment);
    setEditingEvidence(false);
    setEvidenceChoices([]);
    setEditObservations([]);
    setEditModelAction('keep');
    setAvailableModel(null);
    setReopenReason('');
    setHistory(null);
    setHistoryError('');
    setConflict(false);
    setSaveError('');
  };

  const openRecord = async (id: string) => {
    detailController.current?.abort();
    historyController.current?.abort();

    const controller = new AbortController();

    const requestId = ++detailRequest.current;

    detailController.current = controller;

    setDetailOpen(true);
    setOpenedId(id);
    setDetailLoading(true);
    setDetail(null);
    setSaveError('');
    setHistory(null);
    setHistoryLoading(false);
    try {
      const record = await assessmentApi.get(id, controller.signal);

      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        applyDetail(record);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        setSaveError(errorMessage(error));
    } finally {
      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        setDetailLoading(false);
    }
  };

  const openCreate = () => {
    if (!selection || mode !== 'live') return;
    setCreateRange(selection);
    // 입력창을 연 뒤 목록이 갱신되어도 확인했던 관찰 버전을 자동 교체하지 않는다.
    setChoices(
      matchingObservations(
        observations.filter((item) => item.dataset_id === datasetId),
        channel,
        selection,
      ),
    );
    setCreateModel(modelResult);
    setAttachModel(modelResult !== null);
    setSelectedObservations([]);
    setNewConclusion('');
    setNewJudgment('needs_check');
    setSaveError('');
    setConflict(false);
    setCreateOpen(true);
  };

  const createRecord = async () => {
    if (!datasetId || !createRange || busy) return;
    setBusy(true);
    setSaveError('');
    try {
      // 관찰의 최신 내용을 추측하지 않고 체크한 저장본의 수정 번호를 보낸다.
      const record = await assessmentApi.create({
        dataset_id: datasetId,
        channel,
        start_time: createRange.start.timestamp,
        end_time: createRange.end.timestamp,
        conclusion: newConclusion,
        judgment: newJudgment,
        model_result: attachModel ? createModel : null,
        observations: choices
          .filter((item) => selectedObservations.includes(item.id))
          .map((item) => ({ observation_id: item.id, revision: item.revision })),
      });

      if (currentContext.current !== contextKey) return;
      setCreateOpen(false);
      applyDetail(record);
      setOpenedId(record.id);
      setDetailOpen(true);
      setListVersion((version) => version + 1);
    } catch (error) {
      if (currentContext.current === contextKey) setSaveError(errorMessage(error));
    } finally {
      if (currentContext.current === contextKey) setBusy(false);
    }
  };

  const updateRecord = async (operation: 'save' | 'complete' | 'reopen') => {
    if (!detail || busy) return;

    const requestId = detailRequest.current;

    setBusy(true);
    setSaveError('');
    setConflict(false);
    try {
      // 기존 근거는 기본적으로 생략해 보존하고, 사용자가 연 편집창에서만 교체한다.
      const patch: ReviewPatch = {
        revision: detail.revision,
        conclusion: editConclusion,
        judgment: editJudgment,
        ...(editingEvidence ? { observations: editObservations } : {}),
        ...(editingEvidence && editModelAction !== 'keep'
          ? { model_result: editModelAction === 'current' ? availableModel : null }
          : {}),
      };

      const record =
        operation === 'save'
          ? await assessmentApi.patch(detail.id, patch)
          : operation === 'complete'
            ? await assessmentApi.complete(detail.id, detail.revision)
            : await assessmentApi.reopen(detail.id, detail.revision, reopenReason);

      if (currentContext.current !== contextKey || requestId !== detailRequest.current) return;
      applyDetail(record);
      setListVersion((version) => version + 1);
    } catch (error) {
      if (currentContext.current !== contextKey || requestId !== detailRequest.current) return;
      setSaveError(errorMessage(error));
      // 충돌 시 입력을 지우거나 최신 버전으로 재전송하지 않고 사용자가 비교하도록 남긴다.
      if (error instanceof ApiError && error.status === 409) setConflict(true);
    } finally {
      if (currentContext.current === contextKey && requestId === detailRequest.current)
        setBusy(false);
    }
  };

  const loadHistory = async (more = false) => {
    if (!detail || historyLoading) return;

    const controller = new AbortController();

    const requestId = detailRequest.current;

    historyController.current?.abort();
    historyController.current = controller;

    setHistoryLoading(true);
    setHistoryError('');
    try {
      const result = await assessmentApi.history(
        detail.id,
        more ? (history?.items.length ?? 0) : 0,
        controller.signal,
      );

      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        setHistory((current) =>
          more && current ? { ...result, items: [...current.items, ...result.items] } : result,
        );
    } catch (error) {
      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        setHistoryError(errorMessage(error));
    } finally {
      if (
        !controller.signal.aborted &&
        currentContext.current === contextKey &&
        requestId === detailRequest.current
      )
        setHistoryLoading(false);
    }
  };

  const beginEvidenceEdit = () => {
    if (!detail || detail.status !== 'in_progress') return;

    const range: SelectedRange = {
      start: {
        timestamp: detail.start_time,
        time: csvTimestampToNumber(detail.start_time),
        value: null,
        label: '',
      },
      end: {
        timestamp: detail.end_time,
        time: csvTimestampToNumber(detail.end_time),
        value: null,
        label: '',
      },
    };

    const candidates = [
      ...detail.evidence.observations,
      ...matchingObservations(
        observations.filter((item) => item.dataset_id === detail.dataset_id),
        detail.channel,
        range,
      ),
    ];

    const uniqueCandidates = new Map(
      candidates.map((item) => [`${item.id}:${item.revision}`, item]),
    );

    // 과거·현재 수정본을 각각 보여주고 새 버전은 직접 체크할 때만 연결한다.
    setEvidenceChoices(Array.from(uniqueCandidates.values()));
    setEditObservations(
      detail.evidence.observations.map((item) => ({
        observation_id: item.id,
        revision: item.revision,
      })),
    );
    setAvailableModel(modelResult);
    setEditModelAction('keep');
    setEditingEvidence(true);
  };

  const loadMore = async () => {
    if (!datasetId || loading) return;
    setLoading(true);
    setListError('');
    try {
      const page = await assessmentApi.list(datasetId, channel, records.length);

      if (currentContext.current === contextKey) {
        setRecords((current) => [...current, ...page.items]);
        setTotal(page.total);
      }
    } catch (error) {
      if (currentContext.current === contextKey) setListError(errorMessage(error));
    } finally {
      if (currentContext.current === contextKey) setLoading(false);
    }
  };

  const dirty =
    detail !== null &&
    (editConclusion !== detail.conclusion || editJudgment !== detail.judgment || editingEvidence);

  const canComplete =
    detail !== null &&
    detail.conclusion.trim() !== '' &&
    (detail.evidence.model_result !== null || detail.evidence.observations.length > 0);

  return (
    <section className="surface rw-panel">
      <div className="section-heading">
        <div>
          <h2>검토 완료와 이력</h2>
          <p>모델 결과·현장 관찰을 근거로 남기고 검토를 마칩니다.</p>
        </div>
        <div className="rw-actions">
          <button
            className="icon-button"
            aria-label="검토 목록 새로고침"
            disabled={loading || mode !== 'live'}
            onClick={() => setListVersion((version) => version + 1)}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="button primary"
            onClick={openCreate}
            disabled={mode !== 'live' || !selection || !datasetId || !channel}
          >
            <Plus size={16} />
            선택한 구간 검토하기
          </button>
        </div>
      </div>
      {mode === 'demo' ? (
        <Notice>
          미리보기에서는 검토를 저장하지 않습니다. 로그인 후 실제 CSV와 관찰을 연결해주세요.
        </Notice>
      ) : (
        <>
          {!selection && (
            <p className="rw-hint">그래프의 노란 구간을 선택한 뒤 검토를 만들 수 있어요.</p>
          )}
          {listError && (
            <Notice tone="error">
              {listError}{' '}
              <button
                className="button secondary"
                onClick={() => setListVersion((version) => version + 1)}
              >
                검토 목록 다시 불러오기
              </button>
            </Notice>
          )}
          {loading && !records.length ? (
            <p role="status">
              <LoaderCircle size={16} className="rv-spin" />
              검토 목록을 불러오고 있어요.
            </p>
          ) : !records.length && !listError ? (
            <EmptyState
              icon={FileCheck2}
              title="아직 저장한 검토가 없습니다"
              description="선택한 채널의 관찰과 모델 결과를 연결해 기록하세요."
            />
          ) : null}
          <div className="rw-record-list">
            {records.map((record) => (
              <button
                key={record.id}
                className="rw-record"
                aria-label={`검토 열기: ${record.conclusion || '미작성 검토'}`}
                onClick={() => openRecord(record.id)}
              >
                <div>
                  <Badge tone={record.status === 'completed' ? 'green' : 'slate'}>
                    {record.status === 'completed' ? '검토 완료' : '검토 중'}
                  </Badge>
                  <span>{judgmentText[record.judgment]}</span>
                  <span>수정 {record.revision}</span>
                </div>
                <strong>{record.conclusion || '미작성 검토'}</strong>
                <small>
                  {formatTime(record.start_time)} — {formatTime(record.end_time)} ·{' '}
                  {record.last_editor.display_name}
                </small>
              </button>
            ))}
          </div>
          {records.length > 0 && (
            <p className="rw-hint">
              {records.length} / {total}개 검토
            </p>
          )}
          {records.length < total && (
            <button className="button secondary" onClick={loadMore} disabled={loading}>
              {loading ? '불러오는 중' : '검토 더 불러오기'}
            </button>
          )}
        </>
      )}
      <Modal
        open={createOpen}
        onOpenChange={(open) => {
          if (!busy) setCreateOpen(open);
        }}
        title="검토 기록 만들기"
        description="확인한 모델 결과와 관찰 버전을 연결합니다. 초안 저장 후 완료할 수 있어요."
        className="rw-modal"
        footer={
          <button className="button primary" disabled={busy} onClick={createRecord}>
            {busy ? '저장 중' : '검토 초안 저장'}
          </button>
        }
      >
        {createRange && (
          <p className="rw-context">
            {channel} · {formatTime(createRange.start.timestamp)} —{' '}
            {formatTime(createRange.end.timestamp)}
          </p>
        )}
        <Field label="검토 내용" htmlFor="rw-new-conclusion">
          <textarea
            id="rw-new-conclusion"
            className="textarea"
            maxLength={5000}
            value={newConclusion}
            onChange={(event) => setNewConclusion(event.target.value)}
            disabled={busy}
          />
        </Field>
        <Field label="직접 내린 판단" htmlFor="rw-new-judgment">
          <select
            id="rw-new-judgment"
            className="select"
            value={newJudgment}
            onChange={(event) => setNewJudgment(event.target.value as SavedJudgment)}
            disabled={busy}
          >
            {Object.entries(judgmentText).map(([key, text]) => (
              <option value={key} key={key}>
                {text}
              </option>
            ))}
          </select>
        </Field>
        <label className="rw-checkbox">
          <input
            type="checkbox"
            checked={attachModel}
            disabled={busy || createModel === null}
            onChange={(event) => setAttachModel(event.target.checked)}
          />
          선택한 모델 결과 연결
        </label>
        <p className="rw-hint">
          {createModel
            ? `${createModel.model_key} · ${createModel.split === 'validation' ? 'Valid' : 'Test'} · 해당 분할 전체의 평가 결과`
            : '위에서 실행·모델을 고르고 예측 결과를 먼저 조회해주세요.'}
        </p>
        <h4>같은 구간에 남긴 현장 관찰</h4>
        <p className="rw-hint">
          현재 불러온 관찰 중 선택합니다. 확인한 수정 번호를 그대로 남겨요. 최대 50개.
        </p>
        {observationsTotal > observations.length && (
          <p className="rw-hint">
            자료의 관찰 {observationsTotal}개 중 {observations.length}개를 불러왔어요. 이전 관찰이
            필요하면 아래 관찰 목록에서 더 불러온 뒤 이 창을 다시 열어주세요.
          </p>
        )}
        {choices.map((observation) => (
          <label className="rw-observation-choice" key={observation.id}>
            <input
              type="checkbox"
              aria-label={`${observation.content} · 수정 ${observation.revision}`}
              checked={selectedObservations.includes(observation.id)}
              disabled={
                busy ||
                (!selectedObservations.includes(observation.id) &&
                  selectedObservations.length >= 50)
              }
              onChange={(event) =>
                setSelectedObservations((current) =>
                  event.target.checked
                    ? [...current, observation.id]
                    : current.filter((id) => id !== observation.id),
                )
              }
            />
            <span>
              <strong>{observation.content}</strong>
              <small>
                수정 {observation.revision} · {observation.author.display_name} ·{' '}
                {formatTime(observation.start_time)}
              </small>
            </span>
          </label>
        ))}
        {!choices.length && (
          <p className="rw-hint">현재 불러온 관찰 중 같은 채널·시간대에 겹치는 기록이 없습니다.</p>
        )}
        {saveError && <Notice tone="error">{saveError}</Notice>}
      </Modal>
      <Modal
        open={detailOpen}
        onOpenChange={(open) => {
          if (busy) return;
          setDetailOpen(open);
          if (!open) {
            detailRequest.current += 1;
            detailController.current?.abort();
            historyController.current?.abort();
          }
        }}
        title="검토 기록"
        description="검토 상태와 직접 내린 판단은 따로 저장합니다."
        className="rw-modal"
      >
        {detailLoading && <p role="status">검토 내용을 불러오고 있어요.</p>}
        {saveError && <Notice tone="error">{saveError}</Notice>}
        {!detail && !detailLoading && saveError && openedId && (
          <button className="button secondary" onClick={() => openRecord(openedId)}>
            검토 다시 불러오기
          </button>
        )}
        {conflict && detail && (
          <Notice tone="warning">
            <p>내 입력은 그대로 남아 있어요. 최신 기록을 불러오면 현재 입력을 바꿉니다.</p>
            <button className="button secondary" onClick={() => openRecord(detail.id)}>
              최신 검토 불러오기
            </button>
          </Notice>
        )}
        {detail && (
          <>
            <div className="rw-detail-heading">
              <Badge tone={detail.status === 'completed' ? 'green' : 'slate'}>
                {detail.status === 'completed' ? '검토 완료' : '검토 중'}
              </Badge>
              <span>
                수정 {detail.revision} · {detail.last_editor.display_name}
              </span>
            </div>
            <p className="rw-context">
              {detail.channel} · {formatTime(detail.start_time)} — {formatTime(detail.end_time)}
            </p>
            {detail.status === 'completed' && (
              <Notice tone="success">
                {detail.completed_by?.display_name} ·{' '}
                {detail.completed_at ? actorTime(detail.completed_at) : ''} 완료. 내용을 수정하려면
                이유를 남기고 다시 열어주세요.
              </Notice>
            )}
            <Field label="검토 내용" htmlFor="rw-edit-conclusion">
              <textarea
                id="rw-edit-conclusion"
                className="textarea"
                maxLength={5000}
                value={editConclusion}
                onChange={(event) => setEditConclusion(event.target.value)}
                disabled={busy || detail.status === 'completed'}
              />
            </Field>
            <Field label="직접 내린 판단" htmlFor="rw-edit-judgment">
              <select
                id="rw-edit-judgment"
                className="select"
                value={editJudgment}
                onChange={(event) => setEditJudgment(event.target.value as SavedJudgment)}
                disabled={busy || detail.status === 'completed'}
              >
                {Object.entries(judgmentText).map(([key, text]) => (
                  <option value={key} key={key}>
                    {text}
                  </option>
                ))}
              </select>
            </Field>
            <SavedEvidence review={detail} />
            {detail.status === 'in_progress' && !editingEvidence && (
              <button className="button secondary" disabled={busy} onClick={beginEvidenceEdit}>
                근거 수정
              </button>
            )}
            {detail.status === 'in_progress' && editingEvidence && (
              <fieldset className="rw-evidence-editor" disabled={busy}>
                <legend>연결 근거 바꾸기</legend>
                <p className="rw-hint">
                  아래 선택은 검토 수정 저장을 눌러야 반영돼요. 관찰의 새 버전은 직접 선택해야
                  연결됩니다.
                </p>
                <label className="rw-checkbox">
                  <input
                    type="radio"
                    name="rw-model-evidence"
                    checked={editModelAction === 'keep'}
                    onChange={() => setEditModelAction('keep')}
                  />
                  기존 모델 근거 유지{detail.evidence.model_result ? '' : ' (모델 없음)'}
                </label>
                <label className="rw-checkbox">
                  <input
                    type="radio"
                    name="rw-model-evidence"
                    checked={editModelAction === 'current'}
                    disabled={!availableModel}
                    onChange={() => setEditModelAction('current')}
                  />
                  현재 선택한 모델 결과 연결
                </label>
                <p className="rw-hint">
                  {availableModel
                    ? `${availableModel.model_key} · ${availableModel.split === 'validation' ? 'Valid' : 'Test'}`
                    : '현재 그래프에서 조회한 모델 결과가 없습니다.'}
                </p>
                <label className="rw-checkbox">
                  <input
                    type="radio"
                    name="rw-model-evidence"
                    checked={editModelAction === 'remove'}
                    onChange={() => setEditModelAction('remove')}
                  />
                  모델 연결 해제
                </label>
                <h4>연결할 현장 관찰</h4>
                {evidenceChoices.map((observation) => {
                  const checked = editObservations.some(
                    (reference) =>
                      reference.observation_id === observation.id &&
                      reference.revision === observation.revision,
                  );

                  const hasOtherVersion = editObservations.some(
                    (reference) => reference.observation_id === observation.id,
                  );

                  return (
                    <label
                      className="rw-observation-choice"
                      key={`${observation.id}:${observation.revision}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`근거 관찰 ${observation.content} · 수정 ${observation.revision}`}
                        checked={checked}
                        disabled={!checked && !hasOtherVersion && editObservations.length >= 50}
                        onChange={(event) =>
                          setEditObservations((current) =>
                            event.target.checked
                              ? [
                                  ...current.filter(
                                    (reference) => reference.observation_id !== observation.id,
                                  ),
                                  {
                                    observation_id: observation.id,
                                    revision: observation.revision,
                                  },
                                ]
                              : current.filter(
                                  (reference) =>
                                    reference.observation_id !== observation.id ||
                                    reference.revision !== observation.revision,
                                ),
                          )
                        }
                      />
                      <span>
                        <strong>{observation.content}</strong>
                        <small>
                          수정 {observation.revision} · {observation.author.display_name}
                        </small>
                      </span>
                    </label>
                  );
                })}
                {!evidenceChoices.length && (
                  <p className="rw-hint">
                    현재 불러온 관찰 중 이 검토 구간과 겹치는 기록이 없습니다.
                  </p>
                )}
                {observationsTotal > observations.length && (
                  <p className="rw-hint">
                    더 오래된 관찰은 아래 관찰 목록에서 불러온 뒤 근거 수정창을 다시 열어주세요.
                  </p>
                )}
                <button className="button secondary" onClick={() => setEditingEvidence(false)}>
                  근거 수정 취소
                </button>
              </fieldset>
            )}
            {detail.status === 'in_progress' ? (
              <>
                <div className="rw-actions">
                  <button
                    className="button secondary"
                    onClick={() => updateRecord('save')}
                    disabled={busy || !dirty}
                  >
                    검토 수정 저장
                  </button>
                  <button
                    className="button primary"
                    onClick={() => updateRecord('complete')}
                    disabled={busy || dirty || !canComplete}
                  >
                    <Check size={16} />
                    검토 완료
                  </button>
                </div>
                <p className="rw-hint">
                  {dirty
                    ? '바꾼 내용을 먼저 저장한 뒤 완료해주세요.'
                    : !canComplete
                      ? '완료하려면 검토 내용과 하나 이상의 근거가 필요해요.'
                      : '판단 보류 상태로도 완료할 수 있어요. 완료가 고장 확정을 뜻하지 않습니다.'}
                </p>
              </>
            ) : (
              <div className="rw-reopen">
                <Field label="다시 여는 이유" htmlFor="rw-reopen-reason">
                  <textarea
                    id="rw-reopen-reason"
                    className="textarea"
                    maxLength={1000}
                    value={reopenReason}
                    onChange={(event) => setReopenReason(event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <button
                  className="button secondary"
                  disabled={busy || !reopenReason.trim()}
                  onClick={() => updateRecord('reopen')}
                >
                  <RotateCcw size={16} />
                  다시 열기
                </button>
              </div>
            )}
            <div className="rw-history-heading">
              <h4>수정 이력</h4>
              <button
                className="button secondary"
                disabled={historyLoading || busy}
                onClick={() => loadHistory()}
              >
                <History size={16} />
                {history ? '수정 이력 새로고침' : '수정 이력 보기'}
              </button>
            </div>
            {historyLoading && <p role="status">수정 이력을 불러오고 있어요.</p>}
            {historyError && <Notice tone="error">{historyError}</Notice>}
            {history?.items.map((item) => (
              <details className="rw-history-item" key={item.revision}>
                <summary>
                  수정 {item.revision} 당시 내용 보기 · {actionText[item.action]} ·{' '}
                  {item.changed_by.display_name} · {actorTime(item.changed_at)}
                </summary>
                <div>
                  <p>
                    {item.snapshot.status === 'completed' ? '검토 완료' : '검토 중'} ·{' '}
                    {judgmentText[item.snapshot.judgment]}
                  </p>
                  {item.reason && <p>다시 연 이유: {item.reason}</p>}
                  <p className="rw-preserve-text">
                    {item.snapshot.conclusion || '검토 내용 미작성'}
                  </p>
                  <SavedEvidence review={item.snapshot} />
                </div>
              </details>
            ))}
            {history && history.items.length < history.total && (
              <button
                className="button secondary"
                disabled={historyLoading}
                onClick={() => loadHistory(true)}
              >
                이력 더 불러오기
              </button>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
