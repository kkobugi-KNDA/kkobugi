import { fireEvent, render, screen, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import PetChatModal from './PetChatModal';

function Harness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="assistant-pet-button" onClick={() => setOpen(true)}>
        포부기
      </button>
      <PetChatModal open={open} onOpenChange={setOpen}>
        <Counter />
      </PetChatModal>
    </>
  );
}

function Counter() {
  const [count, setCount] = useState(0);

  return <button onClick={() => setCount((previous) => previous + 1)}>대화 유지 {count}</button>;
}

beforeEach(() => {
  vi.useFakeTimers();
  if (!HTMLDialogElement.prototype.showModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      writable: true,
      value() {},
    });
  if (!HTMLDialogElement.prototype.close)
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      writable: true,
      value() {},
    });
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('포부기에서 중앙으로 펼쳐지고 모이는 대화창', () => {
  it('현재 포부기 위치를 모핑 시작점으로 쓰고 닫힌 뒤에도 대화를 유지한다', () => {
    render(<Harness />);
    const pet = screen.getByRole('button', { name: '포부기' });

    vi.spyOn(pet, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      width: 112,
      height: 122,
      right: 132,
      bottom: 152,
      toJSON() {},
    });
    fireEvent.click(pet);
    const dialog = screen.getByRole('dialog', { name: '포부기 점검 도우미' });

    expect(dialog.style.getPropertyValue('--pet-x')).toBe(`${76 - window.innerWidth / 2}px`);
    expect(dialog).toHaveAttribute('data-motion', 'opening');
    fireEvent.click(screen.getByRole('button', { name: '대화 유지 0' }));
    fireEvent.click(screen.getByRole('button', { name: '포부기 채팅 닫기' }));
    expect(dialog).toHaveAttribute('data-motion', 'closing');
    act(() => vi.advanceTimersByTime(380));
    expect(dialog).not.toHaveAttribute('open');
    fireEvent.click(pet);
    expect(screen.getByRole('button', { name: '대화 유지 1' })).toBeInTheDocument();
  });

  it('Escape 취소 이벤트도 바로 사라지지 않고 닫는 모핑을 거친다', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '포부기' }));
    const dialog = screen.getByRole('dialog', { name: '포부기 점검 도우미' });

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(dialog).toHaveAttribute('data-motion', 'closing');
    act(() => vi.advanceTimersByTime(380));
    expect(dialog).not.toHaveAttribute('open');
  });
});
