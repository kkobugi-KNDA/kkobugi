import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { axRequest, type ReportJob } from '../lib/ax-api';
import { errorMessage } from '../lib/api';
import { ReportPreview } from './AxAssistantPanel';
import { Notice } from './ui';

export default function GeneratedReports() {
  const { mode, user } = useApp();

  const [jobs, setJobs] = useState<ReportJob[]>([]);

  const [total, setTotal] = useState(0);

  const [loading, setLoading] = useState(false);

  const [selected, setSelected] = useState<ReportJob | null>(null);

  const [error, setError] = useState('');

  const [version, setVersion] = useState(0);

  const detailController = useRef<AbortController | null>(null);

  const nextPageController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    detailController.current?.abort();
    nextPageController.current?.abort();
    setJobs([]);
    setTotal(0);
    setLoading(mode === 'live');
    setSelected(null);
    setError('');
    if (mode === 'live')
      axRequest<{ items: ReportJob[]; total: number }>('/reports', { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted) {
            setJobs(response.items);
            setTotal(response.total);
          }
        })
        .catch((failure) => {
          if (!controller.signal.aborted) setError(errorMessage(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    return () => {
      controller.abort();
      detailController.current?.abort();
      nextPageController.current?.abort();
    };
  }, [mode, user?.id, version]);

  async function loadMore() {
    if (loading || mode !== 'live') return;
    nextPageController.current?.abort();
    const controller = new AbortController();

    nextPageController.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await axRequest<{ items: ReportJob[]; total: number }>(
        `/reports?limit=20&offset=${jobs.length}`,
        { signal: controller.signal },
      );

      if (!controller.signal.aborted) {
        setJobs((previous) => [...previous, ...response.items]);
        setTotal(response.total);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  async function openReport(id: string) {
    detailController.current?.abort();
    const controller = new AbortController();

    detailController.current = controller;
    setError('');
    try {
      const report = await axRequest<ReportJob>(`/reports/${id}`, { signal: controller.signal });

      if (!controller.signal.aborted) setSelected(report);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    }
  }

  return (
    <section className="surface ax-generated-reports">
      <div className="section-heading">
        <div>
          <span className="eyebrow">GENERATED DOCUMENTS</span>
          <h2>AI 안내에서 작성한 보고서</h2>
        </div>
        <button
          className="icon-button"
          aria-label="작성 보고서 새로고침"
          onClick={() => setVersion((previous) => previous + 1)}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {jobs.length ? (
        <div className="ax-report-list">
          {jobs.map((job) => (
            <button
              key={job.id}
              onClick={() => openReport(job.id)}
              disabled={job.status !== 'completed'}
            >
              <FileText size={18} />
              <strong>{job.title}</strong>
              <span>
                {job.status === 'completed'
                  ? '작성 완료 · 미리보기'
                  : job.status === 'failed'
                    ? '작성 실패'
                    : '작성 중'}
              </span>
            </button>
          ))}
        </div>
      ) : loading ? (
        <p className="muted">작성한 보고서를 불러오고 있어요.</p>
      ) : (
        <p className="muted">
          점검 도우미에서 안내를 요청하면 Word와 PDF 보고서가 여기에 저장됩니다.
        </p>
      )}
      {jobs.length < total && (
        <button className="button secondary" disabled={loading} onClick={loadMore}>
          보고서 더 보기 · {jobs.length}/{total}
        </button>
      )}
      <ReportPreview
        job={selected}
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </section>
  );
}
