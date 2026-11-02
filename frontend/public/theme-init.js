// Runs before the app bundle: puts the saved colour theme on <html> so a dark
// page never flashes light first. Same key and values as src/theme/theme.ts.
// A separate file (not inline) so the Content-Security-Policy stays script-src 'self'.
(function () {
  try {
    var t = window.localStorage.getItem("summit.theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {
    // storage blocked: the device setting decides
  }
})();
