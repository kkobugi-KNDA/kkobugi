import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, Check, Compass, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GUIDE_SECTIONS } from '../lib/guest-guide-steps';
import './guest-guide.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const STEPS = GUIDE_SECTIONS.flatMap((section, sectionIndex) =>
  section.steps.map((step) => ({ ...step, path: section.path, sectionIndex })),
);

function firstStepForPath(path: string) {
  const index = STEPS.findIndex((step) => step.path === path);

  return index < 0 ? 0 : index;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));
}

/** 설명에 필요한 화면만 이동한다. 업로드·학습·저장 버튼은 누르지 않는다. */
export default function GuestGuide({ open, onClose }: Props) {
  const location = useLocation();

  const navigate = useNavigate();

  const [stepIndex, setStepIndex] = useState(() => firstStepForPath(location.pathname));

  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);

  const [targetStatus, setTargetStatus] = useState<'looking' | 'found' | 'missing'>('looking');

  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  const [cardHeight, setCardHeight] = useState(300);

  const cardRef = useRef<HTMLDivElement>(null);

  const openerRef = useRef<HTMLElement | null>(null);

  const wasOpen = useRef(false);

  const step = STEPS[stepIndex];

  const mobile = viewport.width <= 700 || viewport.height <= 500;

  useEffect(() => {
    if (open && !wasOpen.current) setStepIndex(firstStepForPath(location.pathname));
    wasOpen.current = open;
  }, [open, location.pathname]);

  useEffect(() => {
    if (!open || !step) return;
    setTargetRect(null);
    setTargetStatus('looking');

    let animationFrame = 0;

    let disposed = false;

    let observedTarget: HTMLElement | null = null;

    let positionedTarget: HTMLElement | null = null;

    const requestMeasure = () => {
      if (!disposed && !animationFrame) animationFrame = requestAnimationFrame(measure);
    };

    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(requestMeasure);

    function measure() {
      animationFrame = 0;
      if (disposed) return;

      const width = window.visualViewport?.width || window.innerWidth;

      const height = window.visualViewport?.height || window.innerHeight;

      const measuredCardHeight = cardRef.current?.getBoundingClientRect().height || 300;

      const compact = width <= 700 || height <= 500;

      const sideCard = width >= 600 && height <= 450;

      setViewport((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
      setCardHeight((current) => (current === measuredCardHeight ? current : measuredCardHeight));

      const target =
        location.pathname === step.path ? document.querySelector<HTMLElement>(step.target) : null;

      if (target !== observedTarget) {
        if (observedTarget) resizeObserver?.unobserve(observedTarget);
        observedTarget = target;
        if (target) resizeObserver?.observe(target);
      }
      if (!target) {
        setTargetRect(null);
        return;
      }

      const initialRect = target.getBoundingClientRect();

      if (!initialRect.width || !initialRect.height) {
        setTargetRect(null);
        return;
      }

      const scrollArea = target.closest<HTMLElement>('.main-scroll');

      // 페이지 전환 뒤 목표를 한 번만 이동한다. 사용자의 스크롤을 계속 빼앗지 않는다.
      if (positionedTarget !== target) {
        positionedTarget = target;
        target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
        if (compact && !sideCard && scrollArea) {
          const visibleTop = Math.max(12, scrollArea.getBoundingClientRect().top);

          const visibleBottom = Math.max(visibleTop + 48, height - measuredCardHeight - 28);

          const targetAfterScroll = target.getBoundingClientRect();

          const availableHeight = visibleBottom - visibleTop;

          const oversized = targetAfterScroll.height > availableHeight;

          const targetPoint = oversized
            ? targetAfterScroll.top
            : targetAfterScroll.top + targetAfterScroll.height / 2;

          const desiredPoint = oversized ? visibleTop + 12 : (visibleTop + visibleBottom) / 2;

          scrollArea.scrollTop += targetPoint - desiredPoint;
        }
      }
      const rectangle = target.getBoundingClientRect();

      const scrollRectangle = scrollArea?.getBoundingClientRect();

      const left = Math.max(8, rectangle.left - 6, scrollRectangle?.left || 0);

      const top = Math.max(8, rectangle.top - 6, scrollRectangle?.top || 0);

      const right = Math.min(
        sideCard ? width - Math.min(360, width * 0.48) - 24 : width - 8,
        rectangle.right + 6,
        scrollRectangle?.right || width,
      );

      const bottom = Math.min(
        height - (compact && !sideCard ? measuredCardHeight + 20 : 8),
        rectangle.bottom + 6,
        scrollRectangle?.bottom || height,
      );

      if (right <= left || bottom <= top) {
        setTargetRect(null);
        return;
      }

      const nextRectangle = { left, top, width: right - left, height: bottom - top };

      setTargetRect((current) =>
        current &&
        Object.keys(nextRectangle).every(
          (key) => current[key as keyof TargetRect] === nextRectangle[key as keyof TargetRect],
        )
          ? current
          : nextRectangle,
      );
      setTargetStatus('found');
    }

    // Lazy 페이지의 앵커가 늦게 생겨도 찾되, 찾지 못한 요소 때문에 진행을 막지 않는다.
    const mutationObserver = new MutationObserver(requestMeasure);

    mutationObserver.observe(document.body, { childList: true, subtree: true });
    if (cardRef.current) resizeObserver?.observe(cardRef.current);
    window.addEventListener('resize', requestMeasure);
    window.addEventListener('scroll', requestMeasure, true);
    window.visualViewport?.addEventListener('resize', requestMeasure);
    requestMeasure();

    const retryLimit = window.setTimeout(() => {
      mutationObserver.disconnect();
      if (!disposed) setTargetStatus((current) => (current === 'found' ? current : 'missing'));
    }, 8000);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      window.clearTimeout(retryLimit);
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', requestMeasure);
      window.removeEventListener('scroll', requestMeasure, true);
      window.visualViewport?.removeEventListener('resize', requestMeasure);
    };
  }, [open, step, location.pathname]);

  function goToStep(index: number) {
    const nextIndex = clamp(index, 0, STEPS.length - 1);

    const next = STEPS[nextIndex];

    if (!next) return;
    setTargetRect(null);
    setStepIndex(nextIndex);
    if (location.pathname !== next.path) navigate(next.path);
  }

  function finish() {
    try {
      localStorage.setItem('kkobugi:guest-guide-completed', '1');
    } catch {
      /* 저장이 막혀도 안내를 닫을 수 있다. */
    }
    onClose();
  }

  const cardWidth = Math.min(376, viewport.width - 32);

  let cardLeft = viewport.width - cardWidth - 16;

  let cardTop = viewport.height - cardHeight - 16;

  if (targetRect && !mobile) {
    const rightSpace = viewport.width - targetRect.left - targetRect.width - 16;

    if (rightSpace >= cardWidth + 16) {
      cardLeft = targetRect.left + targetRect.width + 16;
      cardTop = targetRect.top;
    } else if (targetRect.left >= cardWidth + 32) {
      cardLeft = targetRect.left - cardWidth - 16;
      cardTop = targetRect.top;
    } else if (targetRect.top >= cardHeight + 32) {
      cardTop = targetRect.top - cardHeight - 16;
    }
  }
  const cardStyle: CSSProperties = mobile
    ? {}
    : {
        left: clamp(cardLeft, 16, viewport.width - cardWidth - 16),
        top: clamp(cardTop, 16, viewport.height - cardHeight - 16),
        width: cardWidth,
      };

  if (!step) return null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className={`guest-guide-overlay ${targetRect ? '' : 'guest-guide-overlay--solid'}`}
        />
        {open && targetRect && (
          <div className="guest-guide-spotlight" style={targetRect} aria-hidden="true" />
        )}
        <Dialog.Content
          ref={cardRef}
          className={`guest-guide-card ${mobile ? 'guest-guide-card--compact' : ''}`}
          style={cardStyle}
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (openerRef.current?.isConnected) openerRef.current.focus({ preventScroll: true });
          }}
        >
          <header className="guest-guide-header">
            <span className="guest-guide-symbol">
              <Compass size={20} aria-hidden="true" />
            </span>
            <Dialog.Title>포부기가 안내해요</Dialog.Title>
            <button
              type="button"
              className="guest-guide-icon"
              aria-label="안내 닫기"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </header>
          <div className="guest-guide-chapter">
            <label htmlFor="guest-guide-chapter">안내할 메뉴</label>
            <select
              id="guest-guide-chapter"
              aria-label="안내할 메뉴 선택"
              value={step.sectionIndex}
              onChange={(event) =>
                goToStep(
                  STEPS.findIndex((item) => item.sectionIndex === Number(event.target.value)),
                )
              }
            >
              {GUIDE_SECTIONS.map((section, index) => (
                <option key={section.path} value={index}>
                  {section.label}
                </option>
              ))}
            </select>
            <span className="guest-guide-progress" aria-label="안내 진행">
              {stepIndex + 1} / {STEPS.length}
            </span>
          </div>
          <div className="guest-guide-copy" aria-live="polite" aria-atomic="true">
            <h3>{step.title}</h3>
            <Dialog.Description>{step.body}</Dialog.Description>
            {!targetRect && (
              <p className="guest-guide-fallback" role="status">
                {targetStatus === 'looking'
                  ? '화면 위치를 확인하고 있어요. 다음 안내로 바로 넘어가도 돼요.'
                  : '이 화면에서는 해당 영역을 표시하지 못했어요. 설명을 읽고 다음으로 이동할 수 있어요.'}
              </p>
            )}
          </div>
          <footer className="guest-guide-footer">
            <button type="button" className="guest-guide-skip" onClick={onClose}>
              안내 건너뛰기
            </button>
            <div>
              <button
                type="button"
                className="guest-guide-previous"
                disabled={stepIndex === 0}
                onClick={() => goToStep(stepIndex - 1)}
              >
                <ArrowLeft size={16} aria-hidden="true" /> 이전
              </button>
              <button
                type="button"
                className="guest-guide-next"
                onClick={stepIndex === STEPS.length - 1 ? finish : () => goToStep(stepIndex + 1)}
              >
                {stepIndex === STEPS.length - 1 ? (
                  <>
                    <Check size={16} aria-hidden="true" /> 안내 마치기
                  </>
                ) : (
                  <>
                    다음 <ArrowRight size={16} aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
