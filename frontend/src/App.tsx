import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
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
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AppProvider, useApp, type ToastMessage } from './context/AppContext';
import LoginPage, { Brand } from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import AssistantPet from './components/AssistantPet';
import { Badge, Drawer, Notice } from './components/ui';
import { errorMessage } from './lib/api';

const DataPage = lazy(() => import('./pages/DataPage'));
const ModelsPage = lazy(() => import('./pages/ModelsPage'));
const ReviewPage = lazy(() => import('./pages/ReviewPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const CostsPage = lazy(() => import('./pages/CostsPage'));
const NAV = [
  { to: '/', label: '작업실', icon: LayoutDashboard },
  { to: '/data', label: '데이터', icon: Database },
  { to: '/models', label: '모델 비교', icon: FlaskConical },
  { to: '/review', label: '구간 확인', icon: ChartNoAxesCombined },
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
  const { datasets, runs, mode } = useApp();
  const [question, setQuestion] = useState(''),
    [messages, setMessages] = useState<{ role: 'user' | 'guide'; text: string }[]>([]);
  function ask(text: string) {
    if (!text.trim()) return;
    let answer =
      '현재는 화면 사용 안내를 제공합니다. 도메인 문서를 검색하는 RAG 답변은 서버 연결 후 사용할 수 있어요. 점검한 사실은 구간 확인에서 기록해주세요.';
    if (/모델|학습|비교/.test(text))
      answer = `현재 학습 기록은 ${runs.length}건이에요. 모델 비교에서 입력 채널과 시간 경계를 정한 뒤 학습하세요. Valid 지표를 비교해 직접 모델을 고르고, Test 평가는 마지막에 실행합니다.`;
    else if (/데이터|CSV|등록/.test(text))
      answer = `등록된 데이터는 ${datasets.length}개예요. 데이터 메뉴에서 전처리한 CSV를 넣고 시간 열·라벨 열·Normal/UnNormal 값을 지정하세요. 원본 값을 자동으로 고치지 않습니다.`;
    else if (/확대|그래프|구간/.test(text))
      answer =
        '구간 확인에서 채널을 선택하고 그래프를 드래그하세요. 선택 구간을 확대하거나 +/−로 보기 범위를 조정할 수 있어요. 확대 창에서도 기록한 구간과 현재 보기 범위는 구분됩니다.';
    else if (/보고|비용|저장/.test(text))
      answer =
        (mode === 'live'
          ? '관찰 기록은 내 계정의 서버 기록으로 저장됩니다. 작성과 수정 이력이 남고 다른 계정에는 공유되지 않아요.'
          : '미리보기의 관찰 기록은 이 브라우저의 임시 초안으로 저장됩니다.') +
        ' 보고서에서 모아서 출력할 수 있어요. 비용 비교는 직접 입력한 금액과 정지 시간을 계산하며, 실제 견적이나 AI 추정 비용이 아닙니다.';
    setMessages((m) => [...m, { role: 'user', text }, { role: 'guide', text: answer }]);
    setQuestion('');
  }
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="꼬부기와 함께"
      description="화면 사용 안내"
      className="assistant-drawer"
    >
      <div className="assistant-intro">
        <span className="assistant-avatar">✦</span>
        <h3>어디부터 시작할까요?</h3>
        <p>
          데이터 등록과 모델 비교 순서를
          <br />
          짧게 안내해드릴게요.
        </p>
      </div>
      <Notice>도메인 RAG와 AI API는 아직 연결되지 않았어요.</Notice>
      <div className="assistant-suggestions">
        {['CSV는 어떻게 등록해?', '모델은 어떤 순서로 비교해?', '그래프 구간을 확대하려면?'].map(
          (q) => (
            <button key={q} onClick={() => ask(q)}>
              {q}
              <ArrowRight size={14} />
            </button>
          ),
        )}
      </div>
      <div className="assistant-messages" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`assistant-message ${m.role}`}>
            <small>{m.role === 'guide' ? '화면 안내' : '나'}</small>
            <p>{m.text}</p>
          </div>
        ))}
      </div>
      <form
        className="assistant-composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          className="input"
          aria-label="사용 방법 질문"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="사용 방법을 물어보세요"
          maxLength={500}
        />
        <button className="button primary" aria-label="질문 보내기" disabled={!question.trim()}>
          <Send size={17} />
        </button>
      </form>
    </Drawer>
  );
}
function Shell() {
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
                '모델 비교',
                '입력 채널과 시간 경계를 정합니다. Train으로 학습하고 Valid 지표를 정렬해 비교하세요.',
              ],
              [
                '03',
                '직접 모델 선택',
                '순위가 높은 모델이 자동으로 선택되지는 않습니다. 목적에 맞는 지표를 보고 모델을 선택한 뒤 Test를 평가하세요.',
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
    <AppProvider>
      <AuthenticatedRoutes />
    </AppProvider>
  );
}
