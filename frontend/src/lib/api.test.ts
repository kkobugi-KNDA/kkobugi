import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import { axRequest } from './ax-api';

afterEach(() => vi.unstubAllGlobals());
describe('authenticated API transport', () => {
  it('explains an HTML gateway error without calling it invalid CSV or sending another request', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('<h1>Bad Gateway</h1>', { status: 502 })),
      );

    vi.stubGlobal('fetch', fetcher);
    for (const load of [
      () => api.datasets(),
      () => api.datasetFile('existing'),
      () => axRequest('/simulations'),
    ]) {
      await expect(load()).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining('서버가 잠시 응답하지 못하고'),
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('sends cookie credentials and the required mutation header without storing a token', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: 1, username: 'test', display_name: '확인' },
          expires_in: 60,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await api.login('test', 'test-only-password');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/v1/auth/login');
    expect(init.credentials).toBe('include');
    expect(init.headers.get('X-Requested-With')).toBe('kkobugi-web');
    expect(init.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ username: 'test', password: 'test-only-password' });
  });
  it('lets the browser set multipart boundaries', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const form = new FormData();
    form.append('file', new File(['timestamp,label\n2018-01-01,0'], 'test.csv'));
    await api.upload(form);
    const init = fetcher.mock.calls[0][1];
    expect(init.headers.has('Content-Type')).toBe(false);
    expect(init.body).toBe(form);
    expect(init.credentials).toBe('include');
  });
  it('clears an expired session through one event and preserves the server error', async () => {
    const listener = vi.fn();
    window.addEventListener('kkobugi:unauthorized', listener);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '다시 로그인해주세요.' } }),
            { status: 401 },
          ),
        ),
    );
    await expect(api.datasets()).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: '다시 로그인해주세요.',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('kkobugi:unauthorized', listener);
  });
  it('retains cancellation and reports a network failure separately', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));
    await expect(api.me(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(api.me()).rejects.toBeInstanceOf(ApiError);
    await expect(api.me()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
  });
  it('does not start Test when selecting a model', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await api.selectModel('run-id', 'lightgbm');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/runs/run-id/selection');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ model_key: 'lightgbm' });
  });
});
