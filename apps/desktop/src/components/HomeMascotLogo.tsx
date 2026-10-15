export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <svg
        className="home-mascot-svg"
        viewBox="0 0 120 120"
        width={100}
        height={100}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient
            id="home-mascot-shell"
            x1="28"
            y1="26"
            x2="92"
            y2="90"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="var(--mascot-shell-top)" />
            <stop offset="0.58" stopColor="var(--mascot-shell-mid)" />
            <stop offset="1" stopColor="var(--mascot-shell-bot)" />
          </linearGradient>
          <linearGradient
            id="home-mascot-visor"
            x1="34"
            y1="40"
            x2="86"
            y2="76"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="var(--mascot-visor-top)" />
            <stop offset="1" stopColor="var(--mascot-visor-bot)" />
          </linearGradient>
          <linearGradient
            id="home-mascot-accent"
            x1="48"
            y1="4"
            x2="72"
            y2="28"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="var(--mascot-accent-start)" />
            <stop offset="0.5" stopColor="#38BDF8" />
            <stop offset="1" stopColor="#14B8A6" />
          </linearGradient>
          <linearGradient
            id="home-mascot-eye"
            x1="44"
            y1="48"
            x2="76"
            y2="62"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#7DD3FC" />
            <stop offset="1" stopColor="#2DD4BF" />
          </linearGradient>
        </defs>

        {/* Ground hover shadow */}
        <g className="home-mascot-shadow">
          <ellipse
            cx="60"
            cy="109"
            rx="22"
            ry="4"
            fill="var(--mascot-shadow-outer)"
          />
          <ellipse
            cx="60"
            cy="109"
            rx="13"
            ry="2.2"
            fill="var(--mascot-shadow-inner)"
          />
        </g>

        {/* Floating Mini-Agent body group */}
        <g className="home-mascot-float">
          {/* Twinkling sparkle accents */}
          <path
            className="home-mascot-sparkle"
            d="M 106 24 C 106 27.5 107.5 29 111 29 C 107.5 29 106 30.5 106 34 C 106 30.5 104.5 29 101 29 C 104.5 29 106 27.5 106 24 Z"
            fill="url(#home-mascot-accent)"
          />
          <circle
            className="home-mascot-orb"
            cx="16"
            cy="36"
            r="2.2"
            fill="var(--mascot-orb)"
          />

          {/* Magnetically suspended feet */}
          <g className="home-mascot-feet">
            <rect
              x="40"
              y="90"
              width="13"
              height="8"
              rx="4"
              fill="url(#home-mascot-shell)"
              stroke="var(--mascot-stroke)"
              strokeWidth="2.5"
            />
            <rect
              x="67"
              y="90"
              width="13"
              height="8"
              rx="4"
              fill="url(#home-mascot-shell)"
              stroke="var(--mascot-stroke)"
              strokeWidth="2.5"
            />
          </g>

          {/* Left resting arm */}
          <g className="home-mascot-arm-left">
            <rect
              x="11"
              y="57"
              width="11"
              height="20"
              rx="5.5"
              fill="url(#home-mascot-shell)"
              stroke="var(--mascot-stroke)"
              strokeWidth="2.5"
            />
          </g>

          {/* Side audio/sensor ear nodes */}
          <rect
            x="20"
            y="50"
            width="7"
            height="15"
            rx="3.5"
            fill="var(--mascot-ear)"
            stroke="var(--mascot-stroke)"
            strokeWidth="2.5"
          />
          <rect
            x="93"
            y="50"
            width="7"
            height="15"
            rx="3.5"
            fill="var(--mascot-ear)"
            stroke="var(--mascot-stroke)"
            strokeWidth="2.5"
          />

          {/* Antenna stem & 4-Point Agent Spark */}
          <path
            d="M 60 30 V 22"
            stroke="var(--mascot-stroke)"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <g className="home-mascot-spark">
            <path
              d="M 60 5 C 60 11.5 63.2 15 70 15 C 63.2 15 60 18.5 60 25 C 60 18.5 56.8 15 50 15 C 56.8 15 60 11.5 60 5 Z"
              fill="url(#home-mascot-accent)"
            />
            <path
              d="M 60 10 C 60 13 61.5 15 64.5 15 C 61.5 15 60 17 60 20 C 60 17 58.5 15 55.5 15 C 58.5 15 60 13 60 10 Z"
              fill="#FFFFFF"
              fillOpacity="0.85"
            />
          </g>

          {/* Main squircle capsule body */}
          <rect
            x="25"
            y="29"
            width="70"
            height="58"
            rx="26"
            fill="url(#home-mascot-shell)"
            stroke="var(--mascot-stroke)"
            strokeWidth="2.6"
          />

          {/* Top helmet specular highlight */}
          <path
            d="M 43 33.5 H 77"
            stroke="var(--mascot-highlight)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />

          {/* Chest M-emblem */}
          <path
            d="M 55.5 81.5 V 77.5 L 60 80.5 L 64.5 77.5 V 81.5"
            stroke="var(--mascot-badge)"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Dark glass visor */}
          <rect
            x="33"
            y="38"
            width="54"
            height="34"
            rx="16"
            fill="url(#home-mascot-visor)"
            stroke="var(--mascot-visor-stroke)"
            strokeWidth="2.2"
          />

          {/* Visor glass reflection */}
          <path
            d="M 41 42.5 Q 50 40.5 58 42.5"
            stroke="#FFFFFF"
            strokeWidth="1.6"
            strokeLinecap="round"
            opacity="0.28"
          />

          {/* Blinking glowing eyes */}
          <g className="home-mascot-eyes">
            <rect
              x="44"
              y="48"
              width="7.5"
              height="11"
              rx="3.75"
              fill="url(#home-mascot-eye)"
            />
            <circle cx="46.5" cy="51" r="1.5" fill="#FFFFFF" />
            <rect
              x="68.5"
              y="48"
              width="7.5"
              height="11"
              rx="3.75"
              fill="url(#home-mascot-eye)"
            />
            <circle cx="71" cy="51" r="1.5" fill="#FFFFFF" />
          </g>

          {/* Soft digital cheek glow & friendly smile */}
          <ellipse
            cx="41"
            cy="61.5"
            rx="3"
            ry="1.6"
            fill="#38BDF8"
            fillOpacity="0.48"
          />
          <ellipse
            cx="79"
            cy="61.5"
            rx="3"
            ry="1.6"
            fill="#38BDF8"
            fillOpacity="0.48"
          />
          <path
            d="M 56.5 60.5 Q 60 63.8 63.5 60.5"
            stroke="#7DD3FC"
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />

          {/* Right waving arm */}
          <g className="home-mascot-wave">
            <rect
              x="94"
              y="37"
              width="11.5"
              height="22"
              rx="5.75"
              fill="url(#home-mascot-shell)"
              stroke="var(--mascot-stroke)"
              strokeWidth="2.5"
            />
            <line
              x1="96.8"
              y1="45"
              x2="102.7"
              y2="45"
              stroke="var(--mascot-cuff)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>
    </span>
  );
}
