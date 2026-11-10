import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  Database,
  FileText,
  FlaskConical,
  FolderOpen,
  Layers3,
  Plus,
  ScanLine,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { Badge, EmptyState, PageHeader } from '../components/ui';
import { number, dateTime } from '../lib/format';
import { demoSeries } from '../data/demo';

const STATUS = { queued: '대기 중', running: '학습 중', completed: '학습 완료', failed: '실패' };
function OverviewChart() {
  const points = demoSeries(),
    path = points
      .map((p, i) => `${i ? 'L' : 'M'}${(i / 359) * 720},${110 - ((p.value ?? 12) - 11.7) * 60}`)
      .join(' ');
  return (
    <svg
      className="overview-chart"
      viewBox="0 0 720 160"
      role="img"
      aria-label="예시 sensor_04 시계열. 실제 측정값이 아닙니다."
    >
      <defs>
        <linearGradient id="overview-area" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="var(--theme-primary, #417cc6)" stopOpacity=".15" />
          <stop offset="1" stopColor="var(--theme-primary, #417cc6)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[20, 60, 100, 140].map((y) => (
        <line key={y} x1="0" x2="720" y1={y} y2={y} stroke="var(--theme-border, #e6ebf1)" />
      ))}
      <path d={`${path}L720 145H0Z`} fill="url(#overview-area)" />
      <path d={path} fill="none" stroke="var(--theme-primary, #407bc1)" strokeWidth="2.1" />
      {[0, 120, 240, 359].map((i) => (
        <text
          key={i}
          x={(i / 359) * 720}
          y="159"
          fill="var(--theme-text-muted, #8090a4)"
          fontSize="10"
          textAnchor={i === 0 ? 'start' : i === 359 ? 'end' : 'middle'}
        >
          {points[i].timestamp.slice(11, 16)}
        </text>
      ))}
    </svg>
  );
}
export default function DashboardPage() {
  const { user, mode, datasets, runs, datasetsLoading, setSelectedDatasetId, setSelectedRunId } =
      useApp(),
    navigate = useNavigate();
  const completed = runs.filter((r) => r.status === 'completed'),
    checks = datasets.filter((d) => d.status === 'needs_review'),
    rows = datasets.reduce((n, d) => n + d.row_count, 0),
    latest = datasets[0];
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="WORKSPACE / OVERVIEW"
        title="분석 작업실"
        description={`${user?.display_name}님, 데이터와 진행 중인 분석을 확인하세요.`}
      >
        <Link to="/data" className="button primary">
          <Plus size={17} />
          데이터 등록
        </Link>
      </PageHeader>
      <section className="dashboard-stats" data-tour="dashboard-stats">
        {[
          {
            label: '등록한 데이터',
            value: number(datasets.length),
            unit: '개',
            icon: Database,
            note: `총 ${number(rows)}행`,
            tone: 'blue',
          },
          {
            label: '완료한 학습',
            value: number(completed.length),
            unit: '건',
            icon: FlaskConical,
            note: `전체 ${number(runs.length)}건`,
            tone: 'violet',
          },
          {
            label: '확인이 필요한 데이터',
            value: number(checks.length),
            unit: '개',
            icon: ScanLine,
            note: checks.length ? '검사 결과를 확인하세요' : '검사 이슈 없음',
            tone: 'amber',
          },
          {
            label: 'Test 평가 완료',
            value: number(runs.filter((r) => r.evaluation_status === 'completed').length),
            unit: '건',
            icon: CheckCheck,
            note: '선택한 모델의 최종 평가',
            tone: 'green',
          },
        ].map((item) => (
          <article className="surface stat-card" key={item.label}>
            <div className="stat-top">
              <span>{item.label}</span>
              <span className={`stat-icon ${item.tone}`}>
                <item.icon size={18} />
              </span>
            </div>
            <div className="stat-value">
              {item.value}
              <small>{item.unit}</small>
            </div>
            <p>{item.note}</p>
          </article>
        ))}
      </section>
      <div className="dashboard-main-grid">
        <section className="surface dashboard-data" data-tour="dashboard-data">
          <header className="section-heading">
            <div>
              <span className="eyebrow">CURRENT DATA</span>
              <h2>최근 등록한 데이터</h2>
            </div>
            <Link to="/data" className="text-link">
              전체 보기
              <ArrowUpRight size={15} />
            </Link>
          </header>
          {latest ? (
            <>
              <div className="dataset-identity">
                <span className="file-tile">
                  <FileText size={23} />
                </span>
                <div>
                  <h3>{latest.filename}</h3>
                  <p>
                    {number(latest.row_count)}행<span>·</span>
                    {latest.channels.length}개 채널
                  </p>
                </div>
                <Badge tone={latest.status === 'valid' ? 'green' : 'amber'}>
                  {latest.status === 'valid' ? '검사 통과' : '확인 필요'}
                </Badge>
              </div>
              {mode === 'demo' ? (
                <>
                  <div className="chart-caption">
                    <span>
                      <i />
                      sensor_04
                    </span>
                    <span>예시 값 · 단위 미확인</span>
                  </div>
                  <OverviewChart />
                </>
              ) : (
                <div className="data-ready-visual">
                  <div className="data-ready-icon">
                    <Layers3 size={40} strokeWidth={1} />
                  </div>
                  <div>
                    <h3>시계열을 확인할 준비가 됐어요.</h3>
                    <p>채널과 구간을 골라 원본 값을 확인하세요.</p>
                  </div>
                </div>
              )}
              <footer className="surface-footer">
                <span>
                  {mode === 'demo'
                    ? '화면 확인용 예시 데이터'
                    : `등록 ${dateTime(latest.created_at)}`}
                </span>
                <button
                  className="button secondary small"
                  onClick={() => {
                    setSelectedDatasetId(latest.id);
                    navigate('/review');
                  }}
                >
                  구간 확인
                  <ArrowRight size={15} />
                </button>
              </footer>
            </>
          ) : (
            <EmptyState
              icon={FolderOpen}
              title={datasetsLoading ? '데이터를 불러오는 중이에요' : '첫 데이터를 등록해보세요'}
              description="전처리한 CSV를 등록하면 시간·라벨·채널을 검사합니다."
              action={
                <Link to="/data" className="button secondary">
                  CSV 등록
                  <ArrowRight size={16} />
                </Link>
              }
            />
          )}
        </section>
        <section className="surface workflow-card">
          <span className="eyebrow">NEXT STEP</span>
          <h2>이렇게 이어가세요.</h2>
          <p className="muted">
            각 단계의 근거를 남겨
            <br />
            학습부터 점검과 보고서까지 연결합니다.
          </p>
          <ol className="workflow-steps">
            {[
              {
                to: '/data',
                title: '데이터 확인',
                desc: '시간 · 라벨 · 채널 검사',
                done: datasets.length > 0,
              },
              {
                to: '/models',
                title: '모델 학습',
                desc: '모델 선택 → 자동 설정 → 학습',
                done: completed.length > 0,
              },
              { to: '/review', title: '구간 확인', desc: '시계열과 현장 관찰 기록', done: false },
              { to: '/reports', title: '결과 정리', desc: '기록 확인 · 보고서 출력', done: false },
            ].map((s, i) => (
              <li key={s.to}>
                <span className={s.done ? 'step-number done' : 'step-number'}>
                  {s.done ? <Check size={13} /> : String(i + 1).padStart(2, '0')}
                </span>
                <Link to={s.to}>
                  <strong>{s.title}</strong>
                  <span>{s.desc}</span>
                </Link>
                <ArrowRight size={15} />
              </li>
            ))}
          </ol>
        </section>
      </div>
      <div className="dashboard-bottom-grid">
        <section className="surface">
          <header className="section-heading">
            <div>
              <span className="eyebrow">ANALYSIS HISTORY</span>
              <h2>최근 학습</h2>
            </div>
            <Link to="/models" className="text-link">
              모델 학습
              <ArrowUpRight size={15} />
            </Link>
          </header>
          {runs.length ? (
            <div className="recent-runs">
              {runs.slice(0, 4).map((run) => (
                <button
                  key={run.id}
                  onClick={() => {
                    setSelectedRunId(run.id);
                    navigate('/models');
                  }}
                >
                  <span className="run-icon">
                    <FlaskConical size={18} />
                  </span>
                  <span>
                    <strong>
                      {datasets.find((d) => d.id === run.dataset_id)?.filename ||
                        `학습 ${run.id.slice(0, 8)}`}
                    </strong>
                    <small>{dateTime(run.created_at)}</small>
                  </span>
                  <Badge
                    tone={
                      run.status === 'completed'
                        ? 'green'
                        : run.status === 'failed'
                          ? 'red'
                          : 'blue'
                    }
                  >
                    {STATUS[run.status]}
                  </Badge>
                  <ArrowUpRight size={17} />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={FlaskConical}
              title="아직 학습 기록이 없어요"
              description="데이터를 확인한 뒤 사용할 모델 하나를 골라주세요."
            />
          )}
        </section>
        <section className="surface validation-card">
          <header className="section-heading">
            <div>
              <span className="eyebrow">NEXT / SIMULATION</span>
              <h2>학습에서 점검으로</h2>
            </div>
          </header>
          <EmptyState
            title="학습한 모델로 실시간 신호를 확인하세요"
            description="생성한 데이터를 차례로 재생하고, 점검 신호를 문헌·현장 관찰·비용·보고서로 연결합니다."
            action={
              <Link to="/simulation" className="button primary">
                시뮬레이션 <ArrowRight size={16} />
              </Link>
            }
          />
        </section>
      </div>
    </div>
  );
}
