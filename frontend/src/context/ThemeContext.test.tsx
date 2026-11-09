import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThemeToggle from '../components/ThemeToggle';
import { THEME_STORAGE_KEY, ThemeProvider } from './ThemeContext';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.head.innerHTML = '<meta name="theme-color" content="#f2f4f7" />';
});
const renderToggle = () =>
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );

describe('theme preference', () => {
  it('defaults to light and persists an explicit dark choice across remounts', () => {
    const first = renderToggle();
    expect(screen.getByRole('button', { name: '밝은 테마' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '어두운 테마' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      'content',
      '#0d1522',
    );
    first.unmount();
    renderToggle();
    expect(screen.getByRole('button', { name: '어두운 테마' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('ignores invalid preferences and restores light after storage is cleared elsewhere', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'invalid');
    renderToggle();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }),
      ),
    );
    expect(screen.getByRole('button', { name: '어두운 테마' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null })));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
  it('can switch themes even when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderToggle();
    fireEvent.click(screen.getByRole('button', { name: '어두운 테마' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    fireEvent.click(screen.getByRole('button', { name: '밝은 테마' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
