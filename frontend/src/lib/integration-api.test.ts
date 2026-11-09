import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessmentApi, type ReviewCreate } from './assessment-api';
import { predictionApi } from './prediction-api';

const datasetId = 'd'.repeat(32);

const reviewId = 'c'.repeat(32);

const createInput: ReviewCreate = {
  dataset_id: datasetId,
  channel: 'sensor_04',
  start_time: '2018-04-01T03:31:00',
  end_time: '2018-04-01T03:32:00',
  conclusion: '현장 관찰과 모델 결과를 함께 확인함.',
  judgment: 'needs_check',
  model_result: { run_id: 'e'.repeat(32), model_key: 'lightgbm', split: 'validation' },
  observations: [{ observation_id: 'a'.repeat(32), revision: 3 }],
};

afterEach(() => vi.unstubAllGlobals());

function stubResponse(value: unknown = {}, status = 200) {
  const fetcher = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );

  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('검토 서버 연결 계약', () => {
  it('7개 조회·변경 요청을 세션 쿠키와 필요한 변경 헤더로 보낸다', async () => {
    const fetcher = stubResponse();

    const actions = [
      () => assessmentApi.list(datasetId, 'sensor_04', 20),
      () => assessmentApi.get(reviewId),
      () => assessmentApi.create(createInput),
      () => assessmentApi.patch(reviewId, { revision: 3, conclusion: '수정한 내용' }),
      () => assessmentApi.complete(reviewId, 4),
      () => assessmentApi.reopen(reviewId, 5, '새 현장 관찰을 확인'),
      () => assessmentApi.history(reviewId, 20),
    ];

    for (const action of actions) await action();

    expect(fetcher).toHaveBeenCalledTimes(7);
    const paths = fetcher.mock.calls.map(([url]) => new URL(String(url), 'https://local.test'));

    expect(paths[0].pathname).toBe('/api/v1/reviews');
    expect(Object.fromEntries(paths[0].searchParams)).toEqual({
      dataset_id: datasetId,
      channel: 'sensor_04',
      limit: '20',
      offset: '20',
    });
    expect(paths.map((url) => url.pathname)).toEqual([
      '/api/v1/reviews',
      `/api/v1/reviews/${reviewId}`,
      '/api/v1/reviews',
      `/api/v1/reviews/${reviewId}`,
      `/api/v1/reviews/${reviewId}/complete`,
      `/api/v1/reviews/${reviewId}/reopen`,
      `/api/v1/reviews/${reviewId}/history`,
    ]);
    expect(paths[6].searchParams.get('offset')).toBe('20');
    for (const [, options] of fetcher.mock.calls) {
      const request = options as RequestInit;

      expect(request.credentials).toBe('include');
      if (request.method && request.method !== 'GET') {
        expect(new Headers(request.headers).get('X-Requested-With')).toBe('kkobugi-web');
        expect(new Headers(request.headers).get('Content-Type')).toBe('application/json');
      }
    }
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(createInput);
    expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual({ revision: 4 });
    expect(JSON.parse(fetcher.mock.calls[5][1].body)).toEqual({
      revision: 5,
      reason: '새 현장 관찰을 확인',
    });
  });

  it('내용만 수정할 때 기존 모델과 관찰 버전을 최신값으로 교체하는 필드를 만들지 않는다', async () => {
    const fetcher = stubResponse();

    await assessmentApi.patch(reviewId, { revision: 3, conclusion: '내가 직접 수정한 내용' });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      revision: 3,
      conclusion: '내가 직접 수정한 내용',
    });
  });

  it('다른 수정과 충돌하면 오류를 그대로 전달하고 재전송하지 않는다', async () => {
    const fetcher = stubResponse(
      {
        error: { code: 'REVIEW_CONFLICT', message: '최신 검토 기록을 확인하세요.' },
      },
      409,
    );

    await expect(assessmentApi.complete(reviewId, 3)).rejects.toMatchObject({
      status: 409,
      code: 'REVIEW_CONFLICT',
      message: '최신 검토 기록을 확인하세요.',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('만료된 세션을 전체 화면에 알리고 401 정보를 보존한다', async () => {
    stubResponse({ error: { code: 'UNAUTHORIZED', message: '로그인이 필요합니다.' } }, 401);
    const onUnauthorized = vi.fn();

    window.addEventListener('kkobugi:unauthorized', onUnauthorized);
    try {
      await expect(assessmentApi.list(datasetId, 'sensor_04')).rejects.toMatchObject({
        status: 401,
        code: 'UNAUTHORIZED',
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('kkobugi:unauthorized', onUnauthorized);
    }
  });

  it('자료 전환으로 취소한 조회를 네트워크 오류로 바꾸지 않는다', async () => {
    const aborted = new DOMException('자료 선택이 변경됨', 'AbortError');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(aborted));
    await expect(assessmentApi.get(reviewId, new AbortController().signal)).rejects.toBe(aborted);
  });
});

describe('예측 그래프 서버 연결 계약', () => {
  it('선택한 모델·분할·ISO 시각과 페이지를 전달하고 재구성 오차를 확률로 바꾸지 않는다', async () => {
    const start = '2018-04-01T03:31:00+09:00';

    const end = '2018-04-01T03:32:00+09:00';

    const result = {
      run_id: 'e'.repeat(32),
      dataset_id: datasetId,
      model_key: 'autoencoder',
      split: 'validation',
      input_sha256: 'd'.repeat(64),
      artifact_sha256: 'a'.repeat(64),
      score_type: 'reconstruction_error',
      threshold: 0.0001,
      total: 90,
      limit: 50,
      offset: 50,
      items: [
        {
          row_index: 260,
          timestamp: start,
          actual_label: 'normal',
          actual_code: 0,
          predicted_label: 'abnormal',
          predicted_code: 1,
          score: 0.00023,
        },
      ],
    };

    const fetcher = stubResponse(result);

    const received = await predictionApi.points(result.run_id, {
      model_key: 'autoencoder',
      split: 'validation',
      start_time: start,
      end_time: end,
      limit: 50,
      offset: 50,
    });

    const url = new URL(fetcher.mock.calls[0][0], 'https://local.test');

    expect(url.pathname).toBe(`/api/v1/runs/${result.run_id}/predictions`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model_key: 'autoencoder',
      split: 'validation',
      start_time: start,
      end_time: end,
      limit: '50',
      offset: '50',
    });
    expect(fetcher.mock.calls[0][1].credentials).toBe('include');
    expect(received.score_type).toBe('reconstruction_error');
    expect(received.items[0].score).toBe(0.00023);
  });

  it('Test 평가 전 서버의 거절을 유지하고 학습·선택·평가 요청을 자동 실행하지 않는다', async () => {
    const fetcher = stubResponse(
      {
        error: {
          code: 'TEST_NOT_EVALUATED',
          message: '선택한 모델의 Test 평가를 먼저 완료하세요.',
        },
      },
      409,
    );

    await expect(
      predictionApi.intervals('e'.repeat(32), {
        model_key: 'lightgbm',
        split: 'test',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'TEST_NOT_EVALUATED' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
});
