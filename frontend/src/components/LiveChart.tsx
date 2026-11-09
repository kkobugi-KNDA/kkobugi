import type { ReplayPoint } from '../lib/ax-api';

export default function LiveChart({ points, channel }: { points: ReplayPoint[]; channel: string }) {
  const finite = points.filter((point) => point.value !== null && Number.isFinite(point.value));

  const minimum = finite.length ? Math.min(...finite.map((point) => point.value as number)) : 0;

  const maximum = finite.length ? Math.max(...finite.map((point) => point.value as number)) : 1;

  const span = Math.max(maximum - minimum, Math.abs(maximum) * 0.01, 0.001);

  const firstRow = points[0]?.row_index ?? 0;

  const lastRow = points.at(-1)?.row_index ?? firstRow + 1;

  const x = (point: ReplayPoint) =>
    65 + ((point.row_index - firstRow) / Math.max(1, lastRow - firstRow)) * 900;

  const y = (point: ReplayPoint) => 225 - (((point.value ?? minimum) - minimum) / span) * 170;

  const path = points
    .map((point, index) =>
      point.value === null
        ? ''
        : `${index === 0 || points[index - 1].value === null ? 'M' : 'L'}${x(point)},${y(point)}`,
    )
    .join(' ');

  return (
    <div className="ax-live-chart">
      <svg
        viewBox="0 0 1000 280"
        role="img"
        aria-label={`${channel} 수신된 값 그래프. ${points.length}개 표시`}
      >
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction}>
            <line
              x1="65"
              x2="965"
              y1={225 - fraction * 170}
              y2={225 - fraction * 170}
              stroke="var(--theme-border, var(--border, #dfe6ef))"
            />
            <text
              x="55"
              y={230 - fraction * 170}
              textAnchor="end"
              fill="var(--theme-text-muted, #718096)"
              fontSize="12"
            >
              {(minimum + span * fraction).toFixed(2)}
            </text>
          </g>
        ))}
        <path d={path} stroke="var(--theme-primary, #2f6aab)" strokeWidth="2" fill="none" />
        {finite
          .filter((point) => point.predicted_code === 1)
          .map((point) => (
            <circle
              key={point.row_index}
              cx={x(point)}
              cy={y(point)}
              r="3"
              fill="var(--theme-danger, #e34e53)"
            />
          ))}
        <text x="65" y="261" fontSize="12" fill="var(--theme-text-muted, #718096)">
          {points[0]?.timestamp.replace('T', ' ').slice(0, 19)}
        </text>
        <text
          x="965"
          y="261"
          textAnchor="end"
          fontSize="12"
          fill="var(--theme-text-muted, #718096)"
        >
          {points.at(-1)?.timestamp.replace('T', ' ').slice(0, 19)}
        </text>
      </svg>
      {!points.length && (
        <div className="ax-chart-await">재생을 시작하면 도착한 값부터 표시됩니다.</div>
      )}
    </div>
  );
}
