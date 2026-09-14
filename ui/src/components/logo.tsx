export function BarnMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-label="Circuit Barn"
    >
      {/* barn */}
      <path
        d="M8 21 L14 13 L24 7 L34 13 L40 21 V41 H8 Z"
        stroke="#d0553f"
        strokeWidth="2.5"
        strokeLinejoin="round"
        fill="rgba(208,85,63,.14)"
      />
      {/* door */}
      <path
        d="M19 41 V29 a5 5 0 0 1 10 0 V41"
        stroke="#d0553f"
        strokeWidth="2.5"
        strokeLinejoin="round"
        fill="rgba(23,20,17,.6)"
      />
      {/* circuit traces off the roof */}
      <path d="M24 7 V2" stroke="#d0553f" strokeWidth="2" />
      <circle cx="24" cy="2" r="1.8" fill="#d0553f" />
      <path d="M14 13 L9 8" stroke="#d0553f" strokeWidth="2" />
      <circle cx="8" cy="7" r="1.8" fill="#d0553f" />
      <path d="M34 13 L39 8" stroke="#d0553f" strokeWidth="2" />
      <circle cx="40" cy="7" r="1.8" fill="#d0553f" />
      {/* bolt in the doorway */}
      <path
        d="M24.5 28 L21.5 33.5 H24 L23.5 38 L26.8 32.2 H24.2 Z"
        fill="#d9ad4a"
      />
    </svg>
  );
}
