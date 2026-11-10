import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App, { assistantDetailForPet } from './App';
import { ASSISTANT_OPEN_EVENT, type AssistantOpenDetail } from './lib/assistant-events';
const mocks = vi.hoisted(() => ({ login: vi.fn(), me: vi.fn(), logout: vi.fn(), guest: vi.fn() }));
vi.mock('./lib/api', () => ({
  api: { ...mocks },
  errorMessage: (error: unknown) => (error as Error).message,
}));
vi.mock('./components/AssistantPet', () => ({
  default: ({ onOpen }: { onOpen: () => void }) => <button onClick={onOpen}>도우미 열기</button>,
}));
vi.mock('./components/LoginVideo', () => ({
  default: () => <div aria-label="로그인 펌프 영상" />,
}));
vi.mock('./components/PetChatModal', () => ({
  default: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <section aria-label="열린 포석호 대화">{children}</section> : null,
}));
vi.mock('./pages/SimulationPage', () => ({
  default: () => <h1>시뮬레이션 화면</h1>,
}));

function CurrentPath() {
  const location = useLocation();

  return <output aria-label="현재 주소">{location.pathname}</output>;
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mocks.me.mockRejectedValue(new Error('no session'));
  mocks.logout.mockResolvedValue(undefined);
  mocks.login.mockReset();
  mocks.guest.mockReset().mockResolvedValue({
    user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
  });
});
describe('workspace navigation and authentication boundaries', () => {
  it('이미 게스트로 로그인했어도 QR을 다시 열면 로그인 화면에서 입장을 기다린다', async () => {
    mocks.me.mockResolvedValue({
      user: { id: 99, username: 'guest', display_name: '게스트', is_guest: true },
    });
    render(
      <MemoryRouter initialEntries={['/?guest=1']}>
        <App />
        <CurrentPath />
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: '게스트로 입장' });

    expect(screen.queryByRole('link', { name: '작업실' })).not.toBeInTheDocument();
    expect(mocks.guest).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByRole('link', { name: '작업실' });
    expect(screen.getByLabelText('현재 주소')).toHaveTextContent(/^\/$/);
  });

  it('QR 주소는 로그인 화면을 보여주고 게스트 버튼을 누르면 기존 작업실로 입장한다', async () => {
    render(
      <MemoryRouter initialEntries={['/?guest=1']}>
        <App />
        <CurrentPath />
      </MemoryRouter>,
    );

    const button = await screen.findByRole('button', { name: '게스트로 입장' });

    expect(screen.getByRole('button', { name: '로그인' })).toBeInTheDocument();
    expect(mocks.guest).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '시뮬레이션 화면' })).not.toBeInTheDocument();
    fireEvent.click(button);
    await screen.findByRole('link', { name: '작업실' });
    expect(screen.getByLabelText('현재 주소')).toHaveTextContent(/^\/$/);
    expect(screen.getByRole('button', { name: '도우미 열기' })).toBeInTheDocument();
    expect(mocks.guest).toHaveBeenCalledTimes(1);
  });

  it('passes a warning event question into the mascot conversation draft', async () => {
    sessionStorage.setItem('kkobugi:preview', '1');
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('link', { name: '작업실' });
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AssistantOpenDetail>(ASSISTANT_OPEN_EVENT, {
          detail: {
            runId: null,
            modelKey: null,
            contextKey: 'training:warning',
            initialQuestion: '최종 확인 구간에 비정상이 없으면 어떻게 해?',
          },
        }),
      );
    });
    expect(screen.getByRole('textbox', { name: '포석호에게 질문' })).toHaveValue(
      '최종 확인 구간에 비정상이 없으면 어떻게 해?',
    );
  });

  it('redirects the old monitor address to simulation and keeps only one navigation item', async () => {
    sessionStorage.setItem('kkobugi:preview', '1');
    render(
      <MemoryRouter initialEntries={['/monitor']}>
        <App />
        <CurrentPath />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: '시뮬레이션 화면' })).toBeInTheDocument();
    expect(screen.getByLabelText('현재 주소')).toHaveTextContent('/simulation');
    expect(screen.getAllByRole('link', { name: '시뮬레이션' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: '실시간 모니터링' })).not.toBeInTheDocument();
  });

  it('keeps navigation classes intact inside tooltip slots and opens the help drawer', async () => {
    sessionStorage.setItem('kkobugi:preview', '1');
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    const home = await screen.findByRole('link', { name: '작업실' });
    expect(home).toHaveClass('nav-item', 'active');
    expect(home.getAttribute('class')).not.toContain('=>');
    fireEvent.click(screen.getByRole('button', { name: '메뉴 접기' }));
    expect(screen.getByRole('button', { name: '메뉴 펼치기' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '사용 안내' }));
    expect(await screen.findByRole('dialog', { name: '작업 순서' })).toBeInTheDocument();
  });
  it('keeps a failed login on the login screen without substituting demo data', async () => {
    mocks.login.mockRejectedValue(new Error('서버 연결 확인이 필요해요.'));
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: '로그인' });
    fireEvent.change(screen.getByLabelText('아이디', { exact: true }), {
      target: { value: ' worker ' },
    });
    fireEvent.change(screen.getByLabelText('비밀번호', { exact: true }), {
      target: { value: 'test-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('서버 연결 확인이 필요해요.');
    expect(mocks.login).toHaveBeenCalledWith('worker', 'test-password');
    expect(screen.queryByRole('heading', { name: '분석 작업실' })).not.toBeInTheDocument();
    expect(sessionStorage.getItem('kkobugi:preview')).toBeNull();
  });
});

describe('mascot conversation reopening', () => {
  const partDetail: AssistantOpenDetail = {
    contextKey: 'simulation-a:part-1',
    runId: 'run-a',
    modelKey: 'xgboost',
    split: 'test',
    selectedSignal: '베어링 점검',
    suggestedCostInputs: { parts_cost: 120000 },
  };

  const currentStatus: AssistantOpenDetail = {
    contextKey: 'simulation:simulation-a',
    runId: 'run-a',
    modelKey: 'xgboost',
    split: 'test',
  };

  it('keeps the explicit part context when reopening the same simulation through the mascot', () => {
    expect(assistantDetailForPet(partDetail, currentStatus)).toBe(partDetail);
  });

  it.each([
    { contextKey: 'simulation:simulation-b' },
    { runId: 'run-b' },
    { modelKey: 'autoencoder' },
    { split: 'validation' as const },
  ])('uses the new context when simulation or model identity changes: %o', (changed) => {
    const nextStatus = { ...currentStatus, ...changed };

    expect(assistantDetailForPet(partDetail, nextStatus)).toBe(nextStatus);
  });

  it('does not restore an old part conversation after account context has been cleared', () => {
    expect(assistantDetailForPet({}, currentStatus)).toBe(currentStatus);
  });

  it('clears simulation context when opening the mascot outside the simulation page', () => {
    expect(assistantDetailForPet(partDetail, null)).toEqual({});
  });
});
