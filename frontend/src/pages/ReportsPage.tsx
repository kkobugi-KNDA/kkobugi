import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Download, FileText, Printer, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, errorMessage } from '../lib/api';
import { observationForDisplay, reviewApi, type SavedObservation } from '../lib/review-api';
import { csvTime, number, percent } from '../lib/format';
import { DEMO_RESULTS } from '../data/demo';
import { Badge, EmptyState, Notice, PageHeader } from '../components/ui';
import GeneratedReports from '../components/GeneratedReports';
import { judgmentText, observationStorageKey, readObservationDrafts } from './ReviewPage';
import type { Observation, RunResults } from '../types';
import './review.css';

export default function ReportsPage() {
  const { user, mode, datasets, runs, selectedDatasetId, selectedRunId } = useApp();
  const dataset = datasets.find((d) => d.id === selectedDatasetId) || datasets[0];
  const run =
    runs.find((r) => r.id === selectedRunId && r.dataset_id === dataset?.id) ||
    runs.find((r) => r.dataset_id === dataset?.id);
  const [drafts, setDrafts] = useState<Observation[]>([]),
    [results, setResults] = useState<RunResults | null>(null),
    [error, setError] = useState('');
  const [generatedAt, setGeneratedAt] = useState(() => new Date());
  const [saved, setSaved] = useState<SavedObservation[]>([]),
    [savedTotal, setSavedTotal] = useState(0),
    [observationsLoading, setObservationsLoading] = useState(false),
    [observationsError, setObservationsError] = useState(''),
    [observationsVersion, setObservationsVersion] = useState(0);
  const observationController = useRef<AbortController | null>(null);
  const storageKey = observationStorageKey(user?.id ?? 0, mode);
  useEffect(() => {
    const refresh = () => setDrafts(readObservationDrafts(storageKey));
    refresh();
    window.addEventListener('kkobugi:drafts', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('kkobugi:drafts', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [storageKey]);
  useEffect(() => {
    const refresh = () => setObservationsVersion((value) => value + 1);
    window.addEventListener('kkobugi:observations', refresh);
    return () => window.removeEventListener('kkobugi:observations', refresh);
  }, []);
  useEffect(() => {
    setSaved([]);
    setSavedTotal(0);
    setObservationsError('');
    if (mode !== 'live' || !dataset?.id) return;
    const controller = new AbortController();
    observationController.current = controller;
    setObservationsLoading(true);
    reviewApi
      .list(dataset.id, 0, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setSaved(result.items);
          setSavedTotal(result.total);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setObservationsError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setObservationsLoading(false);
      });
    return () => {
      controller.abort();
      observationController.current?.abort();
      setObservationsLoading(false);
    };
  }, [dataset?.id, mode, user?.id, observationsVersion]);
  const loadMore = async () => {
    if (!dataset || observationsLoading) return;
    const controller = new AbortController();
    observationController.current = controller;
    setObservationsLoading(true);
    setObservationsError('');
    try {
      const result = await reviewApi.list(dataset.id, saved.length, controller.signal);
      if (!controller.signal.aborted) {
        setSaved((current) => [...current, ...result.items]);
        setSavedTotal(result.total);
      }
    } catch (error) {
      if (!controller.signal.aborted) setObservationsError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setObservationsLoading(false);
    }
  };
  useEffect(() => {
    setResults(null);
    setError('');
    if (!run || run.status !== 'completed') return;
    if (mode === 'demo') {
      setResults(DEMO_RESULTS);
      return;
    }
    const controller = new AbortController();
    api
      .results(run.id, 'f1', controller.signal)
      .then(setResults)
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [run?.id, run?.status, mode]);
  const legacy = useMemo(
    () => drafts.filter((d) => d.datasetId === dataset?.id),
    [drafts, dataset?.id],
  );
  const included = mode === 'live' ? saved.map(observationForDisplay) : legacy;
  const canExport =
    !!dataset &&
    !observationsLoading &&
    !observationsError &&
    (mode === 'demo' || saved.length === savedTotal);
  const download = () => {
    if (!dataset || !canExport) return;
    const content = [
      '꼬부기 | 펌프 데이터 검토 기록',
      `작성 시각: ${generatedAt.toLocaleString('ko-KR')}`,
      `작성자: ${user?.display_name || ''}`,
      `데이터: ${dataset.filename}`,
      `원본 행 수: ${dataset.row_count}`,
      `데이터 ID: ${dataset.id}`,
      `모드: ${mode === 'demo' ? '화면 미리보기 — 예시 데이터와 지표' : '연결된 계정의 업로드 데이터'}`,
      '',
      '모델 비교 · Valid',
      ...(results?.items.map(
        (item) =>
          `${item.display_name}: F1 ${percent(item.validation_metrics.f1)} / Precision ${percent(item.validation_metrics.precision)} / Recall ${percent(item.validation_metrics.recall)} / Accuracy ${percent(item.validation_metrics.accuracy)}`,
      ) || ['완료된 모델 비교 결과 없음']),
      '',
      `직접 남긴 관찰 · ${mode === 'live' ? '내 계정에 저장된 서버 기록' : '미리보기 임시 초안'}`,
      ...(included.length
        ? included.flatMap((draft, i) =>
            [
              `${i + 1}. ${draft.channel} | ${judgmentText[draft.judgment]}`,
              `${draft.start} ~ ${draft.end}`,
              draft.location && `관련 위치·기록: ${draft.location}`,
              mode === 'live' &&
                `관찰 ID: ${draft.id} / 수정 번호: ${saved.find((item) => item.id === draft.id)?.revision}`,
              draft.text,
              '',
            ].filter(Boolean),
          )
        : ['관찰 기록 없음']),
      '',
      '이 문서는 CSV, 모델 비교 결과, 작성자의 관찰을 함께 정리한 기록입니다. 고장 원인이나 정비 필요성을 자동 확정하지 않습니다. 문서 자체는 서버에 저장하지 않았습니다.',
    ];
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + content.join('\n')], { type: 'text/plain;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `kkobugi-review-${generatedAt.toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="page-stack rv-page">
      <PageHeader
        eyebrow="REVIEW NOTES"
        title="검토 기록"
        description="모델 결과와 직접 남긴 관찰을 구분해 한 문서로 확인합니다."
      >
        <button className="button secondary" disabled={!canExport} onClick={download}>
          <Download size={16} />
          텍스트 저장
        </button>
        <button className="button primary" disabled={!canExport} onClick={() => window.print()}>
          <Printer size={16} />
          인쇄 · PDF
        </button>
      </PageHeader>
      <GeneratedReports />
      <Notice>
        {mode === 'live'
          ? '내 계정에 저장된 관찰을 불러옵니다. 다른 계정과 공유되지 않습니다.'
          : '관찰은 미리보기 임시 초안이며 이 브라우저에만 저장됩니다.'}{' '}
        RAG 보고서 생성과 문서의 서버 저장은 아직 연결되지 않았어요.
      </Notice>
      {mode === 'live' && legacy.length > 0 && (
        <Notice>
          이 브라우저의 이전 초안 {legacy.length}개는 그대로 보관되어 있습니다. 아래 문서에는 내
          계정에 저장된 관찰만 넣습니다.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {observationsError && (
        <Notice tone="error">
          {observationsError}
          <button
            className="button secondary rv-conflict-button"
            onClick={() => setObservationsVersion((value) => value + 1)}
          >
            다시 불러오기
          </button>
        </Notice>
      )}
      {!dataset ? (
        <section className="surface">
          <EmptyState
            icon={FileText}
            title="정리할 데이터가 없습니다"
            description="CSV를 등록하고 그래프에서 관찰을 남겨주세요."
            action={
              <Link to="/data" className="button primary">
                데이터 등록
              </Link>
            }
          />
        </section>
      ) : (
        <section className="rv-report-layout">
          <article className="surface rv-document rv-printable">
            <header className="rv-document-head">
              <div className="eyebrow">KKOBUGI / REVIEW</div>
              <Badge tone={mode === 'demo' ? 'amber' : 'slate'}>
                {mode === 'demo' ? '미리보기 예시' : '검토 초안'}
              </Badge>
              <h2>펌프 데이터 검토 기록</h2>
              <p>{dataset.filename}</p>
              <div className="rv-document-byline">
                <span>{user?.display_name}</span>
                <span>{generatedAt.toLocaleString('ko-KR')}</span>
              </div>
            </header>
            <section className="rv-document-section">
              <div className="rv-document-section-number">01</div>
              <div>
                <h3>데이터</h3>
                <dl className="rv-document-facts">
                  <div>
                    <dt>파일</dt>
                    <dd>{dataset.filename}</dd>
                  </div>
                  <div>
                    <dt>행 · 채널 수</dt>
                    <dd>
                      {number(dataset.row_count)}행 · {dataset.channels.length}채널
                    </dd>
                  </div>
                  <div>
                    <dt>시간열</dt>
                    <dd>{dataset.timestamp_column}</dd>
                  </div>
                  <div>
                    <dt>라벨</dt>
                    <dd>
                      {dataset.normal_label} / {dataset.abnormal_label}
                    </dd>
                  </div>
                  <div>
                    <dt>검사 상태</dt>
                    <dd>{dataset.status === 'valid' ? '입력 검사 통과' : '입력 확인 필요'}</dd>
                  </div>
                  <div>
                    <dt>원본 식별</dt>
                    <dd className="rv-mono">{dataset.sha256}</dd>
                  </div>
                </dl>
              </div>
            </section>
            <section className="rv-document-section">
              <div className="rv-document-section-number">02</div>
              <div>
                <h3>
                  모델 비교 결과 <span>Valid</span>
                </h3>
                {results?.items.length ? (
                  <div className="rv-table-scroll">
                    <table className="rv-report-table">
                      <thead>
                        <tr>
                          <th>모델</th>
                          <th>F1</th>
                          <th>Precision</th>
                          <th>Recall</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.items.map((item) => (
                          <tr key={item.model_key}>
                            <td>
                              {item.display_name}
                              {run?.selected_model === item.model_key && (
                                <span className="rv-selected-model">선택</span>
                              )}
                            </td>
                            <td>{percent(item.validation_metrics.f1)}</td>
                            <td>{percent(item.validation_metrics.precision)}</td>
                            <td>{percent(item.validation_metrics.recall)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="rv-document-note">
                      같은 시간 분할의 Valid 결과입니다. Test 평가와 고장 진단을 뜻하지 않습니다.
                      {mode === 'demo' && ' 수치는 화면 미리보기용 예시입니다.'}
                    </p>
                  </div>
                ) : (
                  <p className="rv-document-note">이 데이터에 완료된 모델 비교 결과가 없습니다.</p>
                )}
              </div>
            </section>
            <section className="rv-document-section">
              <div className="rv-document-section-number">03</div>
              <div>
                <h3>
                  직접 남긴 관찰{' '}
                  <span>
                    {included.length}건
                    {mode === 'live' && included.length < savedTotal && ` / 전체 ${savedTotal}건`}
                  </span>
                </h3>
                {included.length ? (
                  included.map((draft, i) => (
                    <article className="rv-document-observation" key={draft.id}>
                      <div>
                        <strong>
                          {String(i + 1).padStart(2, '0')} / {draft.channel}
                        </strong>
                        <Badge
                          tone={
                            draft.judgment === 'candidate'
                              ? 'amber'
                              : draft.judgment === 'normal'
                                ? 'green'
                                : 'slate'
                          }
                        >
                          {judgmentText[draft.judgment]}
                        </Badge>
                      </div>
                      <time>
                        {csvTime(draft.start)} — {csvTime(draft.end)}
                      </time>
                      <p>{draft.text}</p>
                      {draft.location && <small>관련 위치·기록: {draft.location}</small>}
                      {mode === 'live' && (
                        <small>
                          수정 {saved.find((item) => item.id === draft.id)?.revision} · 내 계정에
                          저장
                        </small>
                      )}
                    </article>
                  ))
                ) : (
                  <p className="rv-document-note">
                    {observationsLoading
                      ? '저장한 관찰을 불러오고 있어요.'
                      : observationsError
                        ? '관찰을 불러오지 못했습니다. 오류를 확인하고 다시 불러와주세요.'
                        : '남긴 관찰이 없습니다. 구간 검토에서 노란 구간을 선택하고 기록해주세요.'}
                  </p>
                )}
                {mode === 'live' && saved.length < savedTotal && (
                  <>
                    <p className="rv-document-note">
                      아직 모든 기록을 불러오지 않았어요. 전체 기록을 불러오면 문서를 저장·인쇄할 수
                      있습니다.
                    </p>
                    <button
                      className="button secondary rv-load-more"
                      disabled={observationsLoading}
                      onClick={loadMore}
                    >
                      {observationsLoading ? '불러오는 중' : '나머지 관찰 불러오기'}
                    </button>
                  </>
                )}
              </div>
            </section>
            <footer className="rv-document-footer">
              CSV 라벨 · 모델 결과 · 사람의 관찰은 서로 다른 정보입니다.
              <br />
              고장 원인과 정비 필요성은 기록과 현장 확인을 바탕으로 판단해주세요.
            </footer>
          </article>
          <aside className="rv-report-aside">
            <section className="surface rv-aside-card">
              <FileText size={23} />
              <h3>필요한 부분만 남기세요</h3>
              <p>
                선택한 데이터의 모델 비교와 관찰이 담깁니다. 비용 가정은 비용 비교에서 따로 확인할
                수 있어요.
              </p>
              <Link to="/review" className="button secondary">
                관찰 더 남기기
                <ArrowUpRight size={15} />
              </Link>
            </section>
            <button
              className="rv-document-refresh"
              onClick={() => {
                setGeneratedAt(new Date());
                setObservationsVersion((value) => value + 1);
              }}
            >
              <RefreshCw size={14} />
              저장한 기록 새로 고침
            </button>
          </aside>
        </section>
      )}
    </div>
  );
}
