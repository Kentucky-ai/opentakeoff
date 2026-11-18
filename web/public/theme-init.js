// Set the theme before first paint (no flash of the wrong theme). Stored choice
// wins; otherwise follow the OS. matchMedia sits outside the try so private mode
// still gets OS-matched theming. lib/theme.js keeps this in sync after load
// (toggle, OS changes, other tabs).
//
// This lives as a same-origin file rather than an inline <script> ON PURPOSE:
// it lets the deployed app ship a strict Content-Security-Policy with
// `script-src 'self'` (no 'unsafe-inline', no per-file hash to keep in sync) —
// see public/_headers. It must stay a render-blocking classic script in <head>
// (no async/defer) so it runs before the first paint.
(function () {
  var t = null;
  try { t = localStorage.getItem("opentakeoff_theme"); } catch (e) {}
  if (t !== "light" && t !== "dark")
    t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", t === "dark" ? "#0c0e0f" : "#f4efe3");
})();
