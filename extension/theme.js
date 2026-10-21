// Applies the saved Light/Dark choice before the panel paints (no flash). With no saved choice the
// panel follows the system setting. MV3 forbids inline scripts, hence this tiny file.
try {
  const t = localStorage.getItem("stc_theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) { /* storage blocked: follow the system setting */ }
