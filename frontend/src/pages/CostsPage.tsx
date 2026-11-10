import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, Calculator, Equal, Info, RotateCcw } from 'lucide-react';
import { Field, Notice, PageHeader } from '../components/ui';
import './review.css';

type Key = 'inspection' | 'parts' | 'labor' | 'downtime' | 'hourlyLoss';
type Scenario = Record<Key, string>;
const blank = (): Scenario => ({
  inspection: '',
  parts: '',
  labor: '',
  downtime: '',
  hourlyLoss: '',
});
const fields: { key: Key; label: string; unit: string; hint: string }[] = [
  { key: 'inspection', label: '점검비', unit: '원', hint: '진단·점검에 드는 비용' },
  { key: 'parts', label: '부품비', unit: '원', hint: '교체할 부품의 비용' },
  { key: 'labor', label: '작업비', unit: '원', hint: '인력·장비 투입 비용' },
  { key: 'downtime', label: '생산 정지 시간', unit: '시간', hint: '비교 기간 안의 정지 시간' },
  {
    key: 'hourlyLoss',
    label: '시간당 정지 손실',
    unit: '원/시간',
    hint: '사용자가 정한 동일한 산정 기준',
  },
];
export function scenarioTotal(value: Scenario): number | null {
  if (
    Object.values(value).some(
      (item) => item.trim() === '' || !Number.isFinite(Number(item)) || Number(item) < 0,
    )
  )
    return null;
  const total =
    Number(value.inspection) +
    Number(value.parts) +
    Number(value.labor) +
    Number(value.downtime) * Number(value.hourlyLoss);
  return Number.isFinite(total) ? total : null;
}
const money = (value: number | null) =>
  value == null ? '—' : `${Math.round(value).toLocaleString('ko-KR')}원`;

export default function CostsPage() {
  const [a, setA] = useState<Scenario>(blank),
    [b, setB] = useState<Scenario>(blank),
    [period, setPeriod] = useState('');
  const [aTitle, setATitle] = useState('지금 점검'),
    [bTitle, setBTitle] = useState('예정 시점 점검');
  const totalA = useMemo(() => scenarioTotal(a), [a]),
    totalB = useMemo(() => scenarioTotal(b), [b]);
  const difference = totalA != null && totalB != null ? totalB - totalA : null;
  const renderScenario = (
    scenario: Scenario,
    setScenario: (value: Scenario) => void,
    title: string,
    setTitle: (value: string) => void,
    label: string,
  ) => (
    <section className="surface rv-cost-card">
      <div className="rv-cost-card-heading">
        <span>{label}</span>
        <input
          className="rv-scenario-title"
          aria-label={`시나리오 ${label} 이름`}
          maxLength={40}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Calculator size={20} />
      </div>
      <div className="rv-cost-fields">
        {fields.map((field) => (
          <Field
            key={field.key}
            label={field.label}
            htmlFor={`cost-${label}-${field.key}`}
            hint={field.hint}
          >
            <div className="rv-unit-input">
              <input
                id={`cost-${label}-${field.key}`}
                type="number"
                min="0"
                step={field.key === 'downtime' ? '0.1' : '1'}
                inputMode="decimal"
                placeholder="직접 입력"
                value={scenario[field.key]}
                onChange={(e) => setScenario({ ...scenario, [field.key]: e.target.value })}
              />
              <span>{field.unit}</span>
            </div>
          </Field>
        ))}
      </div>
      <div className="rv-cost-total">
        <span>입력한 조건의 합계</span>
        <strong>{money(scenarioTotal(scenario))}</strong>
      </div>
    </section>
  );
  return (
    <div className="page-stack rv-page">
      <PageHeader
        eyebrow="COST SCENARIOS"
        title="비용 비교"
        description="같은 기간과 계산 기준으로 두 가지 대응안을 비교합니다."
      >
        <button
          className="button secondary"
          onClick={() => {
            setA(blank());
            setB(blank());
            setPeriod('');
          }}
        >
          <RotateCcw size={16} />
          입력 초기화
        </button>
      </PageHeader>
      <Notice>
        먼저 모델 결과와 현장 관찰을 확인하세요. 비용은 사용자가 입력한 가정으로 계산하며, 고장
        확률이나 실제 절감액을 예측하지 않습니다. <Link to="/models">모델 학습 보기 ↗</Link>
      </Notice>
      <section className="surface rv-cost-period" data-tour="costs-period">
        <div>
          <h2>비교할 기간</h2>
          <p>두 시나리오에 같은 기간과 범위를 적용해주세요.</p>
        </div>
        <input
          className="input"
          aria-label="비교 기간"
          placeholder="예: 다음 정기수리일까지 30일"
          maxLength={100}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
        />
      </section>
      <div className="rv-cost-grid" data-tour="costs-inputs">
        {renderScenario(a, setA, aTitle, setATitle, 'A')}
        {renderScenario(b, setB, bTitle, setBTitle, 'B')}
      </div>
      <section className="surface rv-cost-comparison" data-tour="costs-result">
        <div className="rv-comparison-icon">
          {difference == null || difference === 0 ? (
            <Equal size={24} />
          ) : difference > 0 ? (
            <ArrowDownRight size={26} />
          ) : (
            <ArrowUpRight size={26} />
          )}
        </div>
        <div>
          <h2>
            {difference == null
              ? '두 시나리오의 입력을 채워주세요'
              : difference === 0
                ? '입력한 조건의 비용이 같습니다'
                : `${difference > 0 ? aTitle || 'A' : bTitle || 'B'}의 계산 비용이 더 낮습니다`}
          </h2>
          <p>
            {difference == null
              ? '모든 항목에 0 이상의 값을 넣으면 비교 결과가 나옵니다. 비용이 없는 항목은 0을 입력하세요.'
              : `${period || '입력한 비교 범위'} · 추가 비용과 불확실성은 별도 검토가 필요합니다.`}
          </p>
        </div>
        <strong>
          {difference == null ? '—' : money(Math.abs(difference))}
          <small>계산 차이</small>
        </strong>
      </section>
      <section className="rv-cost-formula">
        <Info size={16} />
        <div>
          <strong>합계 = 점검비 + 부품비 + 작업비 + (정지 시간 × 시간당 정지 손실)</strong>
          <p>
            세금·할인율·실패 확률은 포함하지 않습니다. 결과는 입력값으로 즉시 계산하며 AI가 금액을
            생성하지 않습니다. 이 화면의 입력은 저장되지 않습니다.
          </p>
        </div>
      </section>
    </div>
  );
}
