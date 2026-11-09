import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssistantPet, { clampPetPosition, MANUAL_DOCK_PAUSE_MS } from './AssistantPet';
import { registerAssistantGuide } from '../lib/assistant-guidance';
import { ASSISTANT_OPEN_EVENT } from '../lib/assistant-events';

const clearGuides: (() => void)[] = [];

function visibleGuide(id = 'training-input') {
  const slot = document.createElement('div');

  document.body.append(slot);
  const bounds = vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue({
    left: 220,
    top: 340,
    right: 332,
    bottom: 462,
    width: 112,
    height: 122,
    x: 220,
    y: 340,
    toJSON() {},
  });

  const unregister = registerAssistantGuide({
    id,
    slot,
    context: { runId: 'training-run', modelKey: 'xgboost' },
    question: '이 평가 결과를 설명해줘',
  });

  clearGuides.push(() => {
    unregister();
    slot.remove();
  });
  return { bounds, unregister, slot };
}

class TestPointerEvent extends MouseEvent {
  pointerId: number;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(0), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const clearGuide of clearGuides.splice(0)) clearGuide();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AssistantPet', () => {
  it('keeps a moved pet inside the viewport', () => {
    expect(clampPetPosition({ x: -500, y: -50 }, { width: 1000, height: 800 })).toEqual({
      x: 18,
      y: 18,
    });
    expect(clampPetPosition({ x: 5000, y: 5000 }, { width: 1000, height: 800 })).toEqual({
      x: 870,
      y: 660,
    });
  });

  it('opens on activation but does not open after dragging', () => {
    const onOpen = vi.fn();
    render(<AssistantPet onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: /도우미 열기/ });
    fireEvent.pointerDown(button, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 160, clientY: 110, pointerId: 1 });
    fireEvent.pointerUp(button, { clientX: 160, clientY: 110, pointerId: 1 });
    fireEvent.click(button, { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(button, { detail: 0 }); // Native keyboard activation has detail zero.
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('aborts the metadata request when the component unmounts', () => {
    const view = render(<AssistantPet onOpen={vi.fn()} />);
    const request = vi.mocked(fetch).mock.calls[0];
    const signal = (request[1] as RequestInit).signal;
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('moves the same global character to a visible guide and returns home when the guide leaves', () => {
    render(<AssistantPet onOpen={vi.fn()} />);
    const pet = screen.getByRole('button', { name: /도우미 열기/ }).parentElement!;

    const home = { left: pet.style.left, top: pet.style.top };

    const guide = visibleGuide();

    act(() => vi.advanceTimersByTime(16));
    expect(pet).toHaveAttribute('data-guide-id', 'training-input');
    expect(pet).toHaveStyle({ left: '220px', top: '340px' });
    expect(document.querySelectorAll('.assistant-pet')).toHaveLength(1);
    guide.bounds.mockReturnValue({
      ...guide.bounds.mock.results[0].value,
      top: 1000,
      bottom: 1122,
    });
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(16));
    expect(pet).not.toHaveAttribute('data-guide-id');
    expect(pet).toHaveStyle(home);
  });

  it('returns to its dock after the guide page is unmounted', () => {
    const guide = visibleGuide();

    render(<AssistantPet onOpen={vi.fn()} />);
    const pet = screen.getByRole('button', { name: /도우미 열기/ }).parentElement!;

    expect(pet).toHaveAttribute('data-guide-id');
    guide.unregister();
    act(() => vi.advanceTimersByTime(16));
    expect(pet).not.toHaveAttribute('data-guide-id');
    expect(pet).toHaveStyle({
      left: `${window.innerWidth - 112 - 30}px`,
      top: `${window.innerHeight - 122 - 24}px`,
    });
  });

  it('ignores a slot clipped behind the header and responds to the actual content scroll', () => {
    const guide = visibleGuide();

    const scrollArea = document.createElement('main');

    scrollArea.className = 'main-scroll';
    document.body.append(scrollArea);
    scrollArea.append(guide.slot);
    vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 67,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight - 67,
      x: 0,
      y: 67,
      toJSON() {},
    });
    const visibleBounds = guide.bounds.mock.results[0]?.value || guide.slot.getBoundingClientRect();

    guide.bounds.mockReturnValue({ ...visibleBounds, top: 20, bottom: 142 });
    render(<AssistantPet onOpen={vi.fn()} />);
    const pet = screen.getByRole('button', { name: /도우미 열기/ }).parentElement!;

    expect(pet).not.toHaveAttribute('data-guide-id');
    guide.bounds.mockReturnValue(visibleBounds);
    fireEvent.scroll(scrollArea);
    act(() => vi.advanceTimersByTime(16));
    expect(pet).toHaveAttribute('data-guide-id', 'training-input');
    scrollArea.remove();
  });

  it('keeps a manually dragged character in place before resuming guidance and suppresses its click', () => {
    visibleGuide();
    const onOpen = vi.fn();

    render(<AssistantPet onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: /도우미 열기/ });

    const pet = button.parentElement!;

    fireEvent.pointerDown(button, { clientX: 220, clientY: 340, button: 0, pointerId: 1 });
    fireEvent.pointerMove(button, { clientX: 280, clientY: 350, pointerId: 1 });
    fireEvent.pointerUp(button, { clientX: 280, clientY: 350, pointerId: 1 });
    fireEvent.click(button, { detail: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(pet).not.toHaveAttribute('data-guide-id');
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(16));
    expect(pet).toHaveStyle({ left: '280px', top: '350px' });
    act(() => vi.advanceTimersByTime(MANUAL_DOCK_PAUSE_MS));
    expect(pet).toHaveAttribute('data-guide-id', 'training-input');
    expect(pet).toHaveStyle({ left: '220px', top: '340px' });
  });

  it('positions immediately when reduced motion is enabled and opens the guide context on activation', () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    visibleGuide();
    const onOpen = vi.fn();

    const opened = vi.fn();

    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);
    render(<AssistantPet onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: /도우미 열기/ });

    expect(button.parentElement).toHaveAttribute('data-reduced-motion', 'true');
    expect(button.parentElement).toHaveStyle({ left: '220px', top: '340px' });
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      runId: 'training-run',
      modelKey: 'xgboost',
      initialQuestion: '이 평가 결과를 설명해줘',
    });
    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
  });
});
