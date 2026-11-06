// The colour theme: light, dark, or follow the device. Saved on this device only
// (localStorage), under the same key public/theme-init.js reads before the app
// loads, so a dark page never flashes light first.
export type ThemeChoice = "light" | "dark" | "system";

export const THEME_KEY = "summit.theme";
export const THEME_CHOICES: ThemeChoice[] = ["light", "dark", "system"];

export function savedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (THEME_CHOICES.includes(value as ThemeChoice)) return value as ThemeChoice;
  } catch {
    // storage blocked: follow the device
  }
  return "system";
}

/** Put the choice on <html data-theme> (theme.css reads it), and remember it unless `remember` is false. */
export function applyTheme(choice: ThemeChoice, remember = true): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
  if (!remember) return;
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage blocked: the choice lasts until the page closes
  }
}
