import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { MessageCircle, X } from 'lucide-react';
import './assistant-pet.css';

type Animation = { row: number; frameCount: number; durationsMs: number[]; label: string };
type Atlas = {
  name: string;
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  animations: Record<string, Animation>;
  reducedMotion: { animation: string; frame: number };
};
type Point = { x: number; y: number };
type Gesture = Point & { pointerId: number; origin: Point; moved: boolean };

const WIDTH = 112;
const HEIGHT = 122;
const MARGIN = 18;
const ASSETS = '/assets/pet/';

function isAtlas(value: unknown): value is Atlas {
  if (!value || typeof value !== 'object') return false;
  const atlas = value as Atlas;
  if (
    ![atlas.width, atlas.height, atlas.cellWidth, atlas.cellHeight].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return false;
  if (!atlas.animations || !atlas.reducedMotion || !atlas.animations[atlas.reducedMotion.animation])
    return false;
  return ['idle', 'waving', 'running', 'running-left', 'running-right'].every((name) => {
    const animation = atlas.animations[name];
    return (
      animation &&
      Number.isInteger(animation.row) &&
      animation.row >= 0 &&
      Number.isInteger(animation.frameCount) &&
      animation.frameCount > 0 &&
      animation.durationsMs?.length === animation.frameCount &&
      animation.durationsMs.every((duration) => Number.isFinite(duration) && duration >= 30)
    );
  });
}

export function clampPetPosition(point: Point, viewport: { width: number; height: number }): Point {
  return {
    x: Math.max(MARGIN, Math.min(point.x, Math.max(MARGIN, viewport.width - WIDTH - MARGIN))),
    y: Math.max(MARGIN, Math.min(point.y, Math.max(MARGIN, viewport.height - HEIGHT - MARGIN))),
  };
}

/** Web mascot only. Opening the assistant is delegated to the workspace. */
export default function AssistantPet({
  onOpen,
  working = false,
  notice = '',
  onDismissNotice,
}: {
  onOpen: () => void;
  working?: boolean;
  notice?: string;
  onDismissNotice?: () => void;
}) {
  const [atlas, setAtlas] = useState<Atlas | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [position, setPosition] = useState<Point>({ x: 0, y: 0 });
  const [placed, setPlaced] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [transient, setTransient] = useState<string | null>(null);
  const [dragDirection, setDragDirection] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    let image: HTMLImageElement | null = null;
    async function load() {
      try {
        const response = await fetch(`${ASSETS}animations.json`, { signal: controller.signal });
        if (!response.ok) throw new Error('Pet metadata could not be loaded.');
        const metadata: unknown = await response.json();
        if (!isAtlas(metadata) || !alive) return;
        setAtlas(metadata);
        // WebP first, one PNG fallback. No repeated reloads or cache-busting requests.
        const loadImage = (url: string, fallback?: string) => {
          image = new Image();
          image.onload = () => {
            if (alive) setImageUrl(url);
          };
          image.onerror = () => {
            if (alive && fallback) loadImage(fallback);
          };
          image.src = url;
        };
        loadImage(`${ASSETS}spritesheet-extended.webp`, `${ASSETS}spritesheet-extended.png`);
      } catch {
        /* The accessible message button stays available when assets are missing. */
      }
    }
    void load();
    return () => {
      alive = false;
      controller.abort();
      if (image) {
        image.onload = null;
        image.onerror = null;
      }
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    const size = viewport();
    setPosition(
      clampPetPosition({ x: size.width - WIDTH - 30, y: size.height - HEIGHT - 24 }, size),
    );
    setPlaced(true);
    const resize = () => setPosition((previous) => clampPetPosition(previous, viewport()));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const requestedAnimation = dragDirection ?? transient ?? (working ? 'running' : 'idle');
  const animationName = reducedMotion && atlas ? atlas.reducedMotion.animation : requestedAnimation;
  const animation = atlas?.animations[animationName] ?? atlas?.animations.idle;

  useEffect(() => {
    if (!animation || !atlas) return;
    if (reducedMotion) {
      setFrame(atlas.reducedMotion.frame);
      return;
    }
    let current = 0;
    let timeout: ReturnType<typeof setTimeout>;
    setFrame(0);
    const advance = () => {
      current += 1;
      if (current >= animation.frameCount) {
        if (animationName === 'waving') {
          setTransient(null);
          return;
        }
        current = 0;
      }
      setFrame(current);
      timeout = setTimeout(advance, animation.durationsMs[current]);
    };
    timeout = setTimeout(advance, animation.durationsMs[0]);
    return () => clearTimeout(timeout);
  }, [animation, animationName, atlas, reducedMotion]);

  const wave = () => {
    if (!working && !gesture.current) setTransient('waving');
  };
  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      origin: position,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) < 6) return;
    current.moved = true;
    suppressClick.current = true;
    setTransient(null);
    setDragDirection(dx < 0 ? 'running-left' : 'running-right');
    setPosition(
      clampPetPosition(
        { x: current.origin.x + dx, y: current.origin.y + dy },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  };
  const finishGesture = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!gesture.current || gesture.current.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDragDirection(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const spriteStyle: CSSProperties | undefined =
    atlas && animation && imageUrl
      ? {
          width: WIDTH,
          height: (WIDTH * atlas.cellHeight) / atlas.cellWidth,
          backgroundImage: `url("${imageUrl}")`,
          backgroundSize: `${(atlas.width * WIDTH) / atlas.cellWidth}px ${(atlas.height * WIDTH) / atlas.cellWidth}px`,
          backgroundPosition: `${-Math.min(frame, animation.frameCount - 1) * WIDTH}px ${(-animation.row * atlas.cellHeight * WIDTH) / atlas.cellWidth}px`,
        }
      : undefined;

  return (
    <div
      className={`assistant-pet ${dragDirection ? 'assistant-pet--dragging' : ''} ${placed ? 'assistant-pet--placed' : ''}`}
      style={{ left: position.x, top: position.y }}
    >
      {notice && (
        <div
          className="assistant-pet-message"
          role="status"
          aria-live="polite"
          style={position.x < 300 ? { left: 0, right: 'auto' } : undefined}
        >
          <strong>포석호 · 시뮬레이션 상태 확인</strong>
          <p>{notice}</p>
          <button className="assistant-pet-message-open" onClick={onOpen}>
            자세히 이야기하기
          </button>
          <button
            className="assistant-pet-message-close"
            aria-label="시뮬레이션 안내 닫기"
            onClick={onDismissNotice}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <button
        type="button"
        className="assistant-pet-button"
        aria-label="포석호 점검 도우미 열기. 드래그해서 위치를 바꿀 수 있습니다."
        aria-haspopup="dialog"
        onPointerEnter={wave}
        onFocus={wave}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishGesture}
        onPointerCancel={finishGesture}
        onLostPointerCapture={finishGesture}
        onClick={(event) => {
          if (event.detail > 0 && suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setTransient('waving');
          onOpen();
        }}
      >
        {spriteStyle ? (
          <span className="assistant-pet-sprite" style={spriteStyle} aria-hidden="true" />
        ) : (
          <span className="assistant-pet-fallback" aria-hidden="true">
            <MessageCircle size={25} strokeWidth={1.6} />
          </span>
        )}
        <span className="assistant-pet-tooltip" aria-hidden="true">
          {working ? '결과를 확인하고 있어요' : '포석호와 대화하기'}
        </span>
      </button>
    </div>
  );
}
