import { useExpertise } from '../context/ExpertiseContext';
import './expertise.css';

export default function ExpertiseToggle() {
  const { expertise, setExpertise } = useExpertise();

  return (
    <div className="expertise-toggle" role="group" aria-label="설명 방식">
      <button
        type="button"
        aria-pressed={expertise === 'pro'}
        title="Pro · 쉬운 설명"
        onClick={() => setExpertise('pro')}
      >
        Pro
      </button>
      <button
        type="button"
        aria-pressed={expertise === 'pro-plus'}
        title="Pro+ · 전문 설정과 평가 지표"
        onClick={() => setExpertise('pro-plus')}
      >
        Pro+
      </button>
    </div>
  );
}
