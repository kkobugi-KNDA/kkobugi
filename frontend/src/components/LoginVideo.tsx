import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import './login-video.css';

const VIDEO_URL = '/assets/login/pump-loop.mp4';

const POSTER_URL = '/assets/login/pump-poster.jpg';

export default function LoginVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  const playAttempt = useRef(0);

  const [playing, setPlaying] = useState(false);

  const [blocked, setBlocked] = useState(false);

  const [failed, setFailed] = useState(false);

  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const requestPlay = useCallback(async () => {
    const video = videoRef.current;

    if (!video) return;
    const attempt = ++playAttempt.current;

    try {
      // 원본에 소리가 있어도 로그인 화면에서는 항상 음소거한다.
      video.muted = true;
      await video.play();
      if (attempt !== playAttempt.current) return;
      setPlaying(true);
      setBlocked(false);
    } catch {
      if (attempt !== playAttempt.current) return;
      setPlaying(false);
      setBlocked(true);
    }
  }, []);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');

    const update = () => setReducedMotion(preference.matches);

    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) return;
    if (reducedMotion) {
      video.pause();
      setPlaying(false);
    } else {
      void requestPlay();
    }
    return () => {
      // 닫힌 화면의 늦은 play 응답이 재생 상태를 되돌리지 않도록 무효화한다.
      playAttempt.current += 1;
      video.pause();
    };
  }, [reducedMotion, requestPlay]);

  function togglePlayback() {
    if (!playing) {
      void requestPlay();
      return;
    }
    playAttempt.current += 1;
    videoRef.current?.pause();
    setPlaying(false);
    setBlocked(false);
  }

  return (
    <div className="login-video">
      {failed ? (
        <img className="login-video-poster" src={POSTER_URL} alt="펌프 모터 내부 구조" />
      ) : (
        <video
          ref={videoRef}
          aria-label="펌프 모터 구조 영상"
          src={VIDEO_URL}
          poster={POSTER_URL}
          autoPlay={!reducedMotion}
          muted
          loop
          playsInline
          preload="metadata"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => {
            playAttempt.current += 1;
            setPlaying(false);
            setFailed(true);
          }}
        />
      )}
      <div className="login-video-controls">
        {!failed && (
          <button
            type="button"
            onClick={togglePlayback}
            aria-label={playing ? '펌프 영상 일시 정지' : '펌프 영상 재생'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
            <span>{playing ? '일시 정지' : '재생'}</span>
          </button>
        )}
        <p role="status">
          {failed
            ? '영상을 불러오지 못해 첫 화면을 표시하고 있어요.'
            : blocked
              ? '재생 버튼을 눌러 영상을 시작하세요.'
              : reducedMotion && !playing
                ? '움직임 줄이기 설정으로 정지했어요. 원할 때 재생하세요.'
                : ''}
        </p>
      </div>
    </div>
  );
}
