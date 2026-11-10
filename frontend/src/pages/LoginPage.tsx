import { useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, LockKeyhole, LoaderCircle, Play, UserRound } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { errorMessage } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import LoginVideo from '../components/LoginVideo';
import ThemeToggle from '../components/ThemeToggle';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-mark">
        <img src="/assets/brand/mark.png" alt="" />
      </span>
      {!compact && (
        <span>
          kkobugi<span className="brand-period">.</span>
        </span>
      )}
    </div>
  );
}
export default function LoginPage() {
  const { login, enterDemo, enterGuest } = useApp();

  const navigate = useNavigate();

  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [visible, setVisible] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function visitAsGuest() {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      await enterGuest();
      navigate('/simulation', { replace: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page login-page-with-video">
      <section className="login-main">
        <header className="login-header">
          <Brand />
          <ThemeToggle />
        </header>
        <div className="login-form-wrap">
          <div className="eyebrow">
            <span className="tiny-rule" /> PUMP ANALYSIS WORKSPACE
          </div>
          <h1>
            데이터에서 찾고,
            <br />
            근거로 판단하세요.
          </h1>
          <p className="login-intro">
            펌프 모델 학습부터 실시간 점검,
            <br />
            점검 기록까지 한곳에서 이어갑니다.
          </p>
          <form onSubmit={submit} className="login-form">
            <div className="field">
              <label htmlFor="username">아이디</label>
              <div className="input-with-icon">
                <UserRound size={17} />
                <input
                  id="username"
                  name="username"
                  className="input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="팀 계정 아이디"
                  autoComplete="username"
                  required
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="password">비밀번호</label>
              <div className="input-with-icon">
                <LockKeyhole size={17} />
                <input
                  id="password"
                  name="password"
                  className="input"
                  type={visible ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="비밀번호 입력"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setVisible(!visible)}
                  aria-label={visible ? '비밀번호 숨기기' : '비밀번호 보기'}
                >
                  {visible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {error && (
              <p className="login-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary login-submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  로그인
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="login-separator">
            <span />
            또는
            <span />
          </div>
          <button className="button preview-button" onClick={visitAsGuest} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <UserRound size={15} />}
            게스트로 둘러보기
            <ArrowRight size={15} />
          </button>
          <button className="button preview-button" onClick={enterDemo} disabled={busy}>
            <Play size={15} />
            화면 미리보기
            <ArrowRight size={15} />
          </button>
          <p className="login-preview-note">미리보기는 예시 데이터로 열립니다.</p>
        </div>
        <footer className="login-footer">
          <span>KNDA · 팀 꼬부기</span>
          <span>분석은 함께, 판단은 근거 있게.</span>
        </footer>
      </section>
      <section className="login-visual login-video-panel">
        <div className="visual-topline">
          <span>ENGINEERED FOR CLARITY</span>
          <span>KKOBUGI / 2026</span>
        </div>
        <LoginVideo />
        <div className="visual-bottom">
          <span className="visual-index">01</span>
          <div>
            <strong>복잡한 데이터, 선명한 다음 단계.</strong>
            <p>확인하고 · 학습하고 · 기록하세요</p>
          </div>
          <div className="visual-pagination">
            <i />
            <i />
            <i />
          </div>
        </div>
      </section>
    </main>
  );
}
