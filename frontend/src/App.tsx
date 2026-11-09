import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  Activity,
  ArrowRight,
  Bell,
  BookOpen,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Coins,
  Database,
  FileText,
  FlaskConical,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Radio,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AppProvider, useApp, type ToastMessage } from './context/AppContext';
import LoginPage, { Brand } from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AssistantPet from './components/AssistantPet';
import AxAssistantPanel from './components/AxAssistantPanel';
import ExpertiseToggle from './components/ExpertiseToggle';
import { ExpertiseProvider, useExpertise } from './context/ExpertiseContext';
import { Badge, Drawer } from './components/ui';
import { errorMessage } from './lib/api';

const DataPage = lazy(() => import('./pages/DataPage'));
const ModelsPage = lazy(() => import('./pages/ModelsPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const CostsPage = lazy(() => import('./pages/CostsPage'));
const MonitorPage = lazy(() => import('./pages/MonitorPage'));
const SimulationPage = lazy(() => import('./pages/SimulationPage'));
const NAV = [
  { to: '/', label: '작업실', icon: LayoutDashboard },
  { to: '/data', label: '데이터', icon: Database },
  { to: '/models', label: '모델 학습 선택', icon: FlaskConical },
  { to: '/monitor', label: '실시간 모니터링', icon: Radio },
  { to: '/simulation', label: '시뮬레이션', icon: Play },
  { to: '/review', label: '시뮬레이션 보고서', icon: ChartNoAxesCombined },
  { to: '/reports', label: '보고서', icon: FileText },
  { to: '/costs', label: '비용 비교', icon: Coins },
];

function Toast({ message }: { message: ToastMessage }) {
  const { dismissToast } = useApp();
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(message.id), 6000);
    return () => clearTimeout(timer);
  }, [message.id, dismissToast]);
  return (
    <div
      className={`toast toast-${message.tone}`}
      role={message.tone === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-indicator">
        {message.tone === 'success' ? <Check size={15} /> : <Activity size={15} />}
      </span>
      <span>{message.text}</span>
      <button
        className="icon-button"
        aria-label="알림 닫기"
        onClick={() => dismissToast(message.id)}
      >
        <X size={15} />
      </button>
    </div>
  );
}
function Assistant({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { runs, selectedRunId } = useApp();

  const selectedRun = runs.find((run) => run.id === selectedRunId && run.status === 'completed');

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="점검 도우미"
      description="학습 결과와 문헌 근거를 함께 확인해요."
      className="assistant-drawer"
    >
      <AxAssistantPanel
        runId={selectedRun?.id || null}
        modelKey={selectedRun?.selected_model || null}
        split={selectedRun?.evaluation_status === 'completed' ? 'test' : 'validation'}
      />
    </Drawer>
  );
}
function Shell() {
  const { isExpert } = useExpertise();

  const { user, mode, logout, toast, runs } = useApp(),
    location = useLocation(),
    navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(
      () => localStorage.getItem('kkobugi:sidebar') === 'collapsed',
    ),
    [mobileOpen, setMobileOpen] = useState(false),
    [assistantOpen, setAssistantOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const current = NAV.find((n) => n.to === location.pathname) || NAV[0];
  const running = runs.filter((r) => r.status === 'running' || r.status === 'queued');
  const compact = collapsed && !mobileOpen;
  useEffect(() => {
    localStorage.setItem('kkobugi:sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);
  useEffect(() => {
    setMobileOpen(false);
    document.querySelector('.main-scroll')?.scrollTo(0, 0);
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [mobileOpen]);
  async function signout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate('/');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <Tooltip.Provider delayDuration={250}>
      <div
        className={`app-shell ${compact ? 'sidebar-collapsed' : ''} ${mobileOpen ? 'mobile-nav-open' : ''}`}
      >
        {mobileOpen && (
          <button
            className="mobile-scrim"
            aria-label="메뉴 닫기"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside className="sidebar" id="workspace-nav">
          <header className="sidebar-brand">
            <Brand compact={compact} />
            <button
              className="icon-button collapse-button"
              aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
              onClick={() => setCollapsed(!collapsed)}
            >
              {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            </button>
          </header>
          <div className="workspace-label">
            <span className="workspace-tile">K</span>
            {!compact && (
              <>
                <div>
                  <strong>팀 꼬부기</strong>
                  <small>Pump intelligence</small>
                </div>
                <ShieldCheck size={15} />
              </>
            )}
          </div>
          <div className="nav-caption">WORKSPACE</div>
          <nav aria-label="주 메뉴">
            {NAV.map(({ to, label, icon: Icon }) => (
              <Tooltip.Root key={to}>
                <Tooltip.Trigger asChild>
                  <NavLink
                    to={to}
                    end={to === '/'}
                    className={`nav-item ${location.pathname === to ? 'active' : ''}`}
                    aria-label={label}
                  >
                    <Icon size={20} strokeWidth={1.7} />
                    {!compact && (
                      <>
                        <span>{label}</span>
                        <ChevronRight className="nav-chevron" size={14} />
                      </>
                    )}
                  </NavLink>
                </Tooltip.Trigger>
                {compact && (
                  <Tooltip.Portal>
                    <Tooltip.Content className="tooltip" side="right" sideOffset={10}>
                      {label}
                      <Tooltip.Arrow />
                    </Tooltip.Content>
                  </Tooltip.Portal>
                )}
              </Tooltip.Root>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {!compact && (
              <div className="sidebar-note">
                <BookOpen size={19} />
                <strong>작은 근거도 남겨두세요.</strong>
                <p>
                  시계열과 현장 관찰을
                  <br />
                  함께 보며 판단하세요.
                </p>
                <button onClick={() => setHelpOpen(true)}>
                  작업 순서 보기
                  <ArrowRight size={13} />
                </button>
              </div>
            )}
            <button
              className="nav-item help-item"
              onClick={() => setHelpOpen(true)}
              aria-label="사용 안내"
            >
              <CircleHelp size={19} />
              {!compact && <span>사용 안내</span>}
            </button>
            <span className="sidebar-version">{compact ? 'v0.1' : 'KKOBUGI WORKSPACE · v0.1'}</span>
          </div>
        </aside>
        <div className="app-main" inert={mobileOpen}>
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="메뉴 열기"
                aria-expanded={mobileOpen}
                aria-controls="workspace-nav"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={20} />
              </button>
              <span>워크스페이스</span>
              <ChevronRight size={13} />
              <strong>{current.label}</strong>
            </div>
            <div className="topbar-actions">
              <ExpertiseToggle />
              {mode === 'demo' && <Badge tone="amber">미리보기 · 예시 데이터</Badge>}
              <Dropdown.Root>
                <Dropdown.Trigger asChild>
                  <button className="icon-button notification-button" aria-label="학습 상태 알림">
                    <Bell size={19} />
                    {running.length > 0 && <i />}
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content
                    align="end"
                    sideOffset={13}
                    className="dropdown-menu notification-menu"
                  >
                    <div className="dropdown-title">학습 상태</div>
                    {running.length ? (
                      running.map((r) => (
                        <Dropdown.Item
                          key={r.id}
                          className="dropdown-item"
                          onSelect={() => navigate('/models')}
                        >
                          <LoaderCircle size={16} className="spin" />
                          <span>
                            학습 {r.completed_models}/{r.total_models} 완료
                          </span>
                        </Dropdown.Item>
                      ))
                    ) : (
                      <p className="dropdown-empty">진행 중인 학습이 없어요.</p>
                    )}
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
              <span className="topbar-divider" />
              <Dropdown.Root>
                <Dropdown.Trigger asChild>
                  <button className="account-trigger" aria-label="계정 메뉴" disabled={loggingOut}>
                    <span className="account-avatar">{user?.display_name.slice(0, 1)}</span>
                    <span className="account-name">{user?.display_name}</span>
                    <ChevronDown size={13} />
                  </button>
                </Dropdown.Trigger>
                <Dropdown.Portal>
                  <Dropdown.Content align="end" sideOffset={13} className="dropdown-menu">
                    <div className="account-details">
                      <strong>{user?.display_name}</strong>
                      <span>@{user?.username}</span>
                    </div>
                    <Dropdown.Separator className="dropdown-separator" />
                    <Dropdown.Item className="dropdown-item" onSelect={signout}>
                      <LogOut size={16} />
                      로그아웃
                    </Dropdown.Item>
                  </Dropdown.Content>
                </Dropdown.Portal>
              </Dropdown.Root>
            </div>
          </header>
          {mode === 'demo' && (
            <div className="preview-banner">
              <span>
                <span className="preview-led" />
                화면 구성과 동작을 확인하는 미리보기입니다. 데이터와 학습 지표는 예시예요.
              </span>
              <button onClick={signout}>
                실제 계정으로 로그인
                <ArrowRight size={13} />
              </button>
            </div>
          )}
          <main className="main-scroll" id="main-content">
            <Suspense
              fallback={
                <div className="loading-screen">
                  <LoaderCircle className="spin" size={26} />
                  <p>화면을 불러오는 중이에요.</p>
                </div>
              }
            >
              <Outlet />
            </Suspense>
            <footer className="workspace-footer">
              <span>KKOBUGI — 근거를 연결하는 분석</span>
              <span>KNDA · 포스코 해커톤</span>
            </footer>
          </main>
        </div>
        <AssistantPet onOpen={() => setAssistantOpen(true)} working={running.length > 0} />
        <Assistant open={assistantOpen} onOpenChange={setAssistantOpen} />
        <Drawer
          open={helpOpen}
          onOpenChange={setHelpOpen}
          title="작업 순서"
          description="데이터에서 점검 기록까지"
        >
          <div className="help-guide">
            {[
              [
                '01',
                '데이터 검사',
                '전처리된 CSV를 등록하고 시각·라벨·채널을 지정하세요. 검사 통과는 데이터 형식이 학습 조건에 맞는다는 뜻입니다.',
              ],
              [
                '02',
                '모델 학습',
                isExpert
                  ? '입력 채널과 시간 분할·모델 옵션을 확인하고 한 모델을 학습합니다.'
                  : '사용할 AI 하나를 고르고 자동 설정을 확인한 뒤 학습하세요.',
              ],
              [
                '03',
                '실시간 모니터링',
                '학습한 모델의 최종 평가를 마치고 생성한 데이터를 재생하세요. 점검 신호와 직접 확인한 사실을 구분해 남깁니다.',
              ],
              [
                '04',
                '구간 확인과 기록',
                '그래프에서 구간을 드래그해 확대하세요. 직접 관찰한 내용을 모델 출력과 구분해서 남깁니다.',
              ],
              [
                '05',
                '보고서와 비용',
                '저장한 관찰을 모아 출력하고, 사용자가 정한 비용 조건으로 시나리오를 비교합니다.',
              ],
            ].map(([n, title, desc]) => (
              <section key={n}>
                <span>{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              </section>
            ))}
          </div>
        </Drawer>
      </div>
    </Tooltip.Provider>
  );
}
function AuthenticatedRoutes() {
  const { user, booting, toasts } = useApp();
  return (
    <>
      <a className="skip-link" href="#main-content">
        본문으로 이동
      </a>
      {booting ? (
        <div className="loading-screen initial-loading">
          <Brand />
          <LoaderCircle className="spin" size={25} />
        </div>
      ) : !user ? (
        <LoginPage />
      ) : (
        <Routes>
          <Route element={<Shell />}>
            <Route index element={<DashboardPage />} />
            <Route path="data" element={<DataPage />} />
            <Route path="models" element={<ModelsPage />} />
            <Route path="monitor" element={<MonitorPage />} />
            <Route path="simulation" element={<SimulationPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="costs" element={<CostsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      )}
      <div className="toast-stack">
        {toasts.map((message) => (
          <Toast key={message.id} message={message} />
        ))}
      </div>
    </>
  );
}
export default function App() {
  return (
    <ExpertiseProvider>
      <AppProvider>
        <AuthenticatedRoutes />
      </AppProvider>
    </ExpertiseProvider>
  );
}
