import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginVideo from './LoginVideo';

let play: ReturnType<typeof vi.spyOn>;

let pause: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('로그인 원본 펌프 영상', () => {
  it('원본 MP4와 첫 프레임을 사용하고 음소거 자동 반복 재생과 일시 정지를 제공한다', async () => {
    render(<LoginVideo />);
    const video = screen.getByLabelText('펌프 모터 구조 영상') as HTMLVideoElement;

    expect(video).toHaveAttribute('src', '/assets/login/pump-loop.mp4');
    expect(video).toHaveAttribute('poster', '/assets/login/pump-poster.jpg');
    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('loop');
    expect(video).toHaveAttribute('playsinline');
    expect(video.muted).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: '펌프 영상 일시 정지' }));
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '펌프 영상 재생' })).toBeInTheDocument();
  });

  it('자동 재생이 차단되면 사용자가 재생 버튼으로 다시 시작할 수 있다', async () => {
    play.mockRejectedValueOnce(new DOMException('Autoplay blocked', 'NotAllowedError'));
    render(<LoginVideo />);
    expect(await screen.findByRole('status')).toHaveTextContent('재생 버튼을 눌러');
    fireEvent.click(screen.getByRole('button', { name: '펌프 영상 재생' }));
    expect(await screen.findByRole('button', { name: '펌프 영상 일시 정지' })).toBeInTheDocument();
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('움직임 줄이기에서는 정지한 채 시작하며 명시적으로 누르면 재생한다', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    render(<LoginVideo />);
    expect(screen.getByLabelText('펌프 모터 구조 영상')).not.toHaveAttribute('autoplay');
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('움직임 줄이기');
    fireEvent.click(screen.getByRole('button', { name: '펌프 영상 재생' }));
    expect(await screen.findByRole('button', { name: '펌프 영상 일시 정지' })).toBeInTheDocument();
  });

  it('재생 중 움직임 줄이기를 켜면 멈추고 실패한 영상은 첫 프레임으로 대체한다', async () => {
    let preferenceChanged = () => {};

    const preference = {
      matches: false,
      addEventListener: (_name: string, listener: () => void) => {
        preferenceChanged = listener;
      },
      removeEventListener: vi.fn(),
    };

    vi.spyOn(window, 'matchMedia').mockReturnValue(preference as unknown as MediaQueryList);
    render(<LoginVideo />);
    await screen.findByRole('button', { name: '펌프 영상 일시 정지' });
    act(() => {
      preference.matches = true;
      preferenceChanged();
    });
    expect(pause).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '펌프 영상 재생' })).toBeInTheDocument();
    fireEvent.error(screen.getByLabelText('펌프 모터 구조 영상'));
    expect(screen.getByRole('img', { name: '펌프 모터 내부 구조' })).toHaveAttribute(
      'src',
      '/assets/login/pump-poster.jpg',
    );
    expect(screen.getByRole('status')).toHaveTextContent('영상을 불러오지 못해');
  });
});
