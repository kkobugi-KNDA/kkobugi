import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { prepareTraining } from './training-api';

const request = {
  dataset_id: 'a'.repeat(32),
  model_key: 'xgboost' as const,
  train_ratio: 0.7,
  validation_ratio: 0.15,
};

afterEach(() => vi.unstubAllGlobals());

describe('자동 학습 설정 요청', () => {
  it('현재 계정 세션과 CSRF 표시를 보내고 자동 설정만 요청한다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ configuration: {}, split: {}, notes: [] }), { status: 200 }),
      );

    vi.stubGlobal('fetch', fetcher);
    await prepareTraining(request);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/training/plan',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'kkobugi-web' },
        body: JSON.stringify(request),
      }),
    );
  });

  it('인증 만료를 전달하고 학습 요청으로 자동 재시도하지 않는다', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: '로그인이 필요해요.' } }), { status: 401 }),
      );

    const expired = vi.fn();

    window.addEventListener('kkobugi:unauthorized', expired);
    vi.stubGlobal('fetch', fetcher);
    await expect(prepareTraining(request)).rejects.toBeInstanceOf(ApiError);
    expect(expired).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    window.removeEventListener('kkobugi:unauthorized', expired);
  });

  it('자료 전환으로 취소한 요청을 통신 오류로 바꾸지 않는다', async () => {
    const aborted = new DOMException('중단', 'AbortError');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(prepareTraining(request)).rejects.toBe(aborted);
  });
});
