import { useId } from 'react';

/** Decorative engineering illustration. Motion is not connected to equipment telemetry. */
export default function PumpScene() {
  const id = useId().replaceAll(':', '');
  return (
    <div className="pump-scene" aria-hidden="true">
      <div className="scene-orbit orbit-one" />
      <div className="scene-orbit orbit-two" />
      <svg viewBox="0 0 840 650" role="presentation" className="pump-illustration">
        <defs>
          <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#fafcfe" />
            <stop offset=".23" stopColor="#cdd6e2" />
            <stop offset=".48" stopColor="#f5f8fd" />
            <stop offset=".7" stopColor="#9caec4" />
            <stop offset="1" stopColor="#5c728f" />
          </linearGradient>
          <linearGradient id={`${id}-blue`} x1="0" y1="0" x2=".7" y2="1">
            <stop stopColor="#89b6eb" />
            <stop offset=".3" stopColor="#4076b8" />
            <stop offset="1" stopColor="#173b72" />
          </linearGradient>
          <linearGradient id={`${id}-base`} x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#d6deea" />
            <stop offset="1" stopColor="#788aa1" />
          </linearGradient>
          <radialGradient id={`${id}-face`} cx=".35" cy=".3">
            <stop stopColor="#a9c9f3" />
            <stop offset=".6" stopColor="#4c7fbd" />
            <stop offset="1" stopColor="#254b83" />
          </radialGradient>
          <filter id={`${id}-shadow`} x="-40%" y="-40%" width="180%" height="190%">
            <feDropShadow
              dx="0"
              dy="22"
              stdDeviation="18"
              floodColor="#213d68"
              floodOpacity=".18"
            />
          </filter>
          <pattern
            id={`${id}-grid`}
            width="44"
            height="44"
            patternUnits="userSpaceOnUse"
            patternTransform="matrix(1 .28 -1 .28 420 410)"
          >
            <path d="M44 0H0V44" fill="none" stroke="#6485b3" strokeOpacity=".14" />
          </pattern>
        </defs>
        <path d="M25 460 410 310 810 455 425 635Z" fill={`url(#${id}-grid)`} />
        <ellipse cx="432" cy="509" rx="257" ry="46" fill="#46688f" opacity=".065" />
        <g filter={`url(#${id}-shadow)`} className="pump-body">
          <path d="m162 440 344-92 210 84-344 101Z" fill="#eef3f9" stroke="#b7c5d6" />
          <path d="m162 440 210 81v23l-210-80Z" fill="#9bacbf" />
          <path d="m372 521 344-89v22l-344 90Z" fill={`url(#${id}-base)`} />
          <path d="m204 447 103-27 39 16-104 28Z" fill="#7f94ae" />
          <path d="m517 416 103-27 39 16-104 28Z" fill="#7f94ae" />
          <path d="m277 324 21 98 40 16 13-100Z" fill="#748ba9" />
          <path d="m499 327 22 90 47-12-10-98Z" fill="#6e84a0" />
          <path
            d="m309 219 195-54c71-18 120 100 53 131l-188 56Z"
            fill={`url(#${id}-blue)`}
            stroke="#2c5993"
            strokeWidth="2"
          />
          <g stroke="#96b9e6" strokeWidth="4" opacity=".7">
            {Array.from({ length: 13 }, (_, i) => (
              <path key={i} d={`M${329 + i * 14} ${215 - i * 3.8}q62 27 52 120`} />
            ))}
          </g>
          <path d="m421 160 60-16 39 21-61 18Z" fill="#9dc0ed" stroke="#4d79ad" />
          <path d="m459 183 61-18v28l-61 18Z" fill="#3e659b" />
          <ellipse
            cx="325"
            cy="290"
            rx="70"
            ry="84"
            transform="rotate(-16 325 290)"
            fill={`url(#${id}-face)`}
            stroke="#b1ccef"
            strokeWidth="4"
          />
          <ellipse
            cx="325"
            cy="290"
            rx="55"
            ry="67"
            transform="rotate(-16 325 290)"
            fill="#294d7b"
            stroke="#6596ce"
            strokeWidth="3"
          />
          <g className="pump-fan" style={{ transformOrigin: '325px 290px' }}>
            {Array.from({ length: 10 }, (_, i) => (
              <path
                key={i}
                transform={`rotate(${i * 36} 325 290)`}
                d="M325 280q-44-27-21-48 21 7 21 48"
                fill="#7aa6d7"
                opacity=".75"
              />
            ))}
          </g>
          <circle cx="325" cy="290" r="17" fill={`url(#${id}-metal)`} />
          <path d="m377 324 97-27 13 30-97 29Z" fill={`url(#${id}-metal)`} stroke="#8a9db5" />
          <path d="m478 280 31-9 28 50-31 11Z" fill="#283e59" />
          <path d="m515 279 42-12 29 52-42 11Z" fill="#98a8bd" />
          <path
            d="m534 225 77-22c91-24 131 102 47 129l-64 19c-69 20-132-102-60-126Z"
            fill={`url(#${id}-blue)`}
            stroke="#234b82"
            strokeWidth="2"
          />
          <ellipse
            cx="567"
            cy="288"
            rx="54"
            ry="68"
            transform="rotate(-20 567 288)"
            fill={`url(#${id}-face)`}
            stroke="#8fb7e6"
            strokeWidth="4"
          />
          <ellipse
            cx="567"
            cy="288"
            rx="27"
            ry="35"
            transform="rotate(-20 567 288)"
            fill="#2e4b70"
            stroke="#9cb8d8"
            strokeWidth="6"
          />
          <path d="m549 272-49-18-17 28 53 24Z" fill={`url(#${id}-metal)`} />
          <ellipse
            cx="492"
            cy="269"
            rx="19"
            ry="26"
            transform="rotate(-23 492 269)"
            fill="#d3deeb"
            stroke="#8399b5"
            strokeWidth="4"
          />
          <ellipse
            cx="492"
            cy="269"
            rx="10"
            ry="15"
            transform="rotate(-23 492 269)"
            fill="#1c3656"
          />
          <path d="m617 204-12-70 36-10 13 74Z" fill={`url(#${id}-metal)`} stroke="#8da4c0" />
          <path d="m593 139 48-13 23 12-49 14Z" fill="#e9f0f9" stroke="#9fb3cc" />
          <path d="m615 152 49-14v13l-49 14Z" fill="#839ebf" />
          <ellipse cx="630" cy="140" rx="14" ry="6" fill="#2f4a6a" />
          <path d="m614 337-2 61 43-11-6-62Z" fill="#30578a" />
          <g fill="#d7e5f6" stroke="#5b7da4">
            {[
              [546, 232],
              [598, 252],
              [590, 332],
              [532, 307],
              [302, 218],
              [369, 272],
              [345, 362],
              [269, 306],
            ].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="4" />
            ))}
          </g>
          <path d="m233 459 12-3 5 2-12 4Z" fill="#f5f8fc" />
          <path d="m632 436 12-3 5 2-12 4Z" fill="#f5f8fc" />
        </g>
        <g fill="none" stroke="#4d80be" strokeWidth="1" opacity=".6">
          <path d="M636 191h68l28-28" />
          <circle cx="636" cy="191" r="4" fill="#d8e7fa" />
          <path d="M259 291h-60l-38-37" />
          <circle cx="259" cy="291" r="4" fill="#d8e7fa" />
          <path d="M564 370v64l30 20" />
        </g>
        <g fill="#587598" fontSize="10" fontFamily="ui-monospace, monospace" letterSpacing="1">
          <text x="703" y="151">
            DISCHARGE
          </text>
          <text x="96" y="246">
            DRIVE UNIT
          </text>
          <text x="593" y="469">
            PUMP / 01
          </text>
        </g>
        <g className="flow-dot" fill="#337fcf">
          <circle cx="635" cy="184" r="3" />
          <circle cx="493" cy="269" r="3" />
        </g>
      </svg>
      <div className="scene-caption">
        <span className="scene-dot" /> PUMP INTELLIGENCE <span>01 / 03</span>
      </div>
    </div>
  );
}
