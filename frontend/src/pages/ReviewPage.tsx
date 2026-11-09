import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Papa from 'papaparse';
import {
  ArrowUpRight,
  ChartNoAxesCombined,
  Check,
  FileText,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, ApiError, errorMessage } from '../lib/api';
import {
  displayJudgment,
  observationForDisplay,
  reviewApi,
  savedJudgment,
  type SavedObservation,
} from '../lib/review-api';
import { csvTime, number } from '../lib/format';
import { DEMO_DATASET_DETAIL, demoSeries } from '../data/demo';
import { Badge, EmptyState, Field, Modal, Notice, PageHeader } from '../components/ui';
import TimeSeriesChart, {
  createLabelIntervalCollector,
  csvTimestampToNumber,
  type SelectedRange,
} from '../components/TimeSeriesChart';
import type { ChartPoint, DatasetDetail, Observation } from '../types';
import './review.css';

export function observationStorageKey(userId: number, mode: string) {
  return `kkobugi:observations:v1:${mode}:${userId}`;
}
export function readObservationDrafts(key: string): Observation[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value)
      ? value.filter(
          (item): item is Observation =>
            !!item &&
            typeof item.id === 'string' &&
            typeof item.text === 'string' &&
            typeof item.datasetId === 'string' &&
            typeof item.channel === 'string' &&
            typeof item.start === 'string' &&
            typeof item.end === 'string' &&
            typeof item.createdAt === 'string' &&
            ['pending', 'candidate', 'normal'].includes(item.judgment),
        )
      : [];
  } catch {
    return [];
  }
}
export function writeObservationDrafts(key: string, drafts: Observation[]) {
  localStorage.setItem(key, JSON.stringify(drafts));
  window.dispatchEvent(new Event('kkobugi:drafts'));
}
export const judgmentText: Record<Observation['judgment'], string> = {
  pending: '판단 보류',
  candidate: '이상 후보',
  normal: '정상으로 판단',
};
interface SeriesState {
  points: ChartPoint[];
  sourceRows: number;
  validValues: number;
  missingValues: number;
  abnormalRows: number;
  min: number | null;
  max: number | null;
  sampled: boolean;
  labelIntervals: SelectedRange[];
  labelIntervalsTruncated: boolean;
}
const emptySeries: SeriesState = {
  points: [],
  sourceRows: 0,
  validValues: 0,
  missingValues: 0,
  abnormalRows: 0,
  min: null,
  max: null,
  sampled: false,
  labelIntervals: [],
  labelIntervalsTruncated: false,
};

export default function ReviewPage() {
  const { user, mode, datasets, selectedDatasetId, setSelectedDatasetId, toast } = useApp();
  const datasetId = selectedDatasetId || datasets[0]?.id || null;
  const [detail, setDetail] = useState<DatasetDetail | null>(null),
    [channel, setChannel] = useState('');
  const [file, setFile] = useState<File | null>(null),
    [series, setSeries] = useState<SeriesState>(emptySeries);
  const [loading, setLoading] = useState(false),
    [parsing, setParsing] = useState(false),
    [error, setError] = useState('');
  const [selection, setSelection] = useState<SelectedRange | null>(null),
    [recordOpen, setRecordOpen] = useState(false);
  const [location, setLocation] = useState(''),
    [text, setText] = useState(''),
    [judgment, setJudgment] = useState<Observation['judgment']>('pending');
  const storageKey = observationStorageKey(user?.id ?? 0, mode);
  const [drafts, setDrafts] = useState<Observation[]>([]);
  const parserRef = useRef<Papa.Parser | null>(null);
  const [saved, setSaved] = useState<SavedObservation[]>([]),
    [savedTotal, setSavedTotal] = useState(0),
    [observationsLoading, setObservationsLoading] = useState(false),
    [observationsError, setObservationsError] = useState('');
  const [observationsVersion, setObservationsVersion] = useState(0),
    [editing, setEditing] = useState<SavedObservation | null>(null),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(''),
    [conflict, setConflict] = useState(false);
  const observationController = useRef<AbortController | null>(null);
  const [originalLabelIntervals, setOriginalLabelIntervals] = useState<SelectedRange[]>([]),
    [originalLabelTotal, setOriginalLabelTotal] = useState(0),
    [labelStatus, setLabelStatus] = useState('');
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
    if (mode !== 'live' || !datasetId) return;
    const controller = new AbortController();
    observationController.current = controller;
    setObservationsLoading(true);
    reviewApi
      .list(datasetId, 0, controller.signal)
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
  }, [datasetId, mode, user?.id, observationsVersion]);
  const loadMoreObservations = async () => {
    if (!datasetId || observationsLoading) return;
    const controller = new AbortController();
    observationController.current = controller;
    setObservationsLoading(true);
    setObservationsError('');
    try {
      const result = await reviewApi.list(datasetId, saved.length, controller.signal);
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
    setOriginalLabelIntervals([]);
    setOriginalLabelTotal(0);
    setLabelStatus('');
    if (mode !== 'live' || !datasetId) return;
    const controller = new AbortController();
    setLabelStatus('CSV 라벨 구간을 불러오고 있어요.');
    reviewApi
      .labels(datasetId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setOriginalLabelIntervals(
          result.items.map((item) => ({
            start: {
              time: csvTimestampToNumber(item.start_time),
              timestamp: item.start_time,
              value: null,
              label: result.abnormal_label,
            },
            end: {
              time: csvTimestampToNumber(item.end_time),
              timestamp: item.end_time,
              value: null,
              label: result.abnormal_label,
            },
          })),
        );
        setOriginalLabelTotal(result.total);
        setLabelStatus(
          result.cadence_seconds == null && result.total > 0
            ? '반복 관측 간격을 확인할 수 없어 라벨이 있는 각각의 관측 시각을 표시합니다.'
            : '',
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setLabelStatus(`라벨 구간을 불러오지 못했어요. ${errorMessage(error)}`);
      });
    return () => controller.abort();
  }, [datasetId, mode]);
  useEffect(() => {
    setSelection(null);
    setDetail(null);
    setFile(null);
    setSeries(emptySeries);
    setError('');
    if (!datasetId) return;
    if (mode === 'demo') {
      setDetail(DEMO_DATASET_DETAIL);
      setChannel((current) =>
        DEMO_DATASET_DETAIL.dataset.channels.includes(current)
          ? current
          : DEMO_DATASET_DETAIL.dataset.channels[0],
      );
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      api.dataset(datasetId, controller.signal),
      api.datasetFile(datasetId, controller.signal),
    ])
      .then(([result, csv]) => {
        if (controller.signal.aborted) return;
        setDetail(result);
        setChannel((current) =>
          result.dataset.channels.includes(current) ? current : result.dataset.channels[0] || '',
        );
        setFile(csv);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      setLoading(false);
    };
  }, [datasetId, mode]);
  useEffect(() => {
    setSelection(null);
    setSeries(emptySeries);
    setError('');
    if (!detail || !channel) return;
    if (mode === 'demo') {
      const points = demoSeries(channel),
        values = points.flatMap((p) => (p.value == null ? [] : [p.value])),
        collector = createLabelIntervalCollector(detail.dataset.abnormal_label);
      points.forEach(collector.push);
      const labels = collector.finish();
      setSeries({
        points,
        sourceRows: points.length,
        validValues: values.length,
        missingValues: 0,
        abnormalRows: points.filter((p) => p.label === detail.dataset.abnormal_label).length,
        min: Math.min(...values),
        max: Math.max(...values),
        sampled: false,
        labelIntervals: labels.intervals,
        labelIntervalsTruncated: labels.truncated,
      });
      return;
    }
    if (!file) return;
    if (
      detail.inspection.out_of_order_count ||
      detail.inspection.invalid_timestamp_count ||
      detail.inspection.timezone_mode === 'mixed'
    ) {
      setError(
        '시간열을 먼저 확인해주세요. 순서가 뒤바뀌거나 해석할 수 없는 시각이 있으면 그래프를 그리지 않습니다. 데이터 페이지의 검사 결과를 확인해주세요.',
      );
      return;
    }
    let active = true,
      rows = 0,
      valid = 0,
      missing = 0,
      abnormal = 0,
      min = Infinity,
      max = -Infinity;
    const bucketSize = Math.max(1, Math.ceil(detail.dataset.row_count / 2500));
    const sampled: ChartPoint[] = [];
    let bucket: ChartPoint[] = [],
      previous: ChartPoint | null = null,
      transitions = 0;
    const collector = createLabelIntervalCollector(detail.dataset.abnormal_label);
    const flush = () => {
      if (!bucket.length) return;
      const numeric = bucket.filter((p) => p.value != null);
      const chosen = [
        bucket[0],
        bucket[bucket.length - 1],
        ...(numeric.length
          ? [
              numeric.reduce((a, b) => (a.value! < b.value! ? a : b)),
              numeric.reduce((a, b) => (a.value! > b.value! ? a : b)),
            ]
          : []),
        ...(bucket.some((p) => p.value == null) ? [bucket.find((p) => p.value == null)!] : []),
      ];
      sampled.push(...Array.from(new Set(chosen)));
      bucket = [];
    };
    setParsing(true);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      worker: true,
      chunkSize: 1024 * 1024,
      chunk(result, parser) {
        parserRef.current = parser;
        if (!active) {
          parser.abort();
          return;
        }
        for (const row of result.data) {
          rows++;
          const raw = (row[detail.dataset.timestamp_column] || '').trim(),
            time = csvTimestampToNumber(raw);
          if (!Number.isFinite(time)) continue;
          const rawValue = (row[channel] || '').trim(),
            parsed = rawValue === '' ? NaN : Number(rawValue),
            value = Number.isFinite(parsed) ? parsed : null;
          if (value == null) missing++;
          else {
            valid++;
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
          const label = (row[detail.dataset.label_column] || '').trim();
          if (label === detail.dataset.abnormal_label) abnormal++;
          const point = { time, timestamp: raw, value, label };
          bucket.push(point);
          collector.push(point);
          if (label !== previous?.label && transitions < 2000) {
            if (previous) sampled.push(previous);
            sampled.push(point);
            transitions++;
          }
          previous = point;
          if (bucket.length >= bucketSize) flush();
        }
      },
      complete() {
        if (!active) return;
        flush();
        const points = Array.from(new Set(sampled)).sort((a, b) => a.time - b.time),
          labels = collector.finish();
        setSeries({
          points,
          sourceRows: rows,
          validValues: valid,
          missingValues: missing,
          abnormalRows: abnormal,
          min: Number.isFinite(min) ? min : null,
          max: Number.isFinite(max) ? max : null,
          sampled: points.length < rows,
          labelIntervals: labels.intervals,
          labelIntervalsTruncated: labels.truncated,
        });
        setParsing(false);
        parserRef.current = null;
      },
      error(e) {
        if (active) {
          setError(`CSV를 읽지 못했어요. ${e.message}`);
          setParsing(false);
        }
      },
    });
    return () => {
      active = false;
      parserRef.current?.abort();
      parserRef.current = null;
      setParsing(false);
    };
  }, [detail, file, channel, mode]);
  const ownDrafts = useMemo(
    () => drafts.filter((draft) => draft.datasetId === datasetId),
    [drafts, datasetId],
  );
  const shownObservations = mode === 'live' ? saved.map(observationForDisplay) : ownDrafts;
  const beginObservation = () => {
    setEditing(null);
    setText('');
    setLocation('');
    setJudgment('pending');
    setSaveError('');
    setConflict(false);
    setRecordOpen(true);
  };
  const beginEdit = (item: SavedObservation) => {
    setEditing(item);
    setText(item.content);
    setLocation(item.location);
    setJudgment(displayJudgment(item.judgment));
    setSaveError('');
    setConflict(false);
    setRecordOpen(true);
  };
  const save = async () => {
    if ((!selection && !editing) || !text.trim() || !datasetId || saving) return;
    setSaveError('');
    setConflict(false);
    setSaving(true);
    try {
      if (mode === 'live') {
        const values = {
          location: location.trim(),
          content: text.trim(),
          judgment: savedJudgment(judgment),
        };
        if (editing) await reviewApi.patch(editing.id, editing.revision, values);
        else
          await reviewApi.create({
            dataset_id: datasetId,
            channel,
            start_time: selection!.start.timestamp,
            end_time: selection!.end.timestamp,
            ...values,
          });
        window.dispatchEvent(new Event('kkobugi:observations'));
        toast(
          editing
            ? '내 계정의 관찰을 수정했어요. 수정 이력도 남습니다.'
            : '내 계정에 관찰을 저장했어요.',
          'success',
        );
      } else {
        const draft: Observation = {
          id: crypto.randomUUID(),
          datasetId,
          channel,
          start: selection!.start.timestamp,
          end: selection!.end.timestamp,
          location: location.trim(),
          text: text.trim(),
          judgment,
          createdAt: new Date().toISOString(),
        };
        writeObservationDrafts(storageKey, [draft, ...drafts]);
        toast('미리보기 임시 초안을 이 브라우저에 저장했어요.', 'success');
      }
      setRecordOpen(false);
      setText('');
      setLocation('');
      setJudgment('pending');
      setEditing(null);
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'OBSERVATION_CONFLICT'
      ) {
        setConflict(true);
        setSaveError(
          '다른 창에서 먼저 수정한 내용이 있어요. 현재 입력은 유지했습니다. 최신 기록을 불러온 뒤 다시 수정해주세요.',
        );
      } else
        setSaveError(
          mode === 'demo'
            ? '브라우저 저장 공간을 확인해주세요. 초안을 저장하지 못했어요.'
            : errorMessage(error),
        );
    } finally {
      setSaving(false);
    }
  };
  const reloadEditing = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      const latest = await reviewApi.get(editing.id);
      beginEdit(latest);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const remove = (id: string) => {
    try {
      writeObservationDrafts(
        storageKey,
        drafts.filter((d) => d.id !== id),
      );
      toast('초안을 삭제했어요.');
    } catch {
      toast('초안을 삭제하지 못했어요.', 'error');
    }
  };
  return (
    <div className="page-stack rv-page">
      <PageHeader
        eyebrow="TIME SERIES"
        title="구간 검토"
        description="채널값과 CSV 라벨을 같은 시간축에서 보고, 직접 관찰한 내용을 남깁니다."
      >
        <Link className="button secondary" to="/reports">
          <FileText size={16} />
          검토 기록
          <ArrowUpRight size={15} />
        </Link>
      </PageHeader>
      {mode === 'demo' && (
        <Notice>
          화면 미리보기입니다. 그래프와 라벨은 예시 데이터이며 실제 펌프의 측정값이 아닙니다.
        </Notice>
      )}
      {!datasets.length ? (
        <section className="surface">
          <EmptyState
            icon={ChartNoAxesCombined}
            title="먼저 CSV를 등록해주세요"
            description="데이터를 등록하면 채널과 시간 구간을 선택할 수 있어요."
            action={
              <Link className="button primary" to="/data">
                데이터 등록
              </Link>
            }
          />
        </section>
      ) : (
        <>
          <section className="surface rv-source-bar">
            <Field label="데이터" htmlFor="review-dataset">
              <select
                id="review-dataset"
                className="select"
                value={datasetId || ''}
                onChange={(e) => setSelectedDatasetId(e.target.value)}
              >
                {datasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>
                    {dataset.filename}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="표시할 채널" htmlFor="review-channel">
              <select
                id="review-channel"
                className="select"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                disabled={!detail}
              >
                {detail?.dataset.channels.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <div className="rv-source-note">
              <span className="rv-file-mark">
                <FileText size={21} />
              </span>
              <div>
                <strong>{number(detail?.dataset.row_count || 0)}행</strong>
                <span>업로드 원본 · 전처리하지 않음</span>
              </div>
            </div>
          </section>
          {error && <Notice tone="error">{error}</Notice>}
          <section className="surface rv-chart-surface">
            <div className="section-heading">
              <div>
                <h2>채널 흐름</h2>
                <p>
                  {detail
                    ? `${csvTime(detail.inspection.time_start)} — ${csvTime(detail.inspection.time_end)}`
                    : 'CSV를 불러오는 중'}
                </p>
              </div>
              <Badge tone="blue">{mode === 'demo' ? '예시 CSV' : '원본 CSV'}</Badge>
            </div>
            {loading || parsing ? (
              <div className="rv-chart-loading">
                <LoaderCircle size={25} className="rv-spin" />
                <strong>{loading ? 'CSV를 불러오고 있어요' : '선택한 채널을 읽고 있어요'}</strong>
                <span>원자료는 변경하지 않습니다.</span>
              </div>
            ) : series.points.length ? (
              <TimeSeriesChart
                points={series.points}
                channel={channel}
                abnormalLabel={detail?.dataset.abnormal_label || '1'}
                selection={selection}
                onSelection={setSelection}
                labelIntervals={mode === 'live' ? originalLabelIntervals : series.labelIntervals}
                labelIntervalsTruncated={
                  mode === 'live'
                    ? originalLabelTotal > originalLabelIntervals.length
                    : series.labelIntervalsTruncated
                }
                labelStatus={mode === 'live' ? labelStatus : undefined}
              />
            ) : (
              <EmptyState
                title={error ? '시간열을 확인한 뒤 다시 열어주세요' : '표시할 값이 없습니다'}
                description="시간열과 숫자 채널이 있는 CSV가 필요해요."
              />
            )}
            {!!series.sourceRows && (
              <div className="rv-series-stats">
                <span>
                  원본 <strong>{number(series.sourceRows)}행</strong>
                </span>
                <span>
                  숫자 값 <strong>{number(series.validValues)}개</strong>
                </span>
                <span>
                  값 없음 <strong>{number(series.missingValues)}개</strong>
                </span>
                <span>
                  최솟값{' '}
                  <strong>
                    {series.min?.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) ?? '—'}
                  </strong>
                </span>
                <span>
                  최댓값{' '}
                  <strong>
                    {series.max?.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) ?? '—'}
                  </strong>
                </span>
              </div>
            )}
            {series.sampled && (
              <p className="rv-sampling-note">
                성능을 위해 그래프에는 {number(series.points.length)}개 대표점을 표시합니다. 위 행
                수와 최솟값·최댓값은 전체 채널을 읽어 계산했습니다. 라벨 막대는 대표점과 별도로
                원본의 모든 행에서 구간을 확인합니다.
              </p>
            )}
          </section>
          <section className={`surface rv-range-card ${selection ? 'rv-range-active' : ''}`}>
            <span className="rv-range-icon">
              <MapPin size={21} />
            </span>
            <div>
              <h3>{selection ? '직접 고른 구간' : '확인할 부분을 그래프에서 드래그하세요'}</h3>
              <p>
                {selection
                  ? `${csvTime(selection.start.timestamp)} — ${csvTime(selection.end.timestamp)}`
                  : '노란 배경으로 표시한 구간에 관찰 내용을 남길 수 있어요.'}
              </p>
            </div>
            <button className="button primary" disabled={!selection} onClick={beginObservation}>
              <Plus size={17} />
              관찰 남기기
            </button>
          </section>
          <section className="surface rv-drafts">
            <div className="section-heading">
              <div>
                <h2>
                  이 데이터에 남긴 관찰{' '}
                  <span className="rv-count">
                    {mode === 'live' ? savedTotal : ownDrafts.length}
                  </span>
                </h2>
                <p>
                  {mode === 'live'
                    ? '내 계정에 저장 · 다른 계정의 팀원에게는 보이지 않습니다.'
                    : '미리보기 임시 초안 · 이 브라우저에만 저장됩니다.'}
                </p>
              </div>
              {mode === 'live' && (
                <button
                  className="icon-button"
                  aria-label="관찰 목록 새로 고침"
                  disabled={observationsLoading}
                  onClick={() => setObservationsVersion((value) => value + 1)}
                >
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
            {observationsError && <Notice tone="error">{observationsError}</Notice>}
            {observationsLoading && !shownObservations.length ? (
              <div className="rv-inline-empty">저장한 관찰을 불러오고 있어요.</div>
            ) : !shownObservations.length && !observationsError ? (
              <div className="rv-inline-empty">아직 관찰을 남기지 않았어요.</div>
            ) : (
              shownObservations.map((draft) => (
                <article className="rv-draft-row" key={draft.id}>
                  <div className="rv-draft-symbol">
                    <Check size={17} />
                  </div>
                  <div className="rv-draft-content">
                    <div>
                      <strong>{draft.channel}</strong>
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
                      {mode === 'live' && (
                        <span className="rv-revision">
                          수정 {saved.find((item) => item.id === draft.id)?.revision}
                        </span>
                      )}
                    </div>
                    <p>{draft.text}</p>
                    <span>
                      {csvTime(draft.start)} — {csvTime(draft.end)}
                      {draft.location && ` · ${draft.location}`}
                    </span>
                  </div>
                  {mode === 'live' ? (
                    <button
                      className="icon-button"
                      aria-label={`${draft.channel} 관찰 수정`}
                      onClick={() => beginEdit(saved.find((item) => item.id === draft.id)!)}
                    >
                      <Pencil size={16} />
                    </button>
                  ) : (
                    <button
                      className="icon-button"
                      aria-label={`${draft.channel} 관찰 초안 삭제`}
                      onClick={() => remove(draft.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </article>
              ))
            )}
            {mode === 'live' && saved.length < savedTotal && (
              <button
                className="button secondary rv-load-more"
                disabled={observationsLoading}
                onClick={loadMoreObservations}
              >
                {observationsLoading
                  ? '불러오는 중'
                  : `더 불러오기 (${saved.length} / ${savedTotal})`}
              </button>
            )}
          </section>
          {mode === 'live' && ownDrafts.length > 0 && (
            <details className="surface rv-legacy-drafts">
              <summary>이 브라우저에 남아 있는 이전 초안 {ownDrafts.length}개</summary>
              <p>이전 초안은 그대로 보관했습니다. 서버로 자동 전송하지 않았습니다.</p>
              {ownDrafts.map((draft) => (
                <article key={draft.id}>
                  <strong>
                    {draft.channel} · {judgmentText[draft.judgment]}
                  </strong>
                  <span>
                    {csvTime(draft.start)} — {csvTime(draft.end)}
                  </span>
                  <p>{draft.text}</p>
                </article>
              ))}
            </details>
          )}
        </>
      )}
      <Modal
        open={recordOpen}
        onOpenChange={(open) => {
          if (!saving) setRecordOpen(open);
        }}
        title={editing ? '관찰 수정' : '관찰 남기기'}
        description="모델 결과와 구분해 직접 확인한 내용을 기록하세요."
        footer={
          <>
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => setRecordOpen(false)}
            >
              취소
            </button>
            <button
              className="button primary"
              disabled={!text.trim() || saving || conflict}
              onClick={save}
            >
              {saving && <LoaderCircle size={15} className="rv-spin" />}
              {saving
                ? '저장 중'
                : mode === 'live'
                  ? editing
                    ? '수정 저장'
                    : '내 계정에 저장'
                  : '임시 초안 저장'}
            </button>
          </>
        }
      >
        <div className="rv-record-fields">
          <div className="rv-record-range">
            <strong>
              {editing?.channel || channel}
              {editing && <small> · 수정 {editing.revision}</small>}
            </strong>
            <span>
              {csvTime(editing?.start_time || selection?.start.timestamp)}
              <br />
              {csvTime(editing?.end_time || selection?.end.timestamp)}
            </span>
          </div>
          {saveError && (
            <Notice tone="error">
              {saveError}
              {conflict && (
                <button
                  className="button secondary rv-conflict-button"
                  disabled={saving}
                  onClick={reloadEditing}
                >
                  내 입력 대신 최신 기록 불러오기
                </button>
              )}
            </Notice>
          )}
          <Field label="관찰 내용" htmlFor="observation-text">
            <textarea
              id="observation-text"
              className="input"
              rows={4}
              placeholder="어떤 변화가 보였는지 적어주세요."
              maxLength={5000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </Field>
          <Field label="직접 내린 판단" htmlFor="observation-judgment">
            <select
              id="observation-judgment"
              className="select"
              value={judgment}
              onChange={(e) => setJudgment(e.target.value as Observation['judgment'])}
            >
              {Object.entries(judgmentText).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="관련 위치 · 기록"
            htmlFor="observation-location"
            hint="선택 사항입니다. 설비 위치나 확인한 기록을 적어주세요."
          >
            <input
              id="observation-location"
              className="input"
              value={location}
              maxLength={200}
              onChange={(e) => setLocation(e.target.value)}
            />
          </Field>
          <Notice>
            {mode === 'live'
              ? '내 계정의 서버 기록으로 저장하며 작성·수정 이력이 남습니다. 다른 계정에 공유되지는 않습니다.'
              : '미리보기 임시 초안으로 이 브라우저에만 저장합니다.'}{' '}
            모델 예측, 고장 확정, 학습 제외 설정과는 별개입니다.
          </Notice>
        </div>
      </Modal>
    </div>
  );
}
