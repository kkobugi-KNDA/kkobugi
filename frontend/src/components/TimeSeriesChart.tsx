import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Expand, Minus, Plus, RotateCcw, ScanLine } from 'lucide-react';
import { Modal } from './ui';
import type { ChartPoint } from '../types';

export interface SelectedRange {
  start: ChartPoint;
  end: ChartPoint;
}
interface Props {
  points: ChartPoint[];
  channel: string;
  abnormalLabel: string;
  selection: SelectedRange | null;
  onSelection: (value: SelectedRange | null) => void;
  labelIntervals?: SelectedRange[];
  labelIntervalsTruncated?: boolean;
  labelStatus?: string;
}
type Domain = [number, number];
const W = 1000,
  H = 330,
  LEFT = 64,
  RIGHT = 24,
  TOP = 24,
  BOTTOM = 60;

/** Naive CSV timestamps use UTC arithmetic only for spacing; no timezone is assigned. */
export function csvTimestampToNumber(raw: string): number {
  const value = raw.trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/.exec(
    value,
  );
  if (!match) return NaN;
  const year = +match[1],
    month = +match[2] - 1,
    day = +match[3],
    hour = +(match[4] || 0),
    minute = +(match[5] || 0),
    second = +(match[6] || 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, Math.floor(Number(`0.${match[7] || '0'}`) * 1000));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return NaN;
  return date.getTime();
}

/** Read every original label before chart sampling; capped intervals are omitted, never merged. */
export function createLabelIntervalCollector(abnormalLabel: string, limit = 5000) {
  const intervals: SelectedRange[] = [];
  let start: ChartPoint | null = null,
    end: ChartPoint | null = null,
    truncated = false;
  const close = () => {
    if (start && end) {
      if (intervals.length < Math.max(0, limit)) intervals.push({ start, end });
      else truncated = true;
    }
    start = end = null;
  };
  return {
    push(point: ChartPoint) {
      if (point.label === abnormalLabel) {
        start ||= point;
        end = point;
      } else close();
    },
    finish() {
      close();
      return { intervals, truncated };
    },
  };
}

export function chartEnvelope(points: ChartPoint[], max = 1400): ChartPoint[] {
  if (points.length <= max) return points;
  const width = Math.ceil(points.length / Math.max(1, Math.floor(max / 5)));
  const result: ChartPoint[] = [];
  for (let start = 0; start < points.length; start += width) {
    const bucket = points.slice(start, start + width);
    const valid = bucket.filter((p) => p.value != null);
    const missing = bucket.find((p) => p.value == null);
    const ordered = [
      bucket[0],
      bucket[bucket.length - 1],
      ...(valid.length
        ? [
            valid.reduce((a, b) => (a.value! < b.value! ? a : b)),
            valid.reduce((a, b) => (a.value! > b.value! ? a : b)),
          ]
        : []),
      ...(missing ? [missing] : []),
    ];
    result.push(...Array.from(new Set(ordered)).sort((a, b) => a.time - b.time));
  }
  return result;
}

function nearest(points: ChartPoint[], time: number) {
  let lo = 0,
    hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(points[lo - 1].time - time) < Math.abs(points[lo].time - time)
    ? points[lo - 1]
    : points[lo];
}
function clipped(domain: Domain, bounds: Domain): Domain {
  const width = Math.min(bounds[1] - bounds[0], Math.max(1, domain[1] - domain[0]));
  const start = Math.max(bounds[0], Math.min(bounds[1] - width, domain[0]));
  return [start, start + width];
}

export default function TimeSeriesChart({
  points,
  channel,
  abnormalLabel,
  selection,
  onSelection,
  labelIntervals,
  labelIntervalsTruncated = false,
  labelStatus,
}: Props) {
  const [domain, setDomain] = useState<Domain | null>(null),
    [expanded, setExpanded] = useState(false);
  const [drag, setDrag] = useState<Domain | null>(null),
    [hover, setHover] = useState<ChartPoint | null>(null);
  const pointer = useRef<{ id: number; x: number; time: number } | null>(null);
  const gradient = useId().replace(/:/g, '');
  const bounds: Domain = points.length
    ? [points[0].time, points[points.length - 1].time + (points.length === 1 ? 1000 : 0)]
    : [0, 1];
  const view = domain ? clipped(domain, bounds) : bounds;
  useEffect(() => {
    setDomain(null);
    setDrag(null);
    setHover(null);
    pointer.current = null;
  }, [points, channel]);
  const visible = useMemo(
    () => points.filter((p) => p.time >= view[0] && p.time <= view[1]),
    [points, view[0], view[1]],
  );
  const plotted = useMemo(() => chartEnvelope(visible), [visible]);
  const values = visible.flatMap((p) => (p.value == null ? [] : [p.value]));
  const min = values.length ? Math.min(...values) : 0,
    max = values.length ? Math.max(...values) : 1;
  const pad = Math.max((max - min) * 0.16, Math.abs(max) * 0.005, 0.01),
    low = min - pad,
    high = max + pad;
  const x = (time: number) =>
    LEFT + ((time - view[0]) / Math.max(1, view[1] - view[0])) * (W - LEFT - RIGHT);
  const y = (value: number) => TOP + (1 - (value - low) / (high - low)) * (H - TOP - BOTTOM);
  const path = plotted
    .map((p, i) =>
      p.value == null
        ? ''
        : `${i === 0 || plotted[i - 1].value == null ? 'M' : 'L'}${x(p.time).toFixed(2)},${y(p.value).toFixed(2)}`,
    )
    .join(' ');
  const groups = useMemo(() => {
    if (labelIntervals) return labelIntervals;
    const collector = createLabelIntervalCollector(abnormalLabel);
    points.forEach(collector.push);
    return collector.finish().intervals;
  }, [points, abnormalLabel, labelIntervals]);
  const focusRange = (range: SelectedRange) => {
    onSelection(range);
    const extra = Math.max(
      (range.end.time - range.start.time) * 0.15,
      (bounds[1] - bounds[0]) * 0.005,
    );
    setDomain(clipped([range.start.time - extra, range.end.time + extra], bounds));
  };
  const zoom = (factor: number) => {
    const center = (view[0] + view[1]) / 2,
      width = (view[1] - view[0]) * factor;
    setDomain(clipped([center - width / 2, center + width / 2], bounds));
  };
  const rawTime = (time: number) =>
    points.length ? nearest(points, time).timestamp.replace('T', ' ') : '';
  const renderChart = (large = false) => (
    <div className={`rv-chart ${large ? 'rv-chart-large' : ''}`}>
      <div className="rv-chart-toolbar">
        <div className="rv-chart-caption">
          <span className="rv-channel-dot" />
          <strong>{channel}</strong>
          <span>원자료 값 · 단위 미확인</span>
        </div>
        <div className="rv-chart-actions">
          <button
            className="icon-button"
            title="더 넓게 보기"
            aria-label="더 넓게 보기"
            onClick={() => zoom(2)}
          >
            <Minus size={17} />
          </button>
          <button
            className="icon-button"
            title="더 가깝게 보기"
            aria-label="더 가깝게 보기"
            onClick={() => zoom(0.5)}
          >
            <Plus size={17} />
          </button>
          <button
            className="icon-button"
            title="전체 시간 보기"
            aria-label="전체 시간 보기"
            onClick={() => setDomain(null)}
          >
            <RotateCcw size={16} />
          </button>
          {!large && (
            <button
              className="icon-button"
              title="그래프 크게 보기"
              aria-label="그래프 크게 보기"
              onClick={() => setExpanded(true)}
            >
              <Expand size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="rv-chart-canvas">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${channel} 시계열. 드래그로 구간을 선택하고 확대할 수 있습니다.`}
        >
          <defs>
            <linearGradient id={`${gradient}-${large}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3d7de1" stopOpacity=".12" />
              <stop offset="100%" stopColor="#3d7de1" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${gradient}-clip-${large}`}>
              <rect x={LEFT} y={TOP} width={W - LEFT - RIGHT} height={H - TOP - BOTTOM} />
            </clipPath>
          </defs>
          {Array.from({ length: 5 }, (_, i) => {
            const value = low + ((high - low) * i) / 4;
            return (
              <g key={i}>
                <line
                  x1={LEFT}
                  x2={W - RIGHT}
                  y1={y(value)}
                  y2={y(value)}
                  className="rv-chart-grid"
                />
                <text x={LEFT - 12} y={y(value) + 4} textAnchor="end" className="rv-axis-text">
                  {value.toLocaleString('en', { maximumFractionDigits: 2 })}
                </text>
              </g>
            );
          })}
          <g clipPath={`url(#${gradient}-clip-${large})`}>
            {selection && (
              <rect
                x={Math.max(LEFT, x(selection.start.time))}
                y={TOP}
                width={Math.max(
                  0,
                  Math.min(W - RIGHT, x(selection.end.time)) -
                    Math.max(LEFT, x(selection.start.time)),
                )}
                height={H - TOP - BOTTOM}
                className="rv-selected-area"
              />
            )}
            <path
              d={path}
              fill="none"
              stroke="#3272ce"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {hover && (
              <>
                <line
                  x1={x(hover.time)}
                  x2={x(hover.time)}
                  y1={TOP}
                  y2={H - BOTTOM}
                  className="rv-hover-line"
                />
                {hover.value != null && (
                  <circle
                    cx={x(hover.time)}
                    cy={y(hover.value)}
                    r="4.5"
                    fill="#fff"
                    stroke="#3272ce"
                    strokeWidth="2"
                  />
                )}
              </>
            )}
            {drag && (
              <rect
                x={x(Math.min(...drag))}
                y={TOP}
                width={Math.max(1, x(Math.max(...drag)) - x(Math.min(...drag)))}
                height={H - TOP - BOTTOM}
                className="rv-drag-area"
              />
            )}
          </g>
          {Array.from({ length: 6 }, (_, i) => {
            const time = view[0] + ((view[1] - view[0]) * i) / 5;
            const raw = rawTime(time);
            return (
              <g key={i}>
                <text
                  x={x(time)}
                  y={H - 32}
                  textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}
                  className="rv-axis-text"
                >
                  {raw.slice(11, 19)}
                </text>
                <text
                  x={x(time)}
                  y={H - 14}
                  textAnchor={i === 0 ? 'start' : i === 5 ? 'end' : 'middle'}
                  className="rv-axis-date"
                >
                  {raw.slice(0, 10)}
                </text>
              </g>
            );
          })}
          <rect
            x={LEFT}
            y={TOP}
            width={W - LEFT - RIGHT}
            height={H - TOP - BOTTOM}
            fill="transparent"
            style={{ cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !points.length) return;
              const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
              const svgX = ((event.clientX - rect.left) / rect.width) * W;
              const time = view[0] + ((svgX - LEFT) / (W - LEFT - RIGHT)) * (view[1] - view[0]);
              pointer.current = { id: event.pointerId, x: event.clientX, time };
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag([time, time]);
            }}
            onPointerMove={(event) => {
              if (!points.length) return;
              const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
              const svgX = Math.max(
                LEFT,
                Math.min(W - RIGHT, ((event.clientX - rect.left) / rect.width) * W),
              );
              const time = view[0] + ((svgX - LEFT) / (W - LEFT - RIGHT)) * (view[1] - view[0]);
              setHover(nearest(points, time));
              if (pointer.current?.id === event.pointerId) setDrag([pointer.current.time, time]);
            }}
            onPointerUp={(event) => {
              const current = pointer.current;
              if (
                current &&
                current.id === event.pointerId &&
                Math.abs(current.x - event.clientX) > 5
              ) {
                const rect = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                const svgX = Math.max(
                  LEFT,
                  Math.min(W - RIGHT, ((event.clientX - rect.left) / rect.width) * W),
                );
                const endTime =
                  view[0] + ((svgX - LEFT) / (W - LEFT - RIGHT)) * (view[1] - view[0]);
                const ordered = [current.time, endTime].sort((a, b) => a - b);
                focusRange({
                  start: nearest(points, ordered[0]),
                  end: nearest(points, ordered[1]),
                });
              }
              pointer.current = null;
              setDrag(null);
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              pointer.current = null;
              setDrag(null);
            }}
            onPointerLeave={() => {
              if (!pointer.current) setHover(null);
            }}
          />
        </svg>
        <div className="rv-chart-readout" aria-live="off">
          {hover ? (
            <>
              <span>{hover.timestamp.replace('T', ' ')}</span>
              <strong>{hover.value ?? '값 없음'}</strong>
            </>
          ) : (
            <>
              <ScanLine size={14} />
              <span>드래그해서 구간 선택 · 확대</span>
            </>
          )}
        </div>
      </div>
      <div className="rv-label-caption">
        <span className="rv-label-dot" />
        CSV 라벨 = {abnormalLabel}
        <span>모델 예측과 별도</span>
      </div>
      <div
        className="rv-label-track"
        style={{ marginLeft: `${(LEFT / W) * 100}%`, marginRight: `${(RIGHT / W) * 100}%` }}
      >
        {groups.map((group, index) => {
          const start = Math.max(view[0], group.start.time),
            end = Math.min(view[1], group.end.time);
          if (end < start) return null;
          return (
            <button
              key={index}
              title={`${group.start.timestamp.replace('T', ' ')} ~ ${group.end.timestamp.replace('T', ' ')} · 눌러서 확대`}
              aria-label={`라벨 ${abnormalLabel} 구간 ${group.start.timestamp}부터 ${group.end.timestamp} 확대`}
              style={{
                left: `${((start - view[0]) / (view[1] - view[0])) * 100}%`,
                width: `${Math.max(0, ((end - start) / (view[1] - view[0])) * 100)}%`,
              }}
              onClick={() => focusRange(group)}
            />
          );
        })}
        {!groups.length && (
          <span className="rv-no-label">
            {labelStatus
              ? '라벨 구간 조회 상태를 아래에서 확인해주세요.'
              : '이 채널의 표시 범위에 해당 라벨이 없습니다.'}
          </span>
        )}
      </div>
      <div className="rv-chart-legend">
        <span>
          <i className="rv-legend-yellow" />
          직접 고른 구간
        </span>
        <span>
          <i className="rv-legend-purple" />
          CSV에 기록된 라벨
        </span>
        <span>시간은 CSV 표기 기준</span>
      </div>
      {labelIntervalsTruncated && (
        <p className="rv-sampling-note">
          라벨 구간이 많아 처음 {groups.length.toLocaleString('ko-KR')}개 구간만 표시합니다. 이후
          구간은 생략하며, 떨어진 구간을 하나로 연결하지 않습니다.
        </p>
      )}
      {labelStatus && <p className="rv-sampling-note">{labelStatus}</p>}
    </div>
  );
  return (
    <>
      {renderChart()}
      <Modal
        open={expanded}
        onOpenChange={setExpanded}
        title={`${channel} 크게 보기`}
        description="같은 시간축에서 구간을 드래그하거나 라벨 구간을 눌러 확대하세요."
        className="rv-chart-modal"
      >
        {renderChart(true)}
      </Modal>
    </>
  );
}
