import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chartEnvelope,
  createLabelIntervalCollector,
  csvTimestampToNumber,
} from '../components/TimeSeriesChart';
import { scenarioTotal } from './CostsPage';
import {
  observationForDisplay,
  reviewApi,
  savedJudgment,
  type SavedObservation,
} from '../lib/review-api';
import type { ChartPoint } from '../types';

function point(index: number, value: number | null = index, label = '0'): ChartPoint {
  return { time: index * 1000, timestamp: `row-${index}`, value, label };
}

describe('CSV timestamps', () => {
  it('keeps naive wall-clock spacing independent of the browser timezone', () => {
    const before = csvTimestampToNumber('2018-04-01 23:59:30.250');
    const after = csvTimestampToNumber('2018-04-02T00:00:00.750');
    expect(before).toBe(Date.UTC(2018, 3, 1, 23, 59, 30, 250));
    expect(after - before).toBe(30_500);
  });
  it('uses the supplied offset for aware timestamps', () => {
    expect(csvTimestampToNumber('2026-11-09T09:30:00+09:00')).toBe(
      csvTimestampToNumber('2026-11-09T00:30:00Z'),
    );
    expect(csvTimestampToNumber('2026-11-08T19:30:00-05:00')).toBe(
      csvTimestampToNumber('2026-11-09T00:30:00Z'),
    );
  });
  it('accepts an ISO date and leap day without silently normalizing invalid dates', () => {
    expect(csvTimestampToNumber('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
    expect(csvTimestampToNumber('2024-02-30T12:00:00')).toBeNaN();
    expect(csvTimestampToNumber('2024-01-01T24:00:00')).toBeNaN();
    expect(csvTimestampToNumber('not-a-time')).toBeNaN();
  });
});

describe('chart sampling', () => {
  it('retains a narrow peak, trough, endpoints, and a real missing-value marker', () => {
    const points = Array.from({ length: 4000 }, (_, i) => point(i, 10));
    points[123].value = 1111;
    points[1777].value = -999;
    points[2345].value = null;
    const shown = chartEnvelope(points, 50);
    expect(shown.length).toBeLessThanOrEqual(50);
    expect(shown[0]).toBe(points[0]);
    expect(shown.at(-1)).toBe(points.at(-1));
    expect(shown).toContain(points[123]);
    expect(shown).toContain(points[1777]);
    expect(shown).toContain(points[2345]);
    expect(shown.every((p) => points.includes(p))).toBe(true);
    expect(shown.every((p, i) => i === 0 || p.time >= shown[i - 1].time)).toBe(true);
  });
  it('leaves a short series intact', () => {
    const points = [point(0), point(1, null), point(2)];
    expect(chartEnvelope(points, 10)).toBe(points);
  });
});

describe('CSV label intervals before sampling', () => {
  it('keeps exact original endpoints and does not bridge an intervening normal row', () => {
    const original = [
      point(0),
      point(1, 1, '1'),
      point(2, 1, '1'),
      point(3),
      point(4, 1, '1'),
      point(5),
    ];
    const collector = createLabelIntervalCollector('1');
    original.forEach(collector.push);
    const result = collector.finish();
    expect(result.truncated).toBe(false);
    expect(result.intervals).toEqual([
      { start: original[1], end: original[2] },
      { start: original[4], end: original[4] },
    ]);
  });
  it('closes an abnormal interval at the last original row', () => {
    const original = [point(0), point(1, 1, 'broken'), point(2, 1, 'broken')];
    const collector = createLabelIntervalCollector('broken');
    original.forEach(collector.push);
    expect(collector.finish().intervals).toEqual([{ start: original[1], end: original[2] }]);
  });
  it('marks omitted intervals at the cap without merging them into a false span', () => {
    const collector = createLabelIntervalCollector('1', 2);
    const original = Array.from({ length: 10 }, (_, i) => point(i, i, i % 2 ? '1' : '0'));
    original.forEach(collector.push);
    const result = collector.finish();
    expect(result.truncated).toBe(true);
    expect(result.intervals).toEqual([
      { start: original[1], end: original[1] },
      { start: original[3], end: original[3] },
    ]);
  });
});

describe('user-entered cost scenarios', () => {
  const input = {
    inspection: '100',
    parts: '200',
    labor: '300',
    downtime: '2.5',
    hourlyLoss: '40',
  };
  it('adds direct costs and downtime loss using the entered duration', () => {
    expect(scenarioTotal(input)).toBe(700);
  });
  it('allows an explicitly entered zero cost', () => {
    expect(
      scenarioTotal({ inspection: '0', parts: '0', labor: '0', downtime: '0', hourlyLoss: '0' }),
    ).toBe(0);
  });
  it.each(['', ' ', '-1', 'NaN', 'Infinity'])(
    'does not treat invalid or missing input %j as a valid zero',
    (invalid) => {
      expect(scenarioTotal({ ...input, parts: invalid })).toBeNull();
    },
  );
  it('rejects arithmetic overflow instead of displaying an infinite monetary result', () => {
    expect(scenarioTotal({ ...input, downtime: '1e308', hourlyLoss: '1e308' })).toBeNull();
  });
});

describe('account observation requests', () => {
  const saved: SavedObservation = {
    id: '1'.repeat(32),
    dataset_id: '2'.repeat(32),
    run_id: null,
    model_key: null,
    channel: 'sensor_04',
    start_time: '2018-04-01T01:00:00',
    end_time: '2018-04-01T01:01:00',
    location: '사용자 확인 위치',
    content: '직접 관찰한 내용',
    judgment: 'anomaly_candidate',
    revision: 3,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_060,
    author: { id: 1, username: 'worker', display_name: '작업자' },
    last_editor: { id: 1, username: 'worker', display_name: '작업자' },
  };
  afterEach(() => vi.unstubAllGlobals());
  it('sends cookie authentication and the required mutation header with manual judgment', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(saved), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await reviewApi.create({
      dataset_id: saved.dataset_id,
      channel: saved.channel,
      start_time: saved.start_time,
      end_time: saved.end_time,
      content: saved.content,
      location: saved.location,
      judgment: savedJudgment('candidate'),
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/observations$/);
    expect(options.credentials).toBe('include');
    expect(new Headers(options.headers).get('X-Requested-With')).toBe('kkobugi-web');
    expect(JSON.parse(options.body)).toMatchObject({
      judgment: 'anomaly_candidate',
      start_time: saved.start_time,
      end_time: saved.end_time,
    });
    expect(JSON.parse(options.body)).not.toHaveProperty('run_id');
  });
  it('sends the last-read revision and preserves a server conflict for the UI to resolve', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'OBSERVATION_CONFLICT', message: '먼저 저장된 수정이 있습니다.' },
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      reviewApi.patch(saved.id, 3, {
        location: '',
        content: '내가 수정한 내용',
        judgment: 'needs_check',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'OBSERVATION_CONFLICT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      revision: 3,
      location: '',
      content: '내가 수정한 내용',
      judgment: 'needs_check',
    });
  });
  it('keeps paging scoped to the selected dataset', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 120, offset: 100, limit: 100 }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await reviewApi.list(saved.dataset_id, 100);
    const parsed = new URL(fetchMock.mock.calls[0][0], 'https://example.test');
    expect(parsed.searchParams.get('dataset_id')).toBe(saved.dataset_id);
    expect(parsed.searchParams.get('offset')).toBe('100');
    expect(parsed.searchParams.get('limit')).toBe('100');
  });
  it('queries exact original label intervals independently of chart downsampling', async () => {
    const intervals = {
      dataset_id: saved.dataset_id,
      code: 1,
      normal_label: 'normal',
      abnormal_label: 'broken',
      timezone_mode: 'naive',
      cadence_seconds: null,
      items: [
        {
          start_time: saved.start_time,
          end_time: saved.start_time,
          start_row: 1,
          end_row: 2,
          row_count: 1,
        },
      ],
      total: 600,
      limit: 500,
      offset: 0,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(intervals), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await reviewApi.labels(saved.dataset_id);
    const parsed = new URL(fetchMock.mock.calls[0][0], 'https://example.test');
    expect(parsed.pathname).toBe(`/api/v1/datasets/${saved.dataset_id}/label-intervals`);
    expect(parsed.searchParams.get('code')).toBe('1');
    expect(parsed.searchParams.get('limit')).toBe('500');
    expect(result.cadence_seconds).toBeNull();
    expect(result.items[0].start_time).toBe(result.items[0].end_time);
  });
  it('maps server judgment without changing measured timestamps or the recorded content', () => {
    expect(observationForDisplay(saved)).toMatchObject({
      id: saved.id,
      datasetId: saved.dataset_id,
      start: saved.start_time,
      end: saved.end_time,
      text: saved.content,
      judgment: 'candidate',
    });
    expect(savedJudgment('pending')).toBe('needs_check');
  });
});
