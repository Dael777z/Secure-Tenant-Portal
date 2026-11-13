//Text size preference: a per-device display setting, so it lives in the
//browser (localStorage) rather than on the server.
export type TextSize = "default" | "large" | "xlarge";

const KEY = "portal-text-size";
const SIZES: TextSize[] = ["default", "large", "xlarge"];

export function getTextSize(): TextSize {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (SIZES.includes(stored as TextSize)) return stored as TextSize;
  } catch {

  }
  return "default";
}

/** Apply a size to the page (and remember it when `remember` is true). */
export function applyTextSize(size: TextSize, remember = true) {
  document.documentElement.dataset.textSize = size;
  if (!remember) return;
  try {
    window.localStorage.setItem(KEY, size);
  } catch {
    //the size still applies until the page is reloaded
  }
}