import type { AssistantOpenDetail } from './assistant-events';

export const ASSISTANT_GUIDANCE_EVENT = 'kkobugi:assistant-guidance';

export interface AssistantGuideRegistration {
  id: string;
  slot: HTMLElement;
  context?: AssistantOpenDetail;
  question?: string;
}

const guides = new Map<string, AssistantGuideRegistration>();

/** 화면에 실제로 붙은 안내만 등록한다. 페이지가 닫히면 해당 안내도 함께 제거한다. */
export function registerAssistantGuide(guide: AssistantGuideRegistration) {
  guides.set(guide.id, guide);
  window.dispatchEvent(new Event(ASSISTANT_GUIDANCE_EVENT));
  return () => {
    if (guides.get(guide.id) !== guide) return;
    guides.delete(guide.id);
    window.dispatchEvent(new Event(ASSISTANT_GUIDANCE_EVENT));
  };
}

/** 캐릭터 슬롯 전체가 보이는 안내 중 화면 중앙에 가장 가까운 곳을 고른다. */
export function findVisibleAssistantGuide(viewport: { width: number; height: number }) {
  let nearest: { guide: AssistantGuideRegistration; left: number; top: number } | null = null;

  let nearestDistance = Infinity;

  for (const guide of guides.values()) {
    if (!guide.slot.isConnected) continue;
    const bounds = guide.slot.getBoundingClientRect();

    // 실제 내용 영역에서 잘린 슬롯은 제외한다. 헤더 위로 포석호가 따라가지 않게 한다.
    const scrollBounds = guide.slot.closest('.main-scroll')?.getBoundingClientRect();

    const visibleLeft = Math.max(18, scrollBounds?.left ?? 0);

    const visibleTop = Math.max(18, scrollBounds?.top ?? 0);

    const visibleRight = Math.min(viewport.width - 18, scrollBounds?.right ?? viewport.width);

    const visibleBottom = Math.min(viewport.height - 18, scrollBounds?.bottom ?? viewport.height);

    if (
      bounds.width <= 0 ||
      bounds.height <= 0 ||
      bounds.left < visibleLeft ||
      bounds.right > visibleRight ||
      bounds.top < visibleTop ||
      bounds.bottom > visibleBottom
    )
      continue;
    const distance = Math.abs(bounds.top + bounds.height / 2 - viewport.height * 0.6);

    if (distance < nearestDistance) {
      nearest = { guide, left: bounds.left, top: bounds.top };
      nearestDistance = distance;
    }
  }
  return nearest;
}
