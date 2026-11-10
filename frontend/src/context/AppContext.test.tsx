import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './AppContext';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  datasets: vi.fn(),
  runs: vi.fn(),
  deleteDataset: vi.fn(),
  restoreDataset: vi.fn(),
  logout: vi.fn(),
  login: vi.fn(),
  guest: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  api: mocks,
  errorMessage: (error: Error) => error.message,
}));

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  mocks.me.mockResolvedValue({ user: { id: 1, username: 'tester', display_name: '테스터' } });
  mocks.datasets.mockResolvedValue({ items: [DEMO_DATASET_DETAIL.dataset], total: 1 });
  mocks.runs.mockResolvedValue({ items: [DEMO_RUN_DETAIL.run], total: 1 });
  mocks.deleteDataset.mockResolvedValue(undefined);
  mocks.restoreDataset.mockResolvedValue(DEMO_DATASET_DETAIL);
  mocks.logout.mockResolvedValue(undefined);
  mocks.guest.mockResolvedValue({
    user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
  });
});

describe('QR 게스트 세션', () => {
  it('같은 게스트가 QR로 다시 들어와도 안내용 데이터와 모델을 유지한다', async () => {
    mocks.me.mockResolvedValue({
      user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
    });

    const hook = renderHook(() => useApp(), { wrapper: AppProvider });

    await waitFor(() => expect(hook.result.current.datasets).toHaveLength(1));
    await act(() => hook.result.current.enterGuest());
    expect(hook.result.current.datasets).toEqual([DEMO_DATASET_DETAIL.dataset]);
    expect(hook.result.current.runs).toEqual([DEMO_RUN_DETAIL.run]);
    expect(hook.result.current.selectedDatasetId).toBe(DEMO_DATASET_DETAIL.dataset.id);
    expect(mocks.datasets).not.toHaveBeenCalled();
    expect(mocks.runs).not.toHaveBeenCalled();
  });

  it('guest=1은 자동 입장하지 않고 명시적인 게스트 입장 후 세션을 만든다', async () => {
    window.history.replaceState({}, '', '/?guest=1');
    mocks.me.mockRejectedValue(new Error('no session'));

    const hook = renderHook(() => useApp(), { wrapper: AppProvider });

    await waitFor(() => expect(hook.result.current.booting).toBe(false));
    expect(hook.result.current.user).toBeNull();
    expect(mocks.guest).not.toHaveBeenCalled();
    await act(() => hook.result.current.enterGuest());
    expect(hook.result.current.user?.is_guest).toBe(true);
    expect(mocks.guest).toHaveBeenCalledTimes(1);
    expect(mocks.me).toHaveBeenCalledTimes(1);
    expect(hook.result.current.mode).toBe('demo');
    expect(hook.result.current.datasets).toEqual([DEMO_DATASET_DETAIL.dataset]);
    expect(mocks.datasets).not.toHaveBeenCalled();
    await act(() => hook.result.current.logout());
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });

  it('새로고침에서 게스트 세션을 읽어 예시 모드를 복원한다', async () => {
    mocks.me.mockResolvedValue({
      user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
    });

    const hook = renderHook(() => useApp(), { wrapper: AppProvider });

    await waitFor(() => expect(hook.result.current.user?.is_guest).toBe(true));
    expect(hook.result.current.mode).toBe('demo');
    expect(mocks.datasets).not.toHaveBeenCalled();
  });

  it('QR로 들어온 기존 팀원은 실제 계정을 유지한다', async () => {
    window.history.replaceState({}, '', '/?guest=1');
    mocks.guest.mockResolvedValue({
      user: { id: 1, username: 'tester', display_name: '테스터', is_guest: false },
    });

    const hook = renderHook(() => useApp(), { wrapper: AppProvider });

    await waitFor(() => expect(hook.result.current.user?.id).toBe(1));
    expect(hook.result.current.mode).toBe('live');
    expect(mocks.guest).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.datasets).toHaveBeenCalledTimes(1));
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;

  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
}

async function loadContext() {
  const hook = renderHook(() => useApp(), { wrapper: AppProvider });

  await waitFor(() => expect(hook.result.current.datasets).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.runs).toHaveLength(1));
  return hook;
}

describe('CSV 선택 상태 보존', () => {
  it('업로드된 CSV를 즉시 공유 목록과 선택에 반영하고 기존 실행 선택은 보존한다', async () => {
    const hook = await loadContext();

    const uploaded = { ...DEMO_DATASET_DETAIL.dataset, id: 'new-upload', filename: 'new.csv' };

    act(() => {
      hook.result.current.setSelectedRunId(DEMO_RUN_DETAIL.run.id);
      hook.result.current.registerDataset(uploaded);
    });
    expect(hook.result.current.selectedDatasetId).toBe(uploaded.id);
    expect(hook.result.current.datasets[0]).toEqual(uploaded);
    expect(hook.result.current.selectedRunId).toBe(DEMO_RUN_DETAIL.run.id);
    expect(mocks.datasets).toHaveBeenCalledTimes(1);
  });

  it('삭제 성공 시 활성 CSV 선택만 해제하고 과거 모델 실행은 남긴다', async () => {
    const hook = await loadContext();

    act(() => {
      hook.result.current.setSelectedDatasetId(DEMO_DATASET_DETAIL.dataset.id);
      hook.result.current.setSelectedRunId(DEMO_RUN_DETAIL.run.id);
    });
    await act(() => hook.result.current.deleteDataset(DEMO_DATASET_DETAIL.dataset.id));
    expect(hook.result.current.datasets).toEqual([]);
    expect(hook.result.current.selectedDatasetId).toBeNull();
    expect(hook.result.current.runs).toEqual([DEMO_RUN_DETAIL.run]);
    expect(hook.result.current.selectedRunId).toBe(DEMO_RUN_DETAIL.run.id);
  });

  it('삭제가 실패하면 목록과 선택을 그대로 유지한다', async () => {
    const hook = await loadContext();

    mocks.deleteDataset.mockRejectedValue(new Error('삭제 실패'));
    act(() => hook.result.current.setSelectedDatasetId(DEMO_DATASET_DETAIL.dataset.id));
    await act(async () => {
      await expect(
        hook.result.current.deleteDataset(DEMO_DATASET_DETAIL.dataset.id),
      ).rejects.toThrow('삭제 실패');
    });
    expect(hook.result.current.datasets).toEqual([DEMO_DATASET_DETAIL.dataset]);
    expect(hook.result.current.selectedDatasetId).toBe(DEMO_DATASET_DETAIL.dataset.id);
  });

  it('복원한 CSV를 중복 없이 활성 목록과 선택에 되돌린다', async () => {
    const hook = await loadContext();

    await act(() => hook.result.current.deleteDataset(DEMO_DATASET_DETAIL.dataset.id));
    await act(() => hook.result.current.restoreDataset(DEMO_DATASET_DETAIL.dataset.id));
    await act(() => hook.result.current.restoreDataset(DEMO_DATASET_DETAIL.dataset.id));
    expect(hook.result.current.datasets).toEqual([DEMO_DATASET_DETAIL.dataset]);
    expect(hook.result.current.selectedDatasetId).toBe(DEMO_DATASET_DETAIL.dataset.id);
  });

  it('새 업로드보다 먼저 시작한 목록 응답이 새 CSV와 선택을 덮어쓰지 않는다', async () => {
    const hook = await loadContext();

    const pending = deferred<{ items: (typeof DEMO_DATASET_DETAIL.dataset)[] }>();

    const uploaded = { ...DEMO_DATASET_DETAIL.dataset, id: 'new-upload', filename: 'new.csv' };

    mocks.datasets.mockReturnValueOnce(pending.promise);

    let refresh!: Promise<void>;

    act(() => {
      refresh = hook.result.current.refreshDatasets();
    });
    act(() => hook.result.current.registerDataset(uploaded));
    await act(async () => {
      pending.resolve({ items: [DEMO_DATASET_DETAIL.dataset] });
      await refresh;
    });
    expect(hook.result.current.datasets[0]).toEqual(uploaded);
    expect(hook.result.current.selectedDatasetId).toBe(uploaded.id);
    expect(hook.result.current.datasetsLoading).toBe(false);
  });

  it('삭제 전 목록 응답이 나중에 도착해도 삭제한 CSV를 되살리지 않는다', async () => {
    const hook = await loadContext();

    const pending = deferred<{ items: (typeof DEMO_DATASET_DETAIL.dataset)[] }>();

    mocks.datasets.mockReturnValueOnce(pending.promise);

    let refresh!: Promise<void>;

    act(() => {
      refresh = hook.result.current.refreshDatasets();
    });
    await act(() => hook.result.current.deleteDataset(DEMO_DATASET_DETAIL.dataset.id));
    await act(async () => {
      pending.resolve({ items: [DEMO_DATASET_DETAIL.dataset] });
      await refresh;
    });
    expect(hook.result.current.datasets).toEqual([]);
    expect(hook.result.current.selectedDatasetId).toBeNull();
  });

  it('최초 목록 로딩 중 등록해도 늦은 최초 응답이 새 파일을 지우지 않는다', async () => {
    const pending = deferred<{ items: (typeof DEMO_DATASET_DETAIL.dataset)[] }>();

    const uploaded = { ...DEMO_DATASET_DETAIL.dataset, id: 'new-upload', filename: 'new.csv' };

    mocks.datasets.mockReturnValueOnce(pending.promise);

    const hook = renderHook(() => useApp(), { wrapper: AppProvider });

    await waitFor(() => expect(mocks.datasets).toHaveBeenCalledTimes(1));
    act(() => hook.result.current.registerDataset(uploaded));
    await act(async () => {
      pending.resolve({ items: [DEMO_DATASET_DETAIL.dataset] });
    });
    expect(hook.result.current.datasets).toEqual([uploaded]);
    expect(hook.result.current.selectedDatasetId).toBe(uploaded.id);
  });

  it('복원 응답을 기다리는 중 로그아웃하면 이전 계정의 CSV가 다시 나타나지 않는다', async () => {
    const hook = await loadContext();

    const pending = deferred<typeof DEMO_DATASET_DETAIL>();

    mocks.restoreDataset.mockReturnValueOnce(pending.promise);

    let restore!: Promise<void>;

    act(() => {
      restore = hook.result.current.restoreDataset(DEMO_DATASET_DETAIL.dataset.id);
    });
    await act(() => hook.result.current.logout());
    await act(async () => {
      pending.resolve(DEMO_DATASET_DETAIL);
      await restore;
    });
    expect(hook.result.current.user).toBeNull();
    expect(hook.result.current.datasets).toEqual([]);
    expect(hook.result.current.selectedDatasetId).toBeNull();
    expect(hook.result.current.datasetsLoading).toBe(false);
  });

  it('세션 만료 뒤 도착한 기존 계정 목록을 무시한다', async () => {
    const hook = await loadContext();

    const pending = deferred<{ items: (typeof DEMO_DATASET_DETAIL.dataset)[] }>();

    mocks.datasets.mockReturnValueOnce(pending.promise);

    let refresh!: Promise<void>;

    act(() => {
      refresh = hook.result.current.refreshDatasets();
    });
    act(() => window.dispatchEvent(new Event('kkobugi:unauthorized')));
    await act(async () => {
      pending.resolve({ items: [DEMO_DATASET_DETAIL.dataset] });
      await refresh;
    });
    expect(hook.result.current.user).toBeNull();
    expect(hook.result.current.datasets).toEqual([]);
  });
});
