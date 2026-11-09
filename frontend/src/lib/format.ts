export const number = (n: number) => new Intl.NumberFormat('ko-KR').format(n);
export const bytes = (n: number) =>
  n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
export const percent = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : `${(n * 100).toFixed(digits)}%`;
export const dateTime = (seconds: number) =>
  new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(seconds * 1000));
export const csvTime = (value: string | null | undefined) =>
  value ? value.replace('T', ' ').replace(/\.\d+/, '') : '—';
