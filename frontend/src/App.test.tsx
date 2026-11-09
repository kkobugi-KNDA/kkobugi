import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
const mocks = vi.hoisted(() => ({ login: vi.fn(), me: vi.fn(), logout: vi.fn() }));
vi.mock('./lib/api', () => ({
  api: { ...mocks },
  errorMessage: (error: unknown) => (error as Error).message,
}));
vi.mock('./components/AssistantPet', () => ({
  default: ({ onOpen }: { onOpen: () => void }) => <button onClick={onOpen}>도우미 열기</button>,
}));
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  mocks.me.mockRejectedValue(new Error('no session'));
  mocks.logout.mockResolvedValue(undefined);
  mocks.login.mockReset();
});
describe('workspace navigation and authentication boundaries', () => {
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
