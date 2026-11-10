import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GuestGuide from './GuestGuide';
import { GUIDE_SECTIONS } from '../lib/guest-guide-steps';

const targetAction = vi.fn();

const resizeObservers: { disconnect: ReturnType<typeof vi.fn> }[] = [];

function CurrentPage({ showTargets }: { showTargets: boolean }) {
  const location = useLocation();

  const section = GUIDE_SECTIONS.find((item) => item.path === location.pathname);

  return (
    <main>
      <output data-testid="current-path">{location.pathname}</output>
      {showTargets &&
        section?.steps.map((step, index) => {
          const marker = step.target.match(/\[data-tour=['"]([^'"]+)['"]\]/)?.[1];

          return (
            <button key={index} data-tour={marker} onClick={targetAction}>
              실행 대상 {index}
            </button>
          );
        })}
    </main>
  );
}

function GuideHarness({
  initialOpen = true,
  showTargets = true,
  onClose,
}: {
  initialOpen?: boolean;
  showTargets?: boolean;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);

  return (
    <>
      <CurrentPage showTargets={showTargets} />
      <GuestGuide
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      />
    </>
  );
}

function openGuide(path = '/', options: { initialOpen?: boolean; showTargets?: boolean } = {}) {
  const onClose = vi.fn();

  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <GuideHarness {...options} onClose={onClose} />
    </MemoryRouter>,
  );

  return { ...result, onClose };
}

async function expectStep(title: string, path: string) {
  expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  expect(screen.getByTestId('current-path')).toHaveTextContent(path);
}

beforeEach(() => {
  targetAction.mockClear();
  resizeObservers.length = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();

      unobserve = vi.fn();

      disconnect = vi.fn();

      constructor() {
        resizeObservers.push(this);
      }
    },
  );
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('포부기 관람 화면 안내', () => {
  it.each(GUIDE_SECTIONS)('$label에서 열면 현재 메뉴 설명부터 시작한다', async (section) => {
    openGuide(section.path);
    await expectStep(section.steps[0].title, section.path);
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('다음과 이전으로 설명을 이어가며 실제 경로도 이동한다', async () => {
    const first = GUIDE_SECTIONS[0];

    const second = GUIDE_SECTIONS[1];

    openGuide(first.path);
    await expectStep(first.steps[0].title, first.path);
    for (let index = 0; index < first.steps.length; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^다음$/ }));
    }
    await expectStep(second.steps[0].title, second.path);
    fireEvent.click(screen.getByRole('button', { name: /^이전$/ }));
    await expectStep(first.steps.at(-1)!.title, first.path);
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('원하는 메뉴로 바로 이동하고 마지막 설명을 마칠 수 있다', async () => {
    const last = GUIDE_SECTIONS.at(-1)!;

    const { onClose } = openGuide();

    const selector = screen.getByRole('combobox', { name: '안내할 메뉴 선택' });

    const option = within(selector).getByRole('option', { name: last.label }) as HTMLOptionElement;

    fireEvent.change(selector, { target: { value: option.value } });
    await expectStep(last.steps[0].title, last.path);
    for (let index = 1; index < last.steps.length; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: /^다음$/ }));
    }
    fireEvent.click(screen.getByRole('button', { name: '안내 마치기' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('설명할 대상이 아직 없더라도 다음 안내로 계속 진행할 수 있다', async () => {
    const section = GUIDE_SECTIONS[0];

    openGuide(section.path, { showTargets: false });
    await expectStep(section.steps[0].title, section.path);
    expect(screen.getByRole('status')).toHaveTextContent('다음 안내로 바로 넘어가도 돼요');
    const next = screen.getByRole('button', { name: /^다음$/ });

    expect(next).toBeEnabled();
    fireEvent.click(next);
    const following = section.steps[1] || GUIDE_SECTIONS[1].steps[0];

    expect(await screen.findByRole('heading', { name: following.title })).toBeInTheDocument();
  });

  it('Escape로 안내만 닫고 실행 버튼은 누르지 않는다', async () => {
    const { onClose } = openGuide();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onClose).toHaveBeenCalledOnce();
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('실제 대상이 보이면 위치를 안내하되 그 버튼을 실행하지 않는다', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 24,
      y: 120,
      left: 24,
      top: 120,
      width: 200,
      height: 64,
      right: 224,
      bottom: 184,
      toJSON() {},
    });
    openGuide();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(document.querySelector('.guest-guide-spotlight')).toBeInTheDocument();
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('닫혀 있으면 화면을 이동시키거나 설명을 자동으로 시작하지 않는다', () => {
    openGuide('/reports', { initialOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('current-path')).toHaveTextContent('/reports');
    expect(targetAction).not.toHaveBeenCalled();
  });

  it('닫거나 떠날 때 생성한 크기 관찰을 정리한다', async () => {
    const { unmount, onClose } = openGuide();

    fireEvent.click(screen.getByRole('button', { name: '안내 건너뛰기' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    unmount();
    expect(resizeObservers.length).toBeGreaterThan(0);
    for (const observer of resizeObservers) {
      expect(observer.disconnect).toHaveBeenCalled();
    }
    expect(targetAction).not.toHaveBeenCalled();
  });
});
