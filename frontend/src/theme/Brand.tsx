// The Dar Residential logo: the arch mark (a pointed arch with a gold diamond) beside
// the wordmark ("Dar" over spaced "RESIDENTIAL"), drawn from the final logo artwork
// (brandPaths.ts; the same drawings are in frontend/public/brand/). Also the light /
// dark / auto switch. Shared by the sign-in page, the resident sidebar, the office
// sidebar and the office's phone top bar. The browser tab icon is public/favicon.svg.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { applyTheme, savedTheme, THEME_CHOICES, type ThemeChoice } from "./theme";
import { ARCH_PATH, DIAMOND_PATH, LOGO_COLORS, MARK_H, MARK_W, WORDMARK_DAR_PATH, WORDMARK_H, WORDMARK_RESIDENTIAL_PATH, WORDMARK_W } from "./brandPaths";

/** The company name, everywhere it is shown. */
export const BRAND_NAME = "Dar Residential";
/** The portal's name: browser tab, and the sign-in page's heading. */
export const PORTAL_NAME = "Dar Residential Portal";

/** On a light surface the logo is teal and gold; on the navy sidebars and sign-in panel it is white and light gold. */
type Tone = "navy" | "light";
const onDark = (tone: Tone) => tone === "light";

/** The arch mark alone. `size` is its height. */
export function BrandMark({ size = 36, tone = "navy", title = BRAND_NAME, className, style }: {
  size?: number;
  /** navy: teal arch for light surfaces. light: white arch for navy backgrounds. */
  tone?: Tone;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg className={`s-brand__mark${className ? ` ${className}` : ""}`} width={(size * MARK_W) / MARK_H} height={size} viewBox={`0 0 ${MARK_W} ${MARK_H}`} role="img" aria-label={title} style={style}>
      <path d={ARCH_PATH} fill={onDark(tone) ? "#ffffff" : LOGO_COLORS.teal} />
      <path d={DIAMOND_PATH} fill={onDark(tone) ? LOGO_COLORS.goldOnDark : LOGO_COLORS.gold} />
    </svg>
  );
}

/** The logo: mark and wordmark, as one image named "Dar Residential". `size` is the mark's height. */
export function BrandLogo({ size = 40, tone = "light" }: { size?: number; tone?: Tone }) {
  // Proportions from the artwork's on-dark lockup: the wordmark starts half a mark-height to the
  // right, its top level with the arch's top, and is 119/110 of the mark's height.
  const wordH = (size * WORDMARK_H) / 110;
  return (
    <span className="s-brand__logo" role="img" aria-label={BRAND_NAME} style={{ gap: size * 0.49 }}>
      <BrandMark size={size} tone={tone} title="" style={{ display: "block" }} />
      <svg width={(wordH * WORDMARK_W) / WORDMARK_H} height={wordH} viewBox={`0 0 ${WORDMARK_W} ${WORDMARK_H}`} aria-hidden="true" style={{ display: "block", flexShrink: 0 }}>
        <path d={WORDMARK_DAR_PATH} fill={onDark(tone) ? "#ffffff" : LOGO_COLORS.teal} fillRule="evenodd" />
        <path d={WORDMARK_RESIDENTIAL_PATH} fill={onDark(tone) ? LOGO_COLORS.pale : LOGO_COLORS.slate} fillRule="evenodd" />
      </svg>
    </span>
  );
}

/** The logo, with an optional line under it ("Resident portal", "Manager workspace"). */
export function Brand({ sub, size = 40, tone = "light" }: { sub?: ReactNode; size?: number; tone?: Tone }) {
  return (
    <span className="s-brand s-brand--stack">
      <BrandLogo size={size} tone={tone} />
      {sub && <span className="s-brand__sub">{sub}</span>}
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
