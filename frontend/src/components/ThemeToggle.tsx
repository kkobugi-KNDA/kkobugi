import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="화면 테마">
      <button
        type="button"
        aria-label="밝은 테마"
        aria-pressed={theme === 'light'}
        onClick={() => setTheme('light')}
        title="밝은 테마"
      >
        <Sun size={15} aria-hidden="true" />
        <span>밝게</span>
      </button>
      <button
        type="button"
        aria-label="어두운 테마"
        aria-pressed={theme === 'dark'}
        onClick={() => setTheme('dark')}
        title="어두운 테마"
      >
        <Moon size={15} aria-hidden="true" />
        <span>어둡게</span>
      </button>
    </div>
  );
}
