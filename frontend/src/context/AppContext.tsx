import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, errorMessage } from '../lib/api';
import { DEMO_DATASET_DETAIL, DEMO_RUN_DETAIL } from '../data/demo';
import type { AppMode, DatasetSummary, RunSummary, User } from '../types';

export interface ToastMessage {
  id: number;
  text: string;
  tone: 'success' | 'error' | 'info';
}
interface AppContextValue {
  user: User | null;
  mode: AppMode;
  booting: boolean;
  datasets: DatasetSummary[];
  runs: RunSummary[];
  datasetsLoading: boolean;
  runsLoading: boolean;
  selectedDatasetId: string | null;
  selectedRunId: string | null;
  setSelectedDatasetId: (id: string | null) => void;
  setSelectedRunId: (id: string | null) => void;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  enterDemo: () => void;
  refreshDatasets: () => Promise<void>;
  registerDataset: (dataset: DatasetSummary) => void;
  deleteDataset: (id: string) => Promise<void>;
  restoreDataset: (id: string) => Promise<void>;
  refreshRuns: () => Promise<void>;
  toast: (text: string, tone?: ToastMessage['tone']) => void;
  toasts: ToastMessage[];
  dismissToast: (id: number) => void;
}
const Context = createContext<AppContextValue | null>(null);
export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [mode, setMode] = useState<AppMode>('live');
  const [booting, setBooting] = useState(true),
    [datasets, setDatasets] = useState<DatasetSummary[]>([]),
    [runs, setRuns] = useState<RunSummary[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false),
    [runsLoading, setRunsLoading] = useState(false);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null),
    [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // 계정 전환과 목록 변경보다 먼저 시작한 응답은 현재 화면에 적용하지 않는다.
  const accountVersion = useRef(0);

  const datasetVersion = useRef(0);

  const runsVersion = useRef(0);

  const datasetMutations = useRef(new Map<string, number>());

  const invalidateAccount = useCallback(() => {
    accountVersion.current += 1;
    datasetVersion.current += 1;
    runsVersion.current += 1;
    datasetMutations.current.clear();
    setDatasetsLoading(false);
    setRunsLoading(false);
    return accountVersion.current;
  }, []);

  const toast = useCallback(
    (text: string, tone: ToastMessage['tone'] = 'info') =>
      setToasts((all) => [...all.slice(-2), { id: Date.now() + Math.random(), text, tone }]),
    [],
  );
  const dismissToast = useCallback(
    (id: number) => setToasts((all) => all.filter((t) => t.id !== id)),
    [],
  );
  useEffect(() => {
    const requestAccount = accountVersion.current;

    if (sessionStorage.getItem('kkobugi:preview') === '1') {
      setMode('demo');
      setUser({ id: 0, username: 'preview', display_name: '미리보기' });
      setBooting(false);
      return;
    }
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && accountVersion.current === requestAccount) {
          setUser(result.user);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted && accountVersion.current === requestAccount)
          setBooting(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const expired = () => {
      invalidateAccount();
      setUser(null);
      setMode('live');
      setDatasets([]);
      setRuns([]);
      setSelectedDatasetId(null);
      setSelectedRunId(null);
      toast('로그인 시간이 만료됐어요. 다시 로그인해주세요.', 'info');
    };
    window.addEventListener('kkobugi:unauthorized', expired);
    return () => window.removeEventListener('kkobugi:unauthorized', expired);
  }, [toast, invalidateAccount]);
  const refreshDatasets = useCallback(async () => {
    if (!user) return;
    if (mode === 'demo') {
      setDatasets([DEMO_DATASET_DETAIL.dataset]);
      return;
    }
    const requestAccount = accountVersion.current;

    const requestVersion = ++datasetVersion.current;

    setDatasetsLoading(true);
    try {
      const refreshedDatasets = (await api.datasets()).items;

      if (accountVersion.current !== requestAccount || datasetVersion.current !== requestVersion)
        return;
      setDatasets(refreshedDatasets);
      setSelectedDatasetId((current) =>
        current && refreshedDatasets.some((dataset) => dataset.id === current) ? current : null,
      );
    } finally {
      if (accountVersion.current === requestAccount && datasetVersion.current === requestVersion) {
        setDatasetsLoading(false);
      }
    }
  }, [user?.id, mode]);

  // 업로드 직후 목록 새로고침을 기다리지 않아도 비서가 새 CSV를 알 수 있게 한다.
  const registerDataset = useCallback((dataset: DatasetSummary) => {
    datasetVersion.current += 1;
    datasetMutations.current.set(dataset.id, (datasetMutations.current.get(dataset.id) || 0) + 1);
    setDatasetsLoading(false);
    setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)]);
    setSelectedDatasetId(dataset.id);
  }, []);

  const deleteDataset = useCallback(
    async (id: string) => {
      if (mode === 'demo') return;

      const requestAccount = accountVersion.current;

      const mutationVersion = (datasetMutations.current.get(id) || 0) + 1;

      datasetMutations.current.set(id, mutationVersion);
      datasetVersion.current += 1;
      setDatasetsLoading(false);
      await api.deleteDataset(id);
      if (
        accountVersion.current !== requestAccount ||
        datasetMutations.current.get(id) !== mutationVersion
      )
        return;
      datasetVersion.current += 1;
      setDatasetsLoading(false);
      // 원본과 과거 실행은 서버에 남긴다. 현재 CSV 선택과 활성 목록만 정리한다.
      setDatasets((current) => current.filter((dataset) => dataset.id !== id));
      setSelectedDatasetId((current) => (current === id ? null : current));
    },
    [mode],
  );

  const restoreDataset = useCallback(
    async (id: string) => {
      if (mode === 'demo') return;

      const requestAccount = accountVersion.current;

      const mutationVersion = (datasetMutations.current.get(id) || 0) + 1;

      datasetMutations.current.set(id, mutationVersion);
      datasetVersion.current += 1;
      setDatasetsLoading(false);

      const restored = await api.restoreDataset(id);

      if (
        accountVersion.current !== requestAccount ||
        datasetMutations.current.get(id) !== mutationVersion
      )
        return;
      registerDataset(restored.dataset);
    },
    [mode, registerDataset],
  );
  const refreshRuns = useCallback(async () => {
    if (!user) return;
    if (mode === 'demo') {
      setRuns([DEMO_RUN_DETAIL.run]);
      return;
    }
    const requestAccount = accountVersion.current;

    const requestVersion = ++runsVersion.current;

    setRunsLoading(true);
    try {
      const refreshedRuns = (await api.runs()).items;

      if (accountVersion.current === requestAccount && runsVersion.current === requestVersion)
        setRuns(refreshedRuns);
    } finally {
      if (accountVersion.current === requestAccount && runsVersion.current === requestVersion)
        setRunsLoading(false);
    }
  }, [user?.id, mode]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    if (mode === 'demo') {
      setDatasets([DEMO_DATASET_DETAIL.dataset]);
      setRuns([DEMO_RUN_DETAIL.run]);
      setSelectedDatasetId(DEMO_DATASET_DETAIL.dataset.id);
      setSelectedRunId(DEMO_RUN_DETAIL.run.id);
      return;
    }
    const controller = new AbortController();

    const requestAccount = accountVersion.current;

    const datasetRequestVersion = ++datasetVersion.current;

    const runsRequestVersion = ++runsVersion.current;

    setDatasetsLoading(true);
    setRunsLoading(true);
    api
      .datasets(controller.signal)
      .then((r) => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          datasetVersion.current === datasetRequestVersion
        )
          setDatasets(r.items);
      })
      .catch((e) => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          datasetVersion.current === datasetRequestVersion
        )
          toast(errorMessage(e), 'error');
      })
      .finally(() => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          datasetVersion.current === datasetRequestVersion
        )
          setDatasetsLoading(false);
      });
    api
      .runs(controller.signal)
      .then((r) => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          runsVersion.current === runsRequestVersion
        )
          setRuns(r.items);
      })
      .catch((e) => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          runsVersion.current === runsRequestVersion
        )
          toast(errorMessage(e), 'error');
      })
      .finally(() => {
        if (
          active &&
          accountVersion.current === requestAccount &&
          runsVersion.current === runsRequestVersion
        )
          setRunsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [user?.id, mode, toast]);
  const login = useCallback(
    async (username: string, password: string) => {
      const requestAccount = invalidateAccount();

      const result = await api.login(username, password);

      if (accountVersion.current !== requestAccount) return;
      sessionStorage.removeItem('kkobugi:preview');
      setMode('live');
      setSelectedDatasetId(null);
      setSelectedRunId(null);
      setDatasets([]);
      setRuns([]);
      setUser(result.user);
      setBooting(false);
    },
    [invalidateAccount],
  );
  const enterDemo = useCallback(() => {
    invalidateAccount();
    sessionStorage.setItem('kkobugi:preview', '1');
    setMode('demo');
    setUser({ id: 0, username: 'preview', display_name: '미리보기' });
    setBooting(false);
  }, [invalidateAccount]);
  const logout = useCallback(async () => {
    const requestAccount = invalidateAccount();

    if (mode === 'live') await api.logout();
    if (accountVersion.current !== requestAccount) return;
    sessionStorage.removeItem('kkobugi:preview');
    setUser(null);
    setMode('live');
    setDatasets([]);
    setRuns([]);
    setSelectedDatasetId(null);
    setSelectedRunId(null);
    setBooting(false);
  }, [mode, invalidateAccount]);
  const value = useMemo(
    () => ({
      user,
      mode,
      booting,
      datasets,
      runs,
      datasetsLoading,
      runsLoading,
      selectedDatasetId,
      selectedRunId,
      setSelectedDatasetId,
      setSelectedRunId,
      login,
      logout,
      enterDemo,
      refreshDatasets,
      registerDataset,
      deleteDataset,
      restoreDataset,
      refreshRuns,
      toast,
      toasts,
      dismissToast,
    }),
    [
      user,
      mode,
      booting,
      datasets,
      runs,
      datasetsLoading,
      runsLoading,
      selectedDatasetId,
      selectedRunId,
      login,
      logout,
      enterDemo,
      refreshDatasets,
      registerDataset,
      deleteDataset,
      restoreDataset,
      refreshRuns,
      toast,
      toasts,
      dismissToast,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error('AppProvider is required');
  return value;
}
