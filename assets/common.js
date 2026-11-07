// 대시보드·보고서 공통 유틸
window.U = (() => {
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n, d = 0) => n == null || !isFinite(n) ? "–" : Number(n).toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = n => n == null || !isFinite(n) ? "–" : (n * 100).toFixed(1) + "%";
  const pval = p => p == null ? "–" : p < 0.001 ? "<0.001" : p.toFixed(3);
  const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function initTheme(onChange) {
    try { const t = localStorage.getItem("news-theme"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
    const btn = document.getElementById("themeBtn");
    if (btn) btn.addEventListener("click", () => {
      const root = document.documentElement;
      const isDark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = isDark ? "light" : "dark";
      try { localStorage.setItem("news-theme", root.dataset.theme); } catch (e) {}
      onChange && onChange();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => onChange && onChange());
  }

  function chartDefaults() {
    if (!window.Chart) return;
    Chart.defaults.font.family = '"Noto Sans KR", system-ui, sans-serif';
    Chart.defaults.font.size = 12;
  }
  function tooltipStyle() {
    return { backgroundColor: cssVar("--surface"), titleColor: cssVar("--text"), bodyColor: cssVar("--text-2"),
      borderColor: cssVar("--border"), borderWidth: 1, padding: 10 };
  }

  function csv(filename, header, rows) {
    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const text = [header, ...rows].map(r => r.map(cell).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function fillBranding(meta) {
    if (!meta) return;
    document.querySelectorAll("[data-brand=system]").forEach(el => el.textContent = meta.systemName);
    document.querySelectorAll("[data-brand=region]").forEach(el => el.textContent = meta.region);
    document.querySelectorAll("[data-brand=org]").forEach(el => el.textContent = meta.orgName);
    document.querySelectorAll("[data-brand=year]").forEach(el => el.textContent = new Date().getFullYear());
  }

  return { esc, num, pct, pval, cssVar, initTheme, chartDefaults, tooltipStyle, csv, fillBranding };
})();
