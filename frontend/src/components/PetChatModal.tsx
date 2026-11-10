import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MessageCircle, X } from 'lucide-react';
import './pet-chat-modal.css';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** 닫힌 dialog 안의 대화도 그대로 보관해 열고 닫을 때 대화가 사라지지 않는다. */
export default function PetChatModal({ open, onOpenChange, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [motion, setMotion] = useState<'opening' | 'ready' | 'closing'>('ready');

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) return;
    const pet = document.querySelector<HTMLElement>('.assistant-pet-button');

    const position = pet?.getBoundingClientRect();

    dialog.style.setProperty(
      '--pet-x',
      `${(position ? position.left + position.width / 2 : window.innerWidth - 75) - window.innerWidth / 2}px`,
    );
    dialog.style.setProperty(
      '--pet-y',
      `${(position ? position.top + position.height / 2 : window.innerHeight - 90) - window.innerHeight / 2}px`,
    );
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (open) {
      if (!dialog.open) dialog.showModal();
      setMotion(reducedMotion ? 'ready' : 'opening');
      return;
    }
    if (!dialog.open) return;
    const finish = () => {
      dialog.close();
      pet?.focus({ preventScroll: true });
      setMotion('ready');
    };

    if (reducedMotion) {
      finish();
      return;
    }
    setMotion('closing');
    // 애니메이션 이벤트가 오지 않는 환경에서도 열린 모달을 남기지 않는다.
    const timer = setTimeout(finish, 380);

    return () => clearTimeout(timer);
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="pet-chat-dialog"
      data-motion={motion}
      aria-labelledby="pet-chat-title"
      aria-describedby="pet-chat-description"
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && open) setMotion('ready');
      }}
    >
      <header className="pet-chat-header">
        <div className="pet-chat-avatar">
          <MessageCircle size={23} />
        </div>
        <div>
          <h2 id="pet-chat-title">포부기 점검 도우미</h2>
          <p id="pet-chat-description">
            점검 내용을 편하게 물어보세요. 비용은 나중에 입력해도 돼요.
          </p>
        </div>
        <button
          className="pet-chat-close"
          aria-label="포부기 채팅 닫기"
          onClick={() => onOpenChange(false)}
        >
          <X size={20} />
        </button>
      </header>
      <div className="pet-chat-body">{children}</div>
    </dialog>
  );
}
