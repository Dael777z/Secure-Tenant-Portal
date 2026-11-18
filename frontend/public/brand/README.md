# Dar Residential logo files

| File | Use |
|---|---|
| `Dar_Residential2x.png` | The final logo artwork as supplied (source of everything below) |
| `dar-lockup.svg` | Full logo for light backgrounds: teal arch, gold diamond, "Dar", "RESIDENTIAL", "دار" |
| `dar-lockup-on-dark.svg` | Logo for dark backgrounds: white arch, light-gold diamond, white "Dar", pale "RESIDENTIAL" |
| `dar-mark.svg` / `dar-mark-on-dark.svg` | The arch mark alone |
| `dar-app-icon.svg`, `apple-touch-icon.png` | App icon (teal rounded tile); the browser tab icon `../favicon.svg` is the same drawing |

Colours: teal `#0E4A57`, gold `#A97614` (on light) / `#E2B85C` (on dark), slate `#4A5568`, pale `#CFE0E3`, cream `#F7F5F1`.

In the app the logo is drawn by `frontend/src/theme/Brand.tsx` from `frontend/src/theme/brandPaths.ts`
(the arch fitted to the artwork, the lettering traced from it), so it follows the light/dark tone.
