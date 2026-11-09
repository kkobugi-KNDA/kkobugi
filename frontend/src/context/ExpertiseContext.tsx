import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Expertise = 'pro' | 'pro-plus';

interface ExpertiseValue {
  expertise: Expertise;
  isExpert: boolean;
  setExpertise: (value: Expertise) => void;
}

const ExpertiseContext = createContext<ExpertiseValue | null>(null);

const STORAGE_KEY = 'kkobugi:expertise';

function savedExpertise(): Expertise {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'pro-plus' ? 'pro-plus' : 'pro';
  } catch {
    return 'pro';
  }
}

export function ExpertiseProvider({ children }: { children: ReactNode }) {
  const [expertise, setExpertise] = useState<Expertise>(savedExpertise);

  useEffect(() => {
    try {
      // 설명 방식만 기억한다. 계정 권한이나 서버의 결과는 바꾸지 않는다.
      localStorage.setItem(STORAGE_KEY, expertise);
    } catch {
      // 저장이 막힌 브라우저에서도 현재 화면의 전환은 계속 사용할 수 있다.
    }
  }, [expertise]);

  return (
    <ExpertiseContext.Provider
      value={{ expertise, isExpert: expertise === 'pro-plus', setExpertise }}
    >
      {children}
    </ExpertiseContext.Provider>
  );
}

export function useExpertise(): ExpertiseValue {
  const context = useContext(ExpertiseContext);

  if (!context) throw new Error('ExpertiseProvider 안에서 설명 방식을 선택해주세요.');
  return context;
}
