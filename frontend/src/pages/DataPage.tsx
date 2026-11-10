import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  ChevronRight,
  Database,
  FileSpreadsheet,
  FileUp,
  Layers3,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  Upload,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Drawer,
  EmptyState,
  Field,
  Modal,
  Notice,
  PageHeader,
  Skeleton,
} from '../components/ui';
import { useApp } from '../context/AppContext';
import { useExpertise } from '../context/ExpertiseContext';
import AssistantGuide from '../components/AssistantGuide';
import { inspectCsvFile, suggestLabelValues, type CsvMappingPreview } from '../lib/csv-mapping';
import { DEMO_DATASET_DETAIL } from '../data/demo';
import { api, errorMessage } from '../lib/api';
import { bytes, csvTime, dateTime, number } from '../lib/format';
import type { DatasetDetail, DatasetSummary } from '../types';
import './data-models.css';

export default function DataPage() {
  const { isExpert } = useExpertise();

  const {
    mode,
    datasets,
    datasetsLoading,
    selectedDatasetId,
    setSelectedDatasetId,
    refreshDatasets,
    registerDataset,
    deleteDataset,
    restoreDataset,
    toast,
  } = useApp();

  const [mappingPreview, setMappingPreview] = useState<CsvMappingPreview | null>(null);

  const [mappingPending, setMappingPending] = useState(false);

  const [mappingError, setMappingError] = useState('');

  const mappingController = useRef<AbortController | null>(null);

  const mappingSequence = useRef(0);

  const manualMapping = useRef(new Set<string>());

  const selectedLabelColumn = useRef('');

  const [deleteTarget, setDeleteTarget] = useState<DatasetSummary | null>(null);

  const [deleting, setDeleting] = useState(false);

  const [deleteError, setDeleteError] = useState('');

  const [lastDeleted, setLastDeleted] = useState<DatasetSummary | null>(null);

  const [trashOpen, setTrashOpen] = useState(false);

  const [deletedDatasets, setDeletedDatasets] = useState<DatasetSummary[]>([]);

  const [trashLoading, setTrashLoading] = useState(false);

  const [trashError, setTrashError] = useState('');

  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [detail, setDetail] = useState<DatasetDetail | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false),
    [columnsOpen, setColumnsOpen] = useState(false),
    [query, setQuery] = useState('');
  const [file, setFile] = useState<File | null>(null),
    [timestampColumn, setTimestampColumn] = useState(''),
    [labelColumn, setLabelColumn] = useState('');
  const [normalLabel, setNormalLabel] = useState(''),
    [abnormalLabel, setAbnormalLabel] = useState(''),
    [uploading, setUploading] = useState(false),
    [uploadError, setUploadError] = useState(''),
    [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null),
    uploadController = useRef<AbortController | null>(null);
  useEffect(() => () => uploadController.current?.abort(), []);

  useEffect(() => () => mappingController.current?.abort(), []);

  useEffect(() => {
    if (!trashOpen || mode === 'demo') return;

    const controller = new AbortController();

    setTrashLoading(true);
    setTrashError('');
    api
      .deletedDatasets(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setDeletedDatasets(result.items);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setTrashError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTrashLoading(false);
      });
    return () => controller.abort();
  }, [trashOpen, mode]);

  useEffect(() => {
    if (!selectedDatasetId && datasets.length) setSelectedDatasetId(datasets[0].id);
  }, [datasets, selectedDatasetId, setSelectedDatasetId]);
  useEffect(() => {
    setDetail(null);
    setError('');
    if (!selectedDatasetId) {
      setLoading(false);
      return;
    }
    if (mode === 'demo') {
      setDetail(DEMO_DATASET_DETAIL);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .dataset(selectedDatasetId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setDetail(next);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selectedDatasetId, mode]);

  async function confirmDelete() {
    if (!deleteTarget || mode === 'demo') return;

    const target = deleteTarget;

    setDeleting(true);
    setDeleteError('');
    try {
      await deleteDataset(target.id);
      setLastDeleted(target);
      setDetail((current) => (current?.dataset.id === target.id ? null : current));
      setColumnsOpen(false);
      setDeleteTarget(null);
      toast('CSV를 목록에서 삭제했어요. 삭제한 CSV에서 복원할 수 있어요.', 'success');
    } catch (failure) {
      setDeleteError(errorMessage(failure));
    } finally {
      setDeleting(false);
    }
  }

  async function restore(target: DatasetSummary) {
    if (mode === 'demo') return;
    setRestoringId(target.id);
    setTrashError('');
    try {
      await restoreDataset(target.id);
      setDeletedDatasets((current) => current.filter((dataset) => dataset.id !== target.id));
      setLastDeleted((current) => (current?.id === target.id ? null : current));
      toast(`${target.filename}를 복원했어요.`, 'success');
    } catch (failure) {
      setTrashError(errorMessage(failure));
      toast(errorMessage(failure), 'error');
    } finally {
      setRestoringId(null);
    }
  }

  function chooseFile(next: File | null) {
    setUploadError('');
    if (next && !next.name.toLowerCase().endsWith('.csv')) {
      setUploadError('CSV 파일을 선택해주세요.');
      return;
    }
    if (next && next.size > 200 * 1024 * 1024) {
      setUploadError('200 MiB 이하의 CSV 파일을 선택해주세요.');
      return;
    }
    mappingController.current?.abort();
    mappingSequence.current += 1;
    manualMapping.current.clear();
    selectedLabelColumn.current = '';
    setMappingPreview(null);
    setMappingError('');
    setTimestampColumn('');
    setLabelColumn('');
    setNormalLabel('');
    setAbnormalLabel('');
    setFile(next);
    setMappingPending(Boolean(next));
    if (!next) return;

    const controller = new AbortController();

    const requestSequence = mappingSequence.current;

    mappingController.current = controller;
    inspectCsvFile(next, controller.signal)
      .then((preview) => {
        if (controller.signal.aborted || requestSequence !== mappingSequence.current) return;
        setMappingPreview(preview);
        if (!manualMapping.current.has('timestamp')) setTimestampColumn(preview.timestampColumn);

        const chosenLabel = manualMapping.current.has('label')
          ? selectedLabelColumn.current
          : preview.labelColumn;

        if (!manualMapping.current.has('label')) {
          setLabelColumn(chosenLabel);
          selectedLabelColumn.current = chosenLabel;
        }
        const suggestion = suggestLabelValues(
          preview.values[chosenLabel] || [],
          preview.truncatedValues.includes(chosenLabel),
          chosenLabel,
        );

        if (!manualMapping.current.has('normal')) setNormalLabel(suggestion.normal);
        if (!manualMapping.current.has('abnormal')) setAbnormalLabel(suggestion.abnormal);
      })
      .catch((failure) => {
        if (!controller.signal.aborted && requestSequence === mappingSequence.current)
          setMappingError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && requestSequence === mappingSequence.current)
          setMappingPending(false);
      });
  }

  function chooseLabelColumn(column: string) {
    manualMapping.current.add('label');
    manualMapping.current.delete('normal');
    manualMapping.current.delete('abnormal');
    selectedLabelColumn.current = column;
    setLabelColumn(column);

    const suggestion = suggestLabelValues(
      mappingPreview?.values[column] || [],
      mappingPreview?.truncatedValues.includes(column),
      column,
    );

    setNormalLabel(suggestion.normal);
    setAbnormalLabel(suggestion.abnormal);
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    setUploadError('');
    if (!file) {
      setUploadError('등록할 CSV 파일을 선택해주세요.');
      return;
    }
    if (timestampColumn.trim() === labelColumn.trim()) {
      setUploadError('시각 열과 라벨 열은 서로 달라야 해요.');
      return;
    }
    if (normalLabel === abnormalLabel) {
      setUploadError('Normal과 Abnormal의 원본 라벨 값은 서로 달라야 해요.');
      return;
    }
    if (
      [timestampColumn, labelColumn, normalLabel, abnormalLabel].some(
        (v) => !v.trim() || v !== v.trim(),
      )
    ) {
      setUploadError('열 이름과 라벨 값을 빈칸 없이 입력해주세요. 앞뒤 공백도 확인해주세요.');
      return;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    form.append('timestamp_column', timestampColumn);
    form.append('label_column', labelColumn);
    form.append('normal_label', normalLabel);
    form.append('abnormal_label', abnormalLabel);
    try {
      const result = await api.upload(form, controller.signal);

      if (controller.signal.aborted) return;
      registerDataset(result.dataset);
      setDetail(result);
      setUploadOpen(false);
      setFile(null);
      toast('CSV를 등록했어요. 검사 결과를 확인해주세요.', 'success');
      await refreshDatasets().catch((e) => toast(errorMessage(e), 'error'));
    } catch (e) {
      if (!controller.signal.aborted) setUploadError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setUploading(false);
    }
  }
  const filtered = datasets.filter((d) => d.filename.toLowerCase().includes(query.toLowerCase()));
  const inspection = detail?.inspection;
  const missingCount = inspection
    ? Object.values(inspection.missing_counts).reduce((a, b) => a + b, 0)
    : 0;
  const labelTotal = inspection
    ? Object.values(inspection.label_counts).reduce((a, b) => a + b, 0)
    : 0;

  const labelSuggestion = suggestLabelValues(
    mappingPreview?.values[labelColumn] || [],
    mappingPreview?.truncatedValues.includes(labelColumn),
    labelColumn,
  );

  const mappingMessage = !file
    ? 'CSV를 선택하면 실제 열 이름과 라벨 값을 먼저 읽어볼게요.'
    : mappingPending
      ? '파일을 읽고 있어요. 직접 입력한 값은 덮어쓰지 않아요.'
      : mappingError ||
        (!labelColumn
          ? '판정에 사용할 열을 직접 선택해주세요. 여러 존의 라벨이 있으면 어느 존인지 제가 대신 정하지 않아요.'
          : manualMapping.current.has('normal') || manualMapping.current.has('abnormal')
            ? '직접 지정한 값을 유지하고 있어요. 대소문자와 소수점까지 원본의 판정 값과 같은지 확인해주세요.'
            : labelSuggestion.explanation);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="DATA WORKSPACE"
        title="데이터"
        description="전처리한 CSV를 등록하고, 학습 전에 입력 상태를 확인해요."
      >
        <button
          className="button ghost"
          onClick={() => setTrashOpen(true)}
          disabled={mode === 'demo'}
        >
          <Trash2 size={16} /> 삭제한 CSV
        </button>
        <button
          className="button secondary"
          onClick={() => refreshDatasets().catch((e) => toast(errorMessage(e), 'error'))}
          disabled={datasetsLoading}
        >
          <RefreshCw size={16} className={datasetsLoading ? 'dm-spin' : ''} />
          <span>새로고침</span>
        </button>
        <button
          className="button primary"
          data-tour="data-upload"
          onClick={() => setUploadOpen(true)}
        >
          <Upload size={17} /> CSV 등록
        </button>
      </PageHeader>
      {lastDeleted && (
        <Notice>
          <div className="dm-delete-notice">
            <span>
              <strong>{lastDeleted.filename}</strong>를 목록에서 삭제했어요.
            </span>
            <button
              className="button ghost"
              onClick={() => restore(lastDeleted)}
              disabled={restoringId !== null}
            >
              <Undo2 size={15} /> {restoringId === lastDeleted.id ? '복원 중' : '삭제 취소'}
            </button>
          </div>
        </Notice>
      )}
      {mode === 'demo' && (
        <Notice>
          화면 미리보기예요. 아래 CSV와 검사 값은 예시이며, 실제 파일은 로그인한 계정으로 등록해요.
        </Notice>
      )}
      <div className="dm-data-layout">
        <section className="surface dm-file-panel" data-tour="data-files" aria-label="등록한 CSV">
          <div className="dm-panel-title">
            <h2>
              등록한 CSV <span>{number(datasets.length)}</span>
            </h2>
            <Database size={17} />
          </div>
          <div className="dm-search">
            <Search size={16} />
            <input
              aria-label="CSV 파일 검색"
              placeholder="파일 이름 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="dm-file-list">
            {datasetsLoading && !datasets.length ? (
              <>
                <Skeleton className="dm-file-skeleton" />
                <Skeleton className="dm-file-skeleton" />
              </>
            ) : filtered.length ? (
              filtered.map((d) => (
                <button
                  key={d.id}
                  className={`dm-file-item ${selectedDatasetId === d.id ? 'is-active' : ''}`}
                  onClick={() => setSelectedDatasetId(d.id)}
                >
                  <span className="dm-file-icon">
                    <FileSpreadsheet size={21} />
                  </span>
                  <span className="dm-file-copy">
                    <strong>{d.filename}</strong>
                    <span>
                      {number(d.row_count)}행 · {d.channels.length}개 채널
                    </span>
                    <small>{dateTime(d.created_at)}</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              ))
            ) : (
              <EmptyState
                title={query ? '검색 결과가 없어요' : '등록한 CSV가 없어요'}
                description={
                  query ? '다른 파일 이름으로 검색해보세요.' : '전처리한 파일을 먼저 등록해주세요.'
                }
              />
            )}
          </div>
          <div className="dm-file-foot">
            <span className="dm-dot" /> CSV 원본을 그대로 보관해요
          </div>
        </section>
        <div className="dm-detail-stack" data-tour="data-detail">
          {error && <Notice tone="error">{error}</Notice>}
          {loading ? (
            <section className="surface dm-detail-card">
              <Skeleton className="dm-title-skeleton" />
              <Skeleton className="dm-block-skeleton" />
            </section>
          ) : detail && inspection ? (
            <>
              <section className="surface dm-detail-card">
                <div className="dm-detail-heading">
                  <div className="dm-heading-with-icon">
                    <span className="dm-large-file">
                      <FileSpreadsheet size={25} />
                    </span>
                    <div>
                      <h2>{detail.dataset.filename}</h2>
                      <p>
                        {bytes(detail.dataset.size_bytes)} · 등록{' '}
                        {dateTime(detail.dataset.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="dm-detail-actions">
                    <Badge tone={detail.dataset.status === 'valid' ? 'green' : 'amber'}>
                      {detail.dataset.status === 'valid' ? '입력 검사 통과' : '입력 확인 필요'}
                    </Badge>
                    <button
                      className="icon-button"
                      aria-label={`${detail.dataset.filename} 삭제`}
                      title="CSV 삭제"
                      disabled={mode === 'demo'}
                      onClick={() => {
                        setDeleteTarget(detail.dataset);
                        setDeleteError('');
                      }}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
                <div className="dm-stat-row">
                  <div>
                    <span>전체 행</span>
                    <strong>
                      {number(inspection.row_count)}
                      <small>행</small>
                    </strong>
                  </div>
                  <div>
                    <span>숫자 채널</span>
                    <strong>
                      {number(inspection.channels.length)}
                      <small>개</small>
                    </strong>
                  </div>
                  <div>
                    <span>결측 셀</span>
                    <strong>
                      {number(missingCount)}
                      <small>개</small>
                    </strong>
                  </div>
                  <div>
                    <span>확인 항목</span>
                    <strong>
                      {number(inspection.issues.length)}
                      <small>건</small>
                    </strong>
                  </div>
                </div>
                <div className="dm-time-range">
                  <span>측정 기간</span>
                  <strong>
                    {csvTime(inspection.time_start)} <ArrowRight size={15} />{' '}
                    {csvTime(inspection.time_end)}
                  </strong>
                  <small>
                    {inspection.timezone_mode === 'naive'
                      ? '원본에 시간대 표기 없음'
                      : inspection.timezone_mode === 'mixed'
                        ? '시간대 표기가 섞여 있어요'
                        : '원본 시간대 표기 유지'}
                  </small>
                </div>
                <div className="dm-detail-bottom">
                  <span>
                    시각 <code>{inspection.timestamp_column}</code> · 라벨{' '}
                    <code>{inspection.label_column}</code>
                  </span>
                  <button className="button ghost" onClick={() => setColumnsOpen(true)}>
                    열 구성 보기 <ChevronRight size={15} />
                  </button>
                </div>
              </section>
              <div className="dm-two-col">
                <section className="surface dm-detail-card">
                  <div className="section-heading">
                    <h2>라벨 분포</h2>
                    <Badge>원본 라벨</Badge>
                  </div>
                  <div className="dm-label-bar">
                    {Object.entries(inspection.label_counts).map(([label, count]) => (
                      <span
                        key={label}
                        style={{ width: `${labelTotal ? (count / labelTotal) * 100 : 0}%` }}
                        className={
                          label === detail.dataset.normal_label
                            ? 'is-normal'
                            : label === detail.dataset.abnormal_label
                              ? 'is-abnormal'
                              : 'is-unknown'
                        }
                        title={`${label}: ${count}행`}
                      />
                    ))}
                  </div>
                  <div className="dm-label-list">
                    {Object.entries(inspection.label_counts).map(([label, count]) => (
                      <div key={label}>
                        <span>
                          <i
                            className={
                              label === detail.dataset.normal_label
                                ? 'is-normal'
                                : label === detail.dataset.abnormal_label
                                  ? 'is-abnormal'
                                  : 'is-unknown'
                            }
                          />
                          {label === detail.dataset.normal_label
                            ? 'Normal'
                            : label === detail.dataset.abnormal_label
                              ? 'Abnormal'
                              : '미지정'}{' '}
                          <code>{label}</code>
                        </span>
                        <strong>
                          {number(count)}
                          <small>행</small>
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="dm-caption">
                    라벨은 CSV에 지정된 값이에요. 입력 검사 통과가 정상 운전을 뜻하지는 않아요.
                  </p>
                </section>
                <section className="surface dm-detail-card">
                  <div className="section-heading">
                    <h2>검사 결과</h2>
                    <Check size={17} />
                  </div>
                  {inspection.issues.length ? (
                    <ul className="dm-issues">
                      {inspection.issues.map((issue, i) => (
                        <li key={`${issue.code}-${i}`}>
                          <Badge tone={issue.severity === 'error' ? 'red' : 'amber'}>
                            {issue.severity === 'error' ? '확인' : '참고'}
                          </Badge>
                          <div>
                            <p>{issue.message}</p>
                            {issue.column && <code>{issue.column}</code>}
                            <small>{number(issue.count)}개</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="dm-inspection-ok">
                      <span>
                        <Check size={21} />
                      </span>
                      <strong>확인할 입력 오류가 없어요</strong>
                      <p>시각·숫자 채널·라벨 형식을 확인했어요.</p>
                    </div>
                  )}
                  <div className="dm-small-checks">
                    <span>
                      시각 중복 <strong>{number(inspection.duplicate_timestamp_count)}</strong>
                    </span>
                    <span>
                      시각 역순 <strong>{number(inspection.out_of_order_count)}</strong>
                    </span>
                    <span>
                      라벨 오류 <strong>{number(inspection.invalid_label_count)}</strong>
                    </span>
                  </div>
                </section>
              </div>
              <section className="surface dm-detail-card">
                <div className="section-heading">
                  <div>
                    <h2>처음 5행</h2>
                    <p className="dm-caption">업로드한 원본의 미리보기</p>
                  </div>
                  <Link className="button secondary" to="/models">
                    모델 학습으로 <ArrowRight size={15} />
                  </Link>
                </div>
                <div className="dm-table-scroll">
                  <table className="dm-table dm-preview-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        {inspection.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {inspection.preview.map((row, i) => (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          {inspection.columns.map((c) => (
                            <td key={c}>{row[c] ?? '—'}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {inspection.preview_truncated && (
                  <p className="dm-caption">긴 셀은 처음 128자까지만 표시했어요.</p>
                )}
              </section>
            </>
          ) : (
            !loading &&
            !error && (
              <section className="surface">
                <EmptyState
                  icon={Database}
                  title="CSV를 선택해주세요"
                  description="등록한 데이터의 시각 범위와 라벨, 채널을 확인할 수 있어요."
                  action={
                    <button className="button primary" onClick={() => setUploadOpen(true)}>
                      <Upload size={16} /> CSV 등록
                    </button>
                  }
                />
              </section>
            )
          )}
        </div>
      </div>
      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        title="CSV를 삭제할까요?"
        description={deleteTarget?.filename}
        footer={
          <>
            <button
              className="button secondary"
              disabled={deleting}
              onClick={() => setDeleteTarget(null)}
            >
              취소
            </button>
            <button className="button primary" disabled={deleting} onClick={confirmDelete}>
              <Trash2 size={16} /> {deleting ? '삭제 중' : '목록에서 삭제'}
            </button>
          </>
        }
      >
        <p>학습할 CSV 목록에서 제외해요. 원본 파일과 기존 학습·판단·점검 기록은 보존해요.</p>
        <p>
          나중에 <strong>삭제한 CSV</strong>에서 복원할 수 있어요.
        </p>
        {deleteError && <Notice tone="error">{deleteError}</Notice>}
      </Modal>
      <Modal
        open={trashOpen}
        onOpenChange={setTrashOpen}
        title="삭제한 CSV"
        description="보관된 CSV를 복원하면 다시 학습 목록에서 선택할 수 있어요."
      >
        {trashError && <Notice tone="error">{trashError}</Notice>}
        {trashLoading ? (
          <Skeleton className="dm-block-skeleton" />
        ) : deletedDatasets.length ? (
          <div className="dm-form-stack">
            {deletedDatasets.map((dataset) => (
              <div className="dm-deleted-row" key={dataset.id}>
                <FileSpreadsheet size={20} />
                <div>
                  <strong>{dataset.filename}</strong>
                  <small>{number(dataset.row_count)}행</small>
                </div>
                <button
                  className="button secondary"
                  onClick={() => restore(dataset)}
                  disabled={restoringId !== null}
                  aria-label={`${dataset.filename} 복원`}
                >
                  <Undo2 size={16} /> {restoringId === dataset.id ? '복원 중' : '복원'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          !trashError && <EmptyState title="삭제한 CSV가 없어요" />
        )}
      </Modal>
      <Modal
        open={uploadOpen}
        onOpenChange={(open) => {
          if (!uploading) {
            setUploadOpen(open);
            setUploadError('');
          }
        }}
        title="CSV 등록"
        description="전처리한 UTF-8 CSV와 원본의 열·라벨 값을 지정해주세요."
        className="dm-upload-modal"
        footer={
          <>
            <button
              className="button secondary"
              disabled={uploading}
              onClick={() => setUploadOpen(false)}
            >
              취소
            </button>
            <button
              className="button primary"
              type="submit"
              form="dm-upload-form"
              disabled={uploading || mappingPending || mode === 'demo'}
            >
              {uploading ? <RefreshCw size={16} className="dm-spin" /> : <FileUp size={17} />}{' '}
              {uploading ? '등록·검사 중' : '등록하고 검사'}
            </button>
          </>
        }
      >
        <form id="dm-upload-form" onSubmit={upload} className="dm-form-stack">
          {mode === 'demo' && (
            <Notice>
              CSV 등록은 로그인 후 사용할 수 있어요. 미리보기에서는 입력 화면만 확인할 수 있어요.
            </Notice>
          )}
          <input
            ref={fileInput}
            id="dm-file-input"
            aria-label="등록할 CSV 파일"
            type="file"
            accept=".csv,text/csv"
            className="dm-visually-hidden"
            disabled={uploading || mode === 'demo'}
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className={`dm-dropzone ${dragging ? 'is-dragging' : ''}`}
            disabled={uploading || mode === 'demo'}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (!uploading && mode !== 'demo') chooseFile(e.dataTransfer.files[0] ?? null);
            }}
          >
            <span>
              <Upload size={25} />
            </span>
            <strong>{file ? file.name : 'CSV를 끌어 놓거나 눌러서 선택'}</strong>
            <small>{file ? bytes(file.size) : 'UTF-8 · 최대 200 MiB · 전처리 완료 파일'}</small>
          </button>
          {file && (
            <button
              type="button"
              className="button ghost dm-remove-file"
              disabled={uploading}
              onClick={() => {
                chooseFile(null);
                if (fileInput.current) fileInput.current.value = '';
              }}
            >
              <X size={14} /> 파일 선택 해제
            </button>
          )}
          <div className="dm-form-grid">
            <Field label={isExpert ? '시각 컬럼' : '시간이 기록된 열'} htmlFor="dm-time-col">
              <input
                id="dm-time-col"
                className="input"
                value={timestampColumn}
                list="dm-csv-columns"
                placeholder="파일 선택 후 확인"
                onChange={(e) => {
                  manualMapping.current.add('timestamp');
                  setTimestampColumn(e.target.value);
                }}
                required
                disabled={uploading}
              />
            </Field>
            <Field
              label={isExpert ? '라벨 컬럼' : '정상·이상 판정이 있는 열'}
              htmlFor="dm-label-col"
            >
              <input
                id="dm-label-col"
                className="input"
                value={labelColumn}
                list="dm-label-columns"
                placeholder="판정할 열을 선택하세요"
                onChange={(e) => chooseLabelColumn(e.target.value)}
                required
                disabled={uploading}
              />
            </Field>
          </div>
          <datalist id="dm-csv-columns">
            {mappingPreview?.columns.map((column) => (
              <option key={column} value={column} />
            ))}
          </datalist>
          <datalist id="dm-label-columns">
            {mappingPreview?.columns.map((column) => (
              <option key={column} value={column} />
            ))}
          </datalist>
          <datalist id="dm-label-values">
            {mappingPreview?.values[labelColumn]?.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          {mappingPreview && mappingPreview.labelCandidates.length > 1 && (
            <div className="dm-mapping-candidates">
              <span>판정 열 후보</span>
              {mappingPreview.labelCandidates.map((column) => (
                <button
                  type="button"
                  className="button ghost"
                  key={column}
                  onClick={() => chooseLabelColumn(column)}
                  disabled={uploading}
                >
                  {column}
                </button>
              ))}
            </div>
          )}
          <div className="dm-form-grid">
            <Field label={isExpert ? '정상 라벨링 값' : '정상으로 표시된 값'} htmlFor="dm-normal">
              <input
                id="dm-normal"
                className="input"
                value={normalLabel}
                list="dm-label-values"
                placeholder="원본 값 확인 필요"
                onChange={(e) => {
                  manualMapping.current.add('normal');
                  setNormalLabel(e.target.value);
                }}
                required
                disabled={uploading}
              />
            </Field>
            <Field label={isExpert ? '이상 라벨링 값' : '이상으로 표시된 값'} htmlFor="dm-abnormal">
              <input
                id="dm-abnormal"
                className="input"
                value={abnormalLabel}
                list="dm-label-values"
                placeholder="원본 값 확인 필요"
                onChange={(e) => {
                  manualMapping.current.add('abnormal');
                  setAbnormalLabel(e.target.value);
                }}
                required
                disabled={uploading}
              />
            </Field>
          </div>
          <div className="dm-mapping-guide">
            <AssistantGuide
              id="csv-upload-mapping"
              title="원본 값을 그대로 연결해요"
              message={mappingMessage}
              details={
                mappingPreview
                  ? [
                      `${mappingPreview.partial ? '일부 미리보기' : '미리보기'}: ${number(mappingPreview.rowCount)}행을 읽었어요. 최대 2 MiB·10,000행까지만 읽으며 등록 후 서버가 전체를 검사해요.`,
                      `구분자: ${mappingPreview.delimiter === ';' ? '세미콜론(;)' : mappingPreview.delimiter === '\t' ? '탭' : mappingPreview.delimiter === ',' ? '쉼표(,)' : mappingPreview.delimiter}. 원본 CSV는 바꾸지 않아요.`,
                      `확인한 판정 값: ${(mappingPreview.values[labelColumn] || []).join(', ') || '열 선택 필요'}`,
                    ]
                  : []
              }
              context={{
                datasetId: null,
                runId: null,
                modelKey: null,
                selectedSignal: `아직 등록하지 않은 CSV의 로컬 미리보기 안내. ${mappingMessage}`,
                contextKey: `csv-upload:${file?.name || 'empty'}:${labelColumn}`,
              }}
              question="CSV의 시간 열과 정상·이상 값을 어떻게 지정하면 돼?"
            />
          </div>
          <Notice>
            시각·라벨 이외의 열은 숫자 채널로 검사해요. 등록 과정에서 결측을 채우거나 행을 정렬하지
            않아요.
          </Notice>
          {uploadError && <Notice tone="error">{uploadError}</Notice>}
        </form>
      </Modal>
      <Drawer
        open={columnsOpen}
        onOpenChange={setColumnsOpen}
        title="열 구성"
        description={detail?.dataset.filename}
      >
        <div className="dm-form-stack">
          <Notice>시각·라벨을 제외한 열이 모델 입력 채널이에요.</Notice>
          {inspection?.columns.map((c) => (
            <div className="dm-column-row" key={c}>
              <span className="dm-column-icon">
                <Layers3 size={17} />
              </span>
              <code>{c}</code>
              <Badge
                tone={
                  c === inspection.timestamp_column
                    ? 'blue'
                    : c === inspection.label_column
                      ? 'amber'
                      : 'slate'
                }
              >
                {c === inspection.timestamp_column
                  ? '시각'
                  : c === inspection.label_column
                    ? '라벨'
                    : '숫자 채널'}
              </Badge>
              <small>결측 {number(inspection.missing_counts[c] ?? 0)}</small>
            </div>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
