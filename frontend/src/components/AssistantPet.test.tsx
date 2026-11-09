import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AssistantPet, { clampPetPosition } from './AssistantPet';

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
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
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
});
