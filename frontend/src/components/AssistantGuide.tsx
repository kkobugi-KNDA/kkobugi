import { useEffect, useRef } from 'react';
import { MessageCircle } from 'lucide-react';
import { openPetAssistant, type AssistantOpenDetail } from '../lib/assistant-events';
import { ASSISTANT_GUIDANCE_EVENT, registerAssistantGuide } from '../lib/assistant-guidance';
import './assistant-guide.css';

export interface AssistantGuideProps {
  id: string;
  title: string;
  message: string;
  details?: string[];
  context?: AssistantOpenDetail;
  question?: string;
}

/** 안내 끝에 자리를 마련하면, 전역 포석호 한 마리가 이 위치로 찾아온다. */
export default function AssistantGuide({
  id,
  title,
  message,
  details = [],
  context,
  question,
}: AssistantGuideProps) {
  const slotRef = useRef<HTMLDivElement>(null);

  // 별도 모델 문맥이 없어도 안내별 초안이 일반 대화와 구분되게 한다.
  const guideContext = { ...context, contextKey: context?.contextKey ?? `guide:${id}` };

  useEffect(() => {
    const slot = slotRef.current;

    if (!slot) return;
    return registerAssistantGuide({ id, slot, context: guideContext, question });
  }, [id, guideContext, question, title, message, details]);

  return (
    <aside className="assistant-guide" aria-labelledby={`assistant-guide-${id}`}>
      <div className="assistant-guide-bubble">
        <span className="assistant-guide-speaker">포석호의 안내</span>
        <h3 id={`assistant-guide-${id}`}>{title}</h3>
        <p>{message}</p>
        {details.length > 0 && (
          <details
            className="assistant-guide-details"
            onToggle={() => window.dispatchEvent(new Event(ASSISTANT_GUIDANCE_EVENT))}
          >
            <summary>자세히 확인하기</summary>
            <ul>
              {details.map((detail, index) => (
                <li key={index}>{detail}</li>
              ))}
            </ul>
          </details>
        )}
        <button
          type="button"
          className="assistant-guide-ask"
          onClick={() => openPetAssistant({ ...guideContext, initialQuestion: question })}
        >
          <MessageCircle size={15} aria-hidden="true" /> 포석호에게 물어보기
        </button>
      </div>
      {/* 이미지는 복제하지 않는다. 기존 캐릭터가 이 빈 자리로 이동한다. */}
      <div
        ref={slotRef}
        className="assistant-guide-pet-slot"
        data-assistant-guide-slot={id}
        aria-hidden="true"
      />
    </aside>
  );
}
