import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
        if (!controller.signal.aborted) setUser(result.user);
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setBooting(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const expired = () => {
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
  }, [toast]);
  const refreshDatasets = useCallback(async () => {
    if (!user) return;
    if (mode === 'demo') {
      setDatasets([DEMO_DATASET_DETAIL.dataset]);
      return;
    }
    setDatasetsLoading(true);
    try {
      setDatasets((await api.datasets()).items);
    } finally {
      setDatasetsLoading(false);
    }
  }, [user?.id, mode]);
  const refreshRuns = useCallback(async () => {
    if (!user) return;
    if (mode === 'demo') {
      setRuns([DEMO_RUN_DETAIL.run]);
      return;
    }
    setRunsLoading(true);
    try {
      setRuns((await api.runs()).items);
    } finally {
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
    setDatasetsLoading(true);
    setRunsLoading(true);
    api
      .datasets(controller.signal)
      .then((r) => {
        if (active) setDatasets(r.items);
      })
      .catch((e) => {
        if (active) toast(errorMessage(e), 'error');
      })
      .finally(() => {
        if (active) setDatasetsLoading(false);
      });
    api
      .runs(controller.signal)
      .then((r) => {
        if (active) setRuns(r.items);
      })
      .catch((e) => {
        if (active) toast(errorMessage(e), 'error');
      })
      .finally(() => {
        if (active) setRunsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [user?.id, mode, toast]);
  const login = useCallback(async (username: string, password: string) => {
    const result = await api.login(username, password);
    sessionStorage.removeItem('kkobugi:preview');
    setMode('live');
    setSelectedDatasetId(null);
    setSelectedRunId(null);
    setDatasets([]);
    setRuns([]);
    setUser(result.user);
  }, []);
  const enterDemo = useCallback(() => {
    sessionStorage.setItem('kkobugi:preview', '1');
    setMode('demo');
    setUser({ id: 0, username: 'preview', display_name: '미리보기' });
  }, []);
  const logout = useCallback(async () => {
    if (mode === 'live') await api.logout();
    sessionStorage.removeItem('kkobugi:preview');
    setUser(null);
    setMode('live');
    setDatasets([]);
    setRuns([]);
    setSelectedDatasetId(null);
    setSelectedRunId(null);
  }, [mode]);
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
