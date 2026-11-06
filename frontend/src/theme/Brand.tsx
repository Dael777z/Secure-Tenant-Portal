// The Summit Realty mark (a mountain and an S on a rounded square), the
// name beside it, and the light / dark / auto switch. Shared by the sign-in
// page, the resident sidebar and the office sidebar.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { applyTheme, savedTheme, THEME_CHOICES, type ThemeChoice } from "./theme";

const S_PATH = "M 23.5 10.5 L 17 6 L 9.5 11.5 L 9.5 15 L 22.5 17.5 L 22.5 21 L 15 26 L 8.5 21.5";

export function BrandMark({ size = 36, tone = "navy", title = "Summit Realty", className, style }: {
  size?: number;
  tone?: "navy" | "light";
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const fill = tone === "navy" ? "#13213a" : "#ffffff";
  const stroke = tone === "navy" ? "#ffffff" : "#13213a";
  const ridge = tone === "navy" ? "#2f5d8a" : "#dce8f5";
  return (
    <svg className={`s-brand__mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={title} style={style}>
      <rect width="32" height="32" rx="8" fill={fill} />
      <path d="M 4 27 L 12 17 L 17 22 L 23 13 L 30 27 Z" fill={ridge} opacity="0.45" />
      <path d={S_PATH} fill="none" stroke={stroke} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The mark and "Summit Realty", with an optional line under the name ("Resident portal", "Office"). */
export function Brand({ sub, size = 36, tone = "light" }: { sub?: ReactNode; size?: number; tone?: "navy" | "light" }) {
  return (
    <span className="s-brand">
      <BrandMark size={size} tone={tone} />
      <span className="s-brand__text">
        <span className="s-brand__name">Summit Realty</span>
        {sub && <span className="s-brand__sub">{sub}</span>}
      </span>
    </span>
  );
}

const LABELS: Record<ThemeChoice, string> = { light: "Light", dark: "Dark", system: "Auto" };
const TITLES: Record<ThemeChoice, string> = { light: "Always light", dark: "Always dark", system: "Follow this device's setting" };
const ICONS: Record<ThemeChoice, ReactNode> = {
  light: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  ),
};

/** Light / Dark / Auto, as a radio group (arrow keys move between them). Another tab's change follows here too. */
export function ThemeSwitch({ className }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>(savedTheme);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const sync = () => {
      const next = savedTheme();
      applyTheme(next, false);
      setChoice(next);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const choose = (next: ThemeChoice) => {
    applyTheme(next);
    setChoice(next);
  };

  return (
    <div
      className={`s-theme${className ? ` ${className}` : ""}`}
      role="radiogroup"
      aria-label="Colour theme"
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const next = THEME_CHOICES[(THEME_CHOICES.indexOf(choice) + step + THEME_CHOICES.length) % THEME_CHOICES.length]!;
        choose(next);
        buttons.current[THEME_CHOICES.indexOf(next)]?.focus();
      }}
    >
      {THEME_CHOICES.map((c, i) => (
        <button
          key={c}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={choice === c}
          tabIndex={choice === c ? 0 : -1}
          title={TITLES[c]}
          className="s-theme__btn"
          onClick={() => choose(c)}
        >
          {ICONS[c]}
          {LABELS[c]}
        </button>
      ))}
    </div>
  );
}
