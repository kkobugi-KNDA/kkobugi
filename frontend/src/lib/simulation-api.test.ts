import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { remainingServiceHours, uploadSimulation } from './simulation-api';

afterEach(() => vi.unstubAllGlobals());

describe('시뮬레이션 CSV 업로드', () => {
  it('CSV와 선택한 모델을 multipart로 보내고 세션·취소 신호를 유지한다', async () => {
    const file = new File(['timestamp,sensor_00\n2026-11-01T00:00:00,1\n'], 'month.csv', {
      type: 'text/csv',
    });

    const controller = new AbortController();

    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'simulation-id' }), { status: 201 }));

    vi.stubGlobal('fetch', fetcher);
    await uploadSimulation(file, 'run-id', 'autoencoder', controller.signal);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] as [string, RequestInit];

    const form = request.body as FormData;

    const headers = new Headers(request.headers);

    expect(url).toBe('/api/v1/simulations');
    expect(request.method).toBe('POST');
    expect(request.credentials).toBe('include');
    expect(request.signal).toBe(controller.signal);
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('file')).toBe(file);
    expect(form.get('run_id')).toBe('run-id');
    expect(form.get('model_key')).toBe('autoencoder');
    // 브라우저가 multipart boundary를 붙인다. JSON Content-Type을 직접 지정하지 않는다.
    expect(headers.has('Content-Type')).toBe(false);
    expect(headers.get('X-Requested-With')).toBe('kkobugi-web');
  });

  it('인증 실패를 알리고 CSV 업로드를 임의로 재시도하지 않는다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: '로그인이 필요해요.' } }), { status: 401 }),
      );

    const expired = vi.fn();

    window.addEventListener('kkobugi:unauthorized', expired);
    vi.stubGlobal('fetch', fetcher);
    try {
      await expect(
        uploadSimulation(
          new File(['csv'], 'month.csv'),
          'run-id',
          'xgboost',
          new AbortController().signal,
        ),
      ).rejects.toBeInstanceOf(ApiError);
      expect(expired).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('kkobugi:unauthorized', expired);
    }
  });

  it('사용자가 취소한 업로드를 다른 오류로 바꾸지 않는다', async () => {
    const cancellation = new DOMException('중단', 'AbortError');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancellation));
    await expect(
      uploadSimulation(
        new File(['csv'], 'month.csv'),
        'run-id',
        'xgboost',
        new AbortController().signal,
      ),
    ).rejects.toBe(cancellation);
  });
});

describe('사용자가 입력한 기준수명과 운전시간의 차이', () => {
  it.each([
    ['', '', null],
    ['100', '', null],
    ['', '0', null],
    ['100', '0', 100],
    ['100', '100', 0],
    ['100', '120', 0],
    ['100.5', '0.5', 100],
    ['0', '0', null],
    ['-1', '0', null],
    ['100', '-1', null],
    ['NaN', '0', null],
    ['Infinity', '0', null],
  ] as const)('기준=%s, 사용=%s일 때 %s를 반환한다', (expected, used, result) => {
    expect(remainingServiceHours(expected, used)).toBe(result);
  });
});
