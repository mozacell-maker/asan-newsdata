// 홍보 성과 대시보드 — 브라우저에서 data.js(window.NEWS_DATA)를 읽어 필터·집계·시각화
(function () {
  "use strict";
  const { esc, num, pct, pval, cssVar, csv } = U;
  const el = id => document.getElementById(id);
  const RAW = window.NEWS_DATA;
  if (!RAW) {
    el("app").innerHTML = '<div class="empty">data.js 가 없습니다. <code>python run.py sample</code> 또는 <code>python run.py all</code> 을 실행하세요.</div>';
    return;
  }
  U.fillBranding(RAW.meta);
  document.title = `${RAW.meta.region} 홍보 성과 분석`;

  // ── 기사 레코드 ─────────────────────────────
  const ARTICLES = RAW.articles.map(([id, date, cluster, p, title, url, views, t]) =>
    ({ id, date, cluster, press: RAW.press[p], title, url, views, topic: RAW.topics[t] }));
  const issueName = (cid, fallback) => RAW.clusters[cid] || fallback;
  const dates = ARTICLES.map(a => a.date).sort();
  const FIRST = dates[0] || RAW.meta.startDate;
  const LAST = dates[dates.length - 1] || RAW.meta.startDate;

  // ── 날짜 계산 ─────────────────────────────
  const D = {
    parse: s => new Date(s + "T00:00:00"),
    fmt: d => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"),
    shift(s, n) { const d = this.parse(s); d.setDate(d.getDate() + n); return this.fmt(d); },
    span: (a, b) => Math.round((D.parse(b) - D.parse(a)) / 864e5) + 1,
    monday(s) { const d = this.parse(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return this.fmt(d); },
  };
  const GRAIN = {
    day: { name: "일간", per: "일별", peak: "날은", key: s => s, next: k => D.shift(k, 1),
      short: k => `${+k.slice(5, 7)}/${+k.slice(8)}`, long: k => k },
    week: { name: "주간", per: "주별", peak: "주는", key: s => D.monday(s), next: k => D.shift(k, 7),
      short: k => `${+k.slice(5, 7)}/${+k.slice(8)}주`, long: k => `${k} ~ ${D.shift(k, 6)}` },
    month: { name: "월간", per: "월별", peak: "달은", key: s => s.slice(0, 7),
      next: k => { const [y, m] = k.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; },
      short: k => `${k.slice(0, 4)}.${k.slice(5)}`, long: k => `${k.slice(0, 4)}년 ${+k.slice(5)}월` },
  };

  // ── 상태 ─────────────────────────────
  const S = { from: FIRST, to: LAST, grain: "week", topic: "", issuePage: 0, artPage: 0, expanded: new Set(), issues: [], rows: [] };
  const PER_PAGE = 30;

  // ── 집계 ─────────────────────────────
  const pick = (from, to) => ARTICLES.filter(a => a.date >= from && a.date <= to && (!S.topic || a.topic === S.topic));

  function aggregate(list) {
    const byIssue = new Map(), outlets = new Set(), days = new Set();
    let views = 0, viewed = 0;
    for (const a of list) {
      outlets.add(a.press); days.add(a.date);
      if (a.views != null) { views += a.views; viewed++; }
      let g = byIssue.get(a.cluster);
      if (!g) byIssue.set(a.cluster, g = { id: a.cluster, items: [], outlets: new Set(), views: 0, viewed: false, first: a.date, last: a.date, tc: {} });
      g.items.push(a); g.outlets.add(a.press);
      if (a.views != null) { g.views += a.views; g.viewed = true; }
      if (a.date < g.first) g.first = a.date;
      if (a.date > g.last) g.last = a.date;
      g.tc[a.topic] = (g.tc[a.topic] || 0) + 1;
    }
    const issues = [...byIssue.values()].map(g => {
      g.title = issueName(g.id, g.items[0].title);
      g.topic = Object.keys(g.tc).reduce((x, y) => g.tc[y] > g.tc[x] ? y : x);
      g.size = g.outlets.size >= 5 ? "l" : g.outlets.size >= 2 ? "m" : "s";
      return g;
    });
    return {
      n: list.length, issues, nIssues: issues.length, nPress: outlets.size, views, viewed,
      coverage: list.length ? viewed / list.length : null,
      perIssue: issues.length ? list.length / issues.length : null,
      big: issues.filter(g => g.size === "l").length, activeDays: days.size,
    };
  }
  const biggest = issues => issues.reduce((m, g) => !m || g.items.length > m.items.length ? g : m, null);

  function bucketize(list, from, to, grain) {
    const G = GRAIN[grain], out = new Map();
    for (let k = G.key(from), end = G.key(to); k <= end; k = G.next(k)) out.set(k, []);
    list.forEach(a => out.get(G.key(a.date))?.push(a));
    return [...out];
  }

  function countBy(list, f) {
    const m = new Map();
    list.forEach(a => { const k = f(a); const v = m.get(k) || { n: 0, views: 0, viewed: false }; v.n++; if (a.views != null) { v.views += a.views; v.viewed = true; } m.set(k, v); });
    return [...m];
  }

  // ── 차트 ─────────────────────────────
  U.chartDefaults();
  const CH = {};
  function bars(id, labels, values, { name, color, unit = "건", horizontal = false, titles, after }) {
    const grid = cssVar("--grid"), muted = cssVar("--muted"), ink = cssVar("--text-2");
    const val = { beginAtZero: true, grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: muted, padding: 6, callback: v => num(v) } };
    const cat = { grid: { display: false }, border: { color: grid }, ticks: { color: ink, maxRotation: 0, autoSkip: !horizontal } };
    const options = {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      indexAxis: horizontal ? "y" : "x", interaction: { mode: "index", intersect: false },
      scales: horizontal ? { x: val, y: cat } : { x: cat, y: val },
      plugins: {
        legend: { display: false },
        tooltip: { ...U.tooltipStyle(), displayColors: false, callbacks: {
          title: titles ? it => titles[it[0].dataIndex] : undefined,
          label: c => `${name}: ${num(horizontal ? c.parsed.x : c.parsed.y)}${unit}`,
          afterLabel: after ? c => after(c.dataIndex) : undefined,
        } },
      },
    };
    const dataset = { label: name, data: values, backgroundColor: color, borderRadius: 4, borderSkipped: "start",
      maxBarThickness: horizontal ? 18 : 28, categoryPercentage: .8, barPercentage: .9 };
    if (CH[id]) { Object.assign(CH[id].data, { labels, datasets: [dataset] }); CH[id].options = options; CH[id].update(); }
    else CH[id] = new Chart(el(id), { type: "bar", data: { labels, datasets: [dataset] }, options });
  }

  // ── 렌더링 ─────────────────────────────
  function change(cur, prev, what = "직전 동기간") {
    if (cur == null || prev == null) return `${what} 비교 불가`;
    if (prev === 0) return cur === 0 ? `${what} 대비 변동 없음` : `<span class="up">▲ 신규</span> ${what} 대비`;
    const r = (cur - prev) / prev;
    if (Math.abs(r) < 5e-4) return `${what} 대비 변동 없음`;
    return `<span class="${r > 0 ? "up" : "down"}">${r > 0 ? "▲" : "▼"} ${Math.abs(r * 100).toFixed(1)}%</span> ${what} 대비`;
  }

  function draw() {
    const G = GRAIN[S.grain];
    const rows = pick(S.from, S.to);
    const cur = aggregate(rows);
    const len = D.span(S.from, S.to);
    const prevTo = D.shift(S.from, -1);
    const prev = prevTo >= FIRST ? aggregate(pick(D.shift(S.from, -len), prevTo)) : null;

    el("kpiRow").innerHTML = [
      ["총 보도 건수", num(cur.n), "건", change(cur.n, prev?.n)],
      ["통합 이슈", num(cur.nIssues), "개", change(cur.nIssues, prev?.nIssues)],
      ["보도 매체", num(cur.nPress), "곳", change(cur.nPress, prev?.nPress)],
      ["확인 조회수", num(cur.views), "회", `조회수 공개율 ${pct(cur.coverage)}`],
      ["이슈당 평균 보도", cur.perIssue == null ? "–" : cur.perIssue.toFixed(1), "건", change(cur.perIssue, prev?.perIssue)],
      ["대형 확산 이슈", num(cur.big), "개", "5개 매체 이상 보도"],
    ].map(([k, v, u, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}<small>${u}</small></div><div class="d">${d}</div></div>`).join("");

    const B = bucketize(rows, S.from, S.to, S.grain);
    const lab = B.map(([k]) => G.short(k)), tit = B.map(([k]) => G.long(k));
    el("trendSub").textContent = `${G.per} ${RAW.meta.region} 관련 기사 건수 · ${S.from} ~ ${S.to}`;
    bars("cTrend", lab, B.map(([, v]) => v.length), { name: "보도 건수", color: cssVar("--c-articles"), titles: tit,
      after: i => { const s = aggregate(B[i][1]); return `통합 이슈: ${num(s.nIssues)}개 · 매체: ${num(s.nPress)}곳`; } });
    bars("cViews", lab, B.map(([, v]) => v.reduce((t, a) => t + (a.views || 0), 0)), { name: "확인 조회수", unit: "회", color: cssVar("--c-views"), titles: tit,
      after: i => `조회수 확보 기사: ${num(B[i][1].filter(a => a.views != null).length)}건` });

    const byTopic = countBy(rows, a => a.topic).sort((a, b) => b[1].n - a[1].n);
    bars("cTopic", byTopic.map(t => t[0]), byTopic.map(t => t[1].n), { name: "보도 건수", horizontal: true, color: cssVar("--c-articles"),
      after: i => `비중: ${pct(byTopic[i][1].n / (cur.n || 1))}` });

    const byPress = countBy(rows, a => a.press);
    const topN = byPress.slice().sort((a, b) => b[1].n - a[1].n).slice(0, 15);
    bars("cPress", topN.map(p => p[0]), topN.map(p => p[1].n), { name: "보도 건수", horizontal: true, color: cssVar("--c-articles"),
      after: i => topN[i][1].viewed ? `확인 조회수: ${num(topN[i][1].views)}회` : "조회수 비공개" });
    const topV = byPress.filter(p => p[1].viewed).sort((a, b) => b[1].views - a[1].views).slice(0, 15);
    bars("cPressViews", topV.map(p => p[0]), topV.map(p => p[1].views), { name: "확인 조회수", unit: "회", horizontal: true, color: cssVar("--c-views"),
      after: i => `기사 ${num(topV[i][1].n)}건 · 기사당 평균 ${num(topV[i][1].views / topV[i][1].n)}회` });

    drawSummary(cur, prev, B, len);
    drawPeriodTable(B);
    S.issues = cur.issues; S.rows = rows;
    drawIssues(); drawArticles();
  }

  function drawSummary(cur, prev, B, len) {
    const G = GRAIN[S.grain];
    el("sumSub").textContent = `${S.from} ~ ${S.to} (${len}일)` + (S.topic ? ` · 주제: ${S.topic}` : "") + (prev ? ` · 비교: 직전 ${len}일` : "");
    if (!cur.n) { el("sumList").innerHTML = "<li>선택한 기간에 수집된 기사가 없습니다.</li>"; el("sumTiles").innerHTML = ""; return; }
    const ranked = cur.issues.slice().sort((a, b) => b.items.length - a.items.length);
    const top3 = ranked.slice(0, 3);
    const lines = [];
    let first = `기간 중 기사 <b>${num(cur.n)}건</b>이 <b>${num(cur.nPress)}개 매체</b>에 실렸고, 비슷한 기사를 묶으면 <b>${num(cur.nIssues)}개 이슈</b>입니다.`;
    if (prev) first += ` 직전 같은 기간(${num(prev.n)}건)보다 ${cur.n >= prev.n ? "늘었습니다" : "줄었습니다"}(${pct((cur.n - prev.n) / (prev.n || 1))}).`;
    lines.push(first);
    lines.push(`하루 평균 <b>${(cur.n / len).toFixed(1)}건</b>꼴로 보도되었고, ${len}일 중 보도가 있었던 날은 <b>${cur.activeDays}일</b>(${pct(cur.activeDays / len)})입니다.`);
    const peak = B.reduce((m, b) => !m || b[1].length > m[1].length ? b : m, null);
    if (peak && peak[1].length) {
      const pi = biggest(aggregate(peak[1]).issues);
      lines.push(`보도가 가장 많았던 ${G.peak} <b>${G.long(peak[0])}</b>(${num(peak[1].length)}건)이고, 이때 대표 이슈는 “${esc(pi.title)}”입니다.`);
    }
    lines.push(`가장 많이 다뤄진 이슈: ${top3.map(g => `“${esc(g.title)}”(${g.items.length}건·${g.outlets.size}개 매체)`).join(", ")}.`);
    if (!S.topic) {
      const tc = {}; cur.issues.forEach(g => tc[g.topic] = (tc[g.topic] || 0) + g.items.length);
      const tt = Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 2);
      lines.push(`주제로 보면 ${tt.map(([t, n]) => `<b>${esc(t)}</b>(${pct(n / cur.n)})`).join(", ")} 비중이 큽니다.`);
    }
    lines.push(cur.viewed
      ? `조회수가 공개된 기사 ${num(cur.viewed)}건(공개율 ${pct(cur.coverage)})의 조회수 합계는 <b>${num(cur.views)}회</b>, 기사당 평균 <b>${num(cur.views / cur.viewed)}회</b>입니다.`
      : "기간 내 조회수가 확인된 기사가 없습니다.");
    el("sumList").innerHTML = lines.map(l => `<li>${l}</li>`).join("");

    el("sumTiles").innerHTML = [
      ["노출 (Volume)", `${num(cur.n)}건`, "기간 내 보도 건수"],
      ["확산 (Spread)", `${cur.perIssue.toFixed(1)}건/이슈`, `대형 확산 이슈 ${cur.big}개`],
      ["도달 (Reach)", `${num(cur.views)}회`, `조회수 공개율 ${pct(cur.coverage)}`],
      ["지속 (Continuity)", pct(cur.activeDays / len), "보도가 있었던 날의 비율"],
      ["매체 다양성", `${num(cur.nPress)}곳`, "보도한 매체 수"],
      ["이슈 집중도", pct(top3.reduce((t, g) => t + g.items.length, 0) / cur.n), "상위 3개 이슈의 보도 비중"],
    ].map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join("");
  }

  function drawPeriodTable(B) {
    const G = GRAIN[S.grain];
    el("periodTitle").textContent = `${G.name} 성과표`;
    const agg = B.map(([k, v]) => [k, aggregate(v)]);
    const head = ["기간", "#보도 건수", "#증감", "#통합 이슈", "#매체 수", "#이슈당 보도", "#확인 조회수", "#조회수 공개율", "최다 보도 이슈"]
      .map(h => h[0] === "#" ? `<th class="num">${h.slice(1)}</th>` : `<th>${h}</th>`).join("");
    const body = agg.map(([k, s], i) => {
      const p = agg[i - 1]?.[1];
      const r = p && p.n ? (s.n - p.n) / p.n : null;
      const top = biggest(s.issues);
      return `<tr><td class="nowrap">${G.long(k)}</td><td class="num">${num(s.n)}</td>
        <td class="num">${r == null ? '<span class="dim">–</span>' : `<span class="${r >= 0 ? "up" : "down"}">${r >= 0 ? "▲" : "▼"} ${Math.abs(r * 100).toFixed(0)}%</span>`}</td>
        <td class="num">${num(s.nIssues)}</td><td class="num">${num(s.nPress)}</td><td class="num">${s.perIssue == null ? "–" : s.perIssue.toFixed(1)}</td>
        <td class="num">${s.viewed ? num(s.views) : '<span class="dim">–</span>'}</td><td class="num">${pct(s.coverage)}</td>
        <td>${top ? `${esc(top.title)} <span class="dim">(${top.items.length}건)</span>` : '<span class="dim">보도 없음</span>'}</td></tr>`;
    }).reverse().join("");
    el("periodTbl").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  }

  const ORDER = {
    count: (a, b) => b.items.length - a.items.length || b.outlets.size - a.outlets.size,
    press: (a, b) => b.outlets.size - a.outlets.size || b.items.length - a.items.length,
    views: (a, b) => b.views - a.views,
    recent: (a, b) => b.last.localeCompare(a.last),
  };
  function issueList() {
    const q = el("issueQ").value.trim();
    return S.issues.filter(g => !q || g.title.includes(q) || g.items.some(a => a.title.includes(q))).sort(ORDER[el("issueOrder").value]);
  }
  function pageBar(kind, page, total) {
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    return `총 ${num(total)}건 · ${page + 1} / ${pages} 페이지
      <button class="btn" data-page="${kind}" data-go="${page - 1}" ${page <= 0 ? "disabled" : ""}>이전</button>
      <button class="btn" data-page="${kind}" data-go="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>다음</button>`;
  }
  const clampPage = (p, total) => Math.min(p, Math.max(0, Math.ceil(total / PER_PAGE) - 1));
  const link = a => a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>` : esc(a.title);

  function drawIssues() {
    const list = issueList();
    S.issuePage = clampPage(S.issuePage, list.length);
    const start = S.issuePage * PER_PAGE;
    const label = { l: "대", m: "중", s: "소" };
    let body = list.slice(start, start + PER_PAGE).map((g, i) => {
      const open = S.expanded.has(g.id);
      let tr = `<tr class="issue" data-issue="${g.id}"><td class="num">${start + i + 1}</td>
        <td><span class="caret">${open ? "▾" : "▸"}</span>${esc(g.title)}</td><td><span class="tag">${esc(g.topic)}</span></td>
        <td class="num">${num(g.items.length)}</td><td class="num">${num(g.outlets.size)}</td>
        <td class="nowrap">${g.first === g.last ? g.first : `${g.first} ~ ${g.last.slice(5)}`}</td>
        <td class="num">${g.viewed ? num(g.views) : '<span class="dim">–</span>'}</td><td><span class="pill ${g.size}">${label[g.size]}</span></td></tr>`;
      if (open) tr += `<tr class="items"><td colspan="8"><ul>${g.items.slice().sort((a, b) => a.date.localeCompare(b.date))
        .map(a => `<li>${a.date} · <b>${esc(a.press)}</b> · ${link(a)}${a.views != null ? ` · 조회 ${num(a.views)}` : ""}</li>`).join("")}</ul></td></tr>`;
      return tr;
    }).join("");
    if (!body) body = '<tr><td colspan="8" class="empty">해당하는 이슈가 없습니다.</td></tr>';
    el("issueTbl").innerHTML = `<thead><tr><th class="num">#</th><th>통합 제목</th><th>주제</th><th class="num">기사 수</th><th class="num">매체 수</th><th>보도 기간</th><th class="num">확인 조회수</th><th>확산</th></tr></thead><tbody>${body}</tbody>`;
    el("issuePages").innerHTML = pageBar("issue", S.issuePage, list.length);
  }

  function articleList() {
    const q = el("artQ").value.trim();
    return S.rows.filter(a => !q || a.title.includes(q) || a.press.includes(q)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  }
  function drawArticles() {
    const list = articleList();
    S.artPage = clampPage(S.artPage, list.length);
    const start = S.artPage * PER_PAGE;
    let body = list.slice(start, start + PER_PAGE).map(a => {
      const iss = issueName(a.cluster, a.title);
      return `<tr><td class="nowrap">${a.date}</td><td class="nowrap">${esc(a.press)}</td><td>${link(a)}</td>
        <td><span class="tag">${esc(a.topic)}</span></td><td class="dim">${iss === a.title ? "–" : esc(iss)}</td>
        <td class="num">${a.views != null ? num(a.views) : '<span class="dim">–</span>'}</td></tr>`;
    }).join("");
    if (!body) body = '<tr><td colspan="6" class="empty">해당하는 기사가 없습니다.</td></tr>';
    el("artTbl").innerHTML = `<thead><tr><th>보도일</th><th>매체</th><th>제목</th><th>주제</th><th>통합 이슈</th><th class="num">조회수</th></tr></thead><tbody>${body}</tbody>`;
    el("artPages").innerHTML = pageBar("art", S.artPage, list.length);
  }

  // ── 통계 분석 요약 (보고서 연동) ─────────────────────────────
  (function statBlock() {
    const R = window.NEWS_REPORT;
    if (!R || !R.ok) return;
    const find = v => (R.correlation || []).find(c => c.var === v);
    const shortSig = s => (s || "").replace(/\s*\(.*\)$/, "");
    const cells = [];
    const ci = find("issues"), cs = find("spread");
    if (ci) cells.push(["이슈 수 ↔ 보도량", `r = ${ci.pearson_r.toFixed(3)}`, `보정 p ${pval(ci.p_holm)} · ${shortSig(ci.significance)}`]);
    if (cs) cells.push(["이슈 확산도 ↔ 보도량", `r = ${cs.pearson_r.toFixed(3)}`, `보정 p ${pval(cs.p_holm)} · ${shortSig(cs.significance)}`]);
    if (R.trend) cells.push(["주간 보도 추세", `${R.trend.slope_per_week > 0 ? "+" : ""}${R.trend.slope_per_week}건/주`, `R² ${R.trend.r2} · p ${pval(R.trend.p)}`]);
    if (R.weekday) cells.push(["평일/주말 차이", `${R.weekday.ratio}배`, `Mann-Whitney p ${pval(R.weekday.p)}`]);
    const ai = R.ai;
    el("statBlock").innerHTML = `
      <div class="head"><h3>통계 분석 요약</h3>${ai ? `<span class="ai-tag">AI 해석 · ${esc(ai.model)}</span>` : ""}
        <span class="dim" style="font-size:12px">전체 기간 ${R.period.from} ~ ${R.period.until} 기준</span></div>
      ${ai ? `<p style="font-weight:700;margin:0 0 6px">${esc(ai.headline)}</p>` : ""}
      <div class="tiles four">${cells.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join("")}</div>
      ${ai ? `<ul>${(ai.key_findings || []).slice(0, 3).map(f => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      <div class="foot"><span class="dim" style="font-size:12px">상관·유의성은 Python(scipy)으로 계산${ai ? ", 해석 문장은 AI 작성" : ""} · 상관은 인과를 의미하지 않음</span>
        <a class="btn primary" href="report.html">성과 보고내용 보기 →</a></div>`;
    el("statBlock").hidden = false;
  })();

  // ── 필터·이벤트 ─────────────────────────────
  const fromIn = el("dateFrom"), toIn = el("dateTo");
  fromIn.min = toIn.min = FIRST; fromIn.max = toIn.max = LAST;
  RAW.topics.slice().sort().forEach(t => el("topicSel").insertAdjacentHTML("beforeend", `<option>${esc(t)}</option>`));
  el("sampleWarn").hidden = !RAW.meta.sample;
  el("stamp").innerHTML = `데이터 기간 ${FIRST} ~ ${LAST}<br>갱신 ${esc((RAW.meta.generated || "").replace("T", " "))}`;

  const mark = (seg, attr, val) => [...el(seg).children].forEach(b => b.classList.toggle("on", b.dataset[attr] === val));
  function setPeriod(from, to) {
    S.from = from < FIRST ? FIRST : from;
    S.to = to > LAST ? LAST : to;
    if (S.from > S.to) S.from = S.to;
    fromIn.value = S.from; toIn.value = S.to;
    S.issuePage = S.artPage = 0;
    draw();
  }
  el("presetSeg").addEventListener("click", e => {
    const p = e.target.dataset.preset; if (!p) return;
    mark("presetSeg", "preset", p);
    S.grain = { 7: "day", 30: "day", month: "day", quarter: "week", all: "week" }[p];
    mark("grainSeg", "grain", S.grain);
    const ranges = { all: [FIRST, LAST], month: [LAST.slice(0, 8) + "01", LAST], quarter: [D.shift(LAST, -90), LAST] };
    const [f, t] = ranges[p] || [D.shift(LAST, 1 - +p), LAST];
    setPeriod(f, t);
  });
  [fromIn, toIn].forEach(inp => inp.addEventListener("change", () => { mark("presetSeg", "preset", null); setPeriod(fromIn.value || FIRST, toIn.value || LAST); }));
  el("grainSeg").addEventListener("click", e => { const g = e.target.dataset.grain; if (!g) return; S.grain = g; mark("grainSeg", "grain", g); draw(); });
  el("topicSel").addEventListener("change", e => { S.topic = e.target.value; S.issuePage = S.artPage = 0; draw(); });
  el("issueQ").addEventListener("input", () => { S.issuePage = 0; drawIssues(); });
  el("issueOrder").addEventListener("change", () => { S.issuePage = 0; drawIssues(); });
  el("artQ").addEventListener("input", () => { S.artPage = 0; drawArticles(); });
  el("issueTbl").addEventListener("click", e => {
    const tr = e.target.closest("tr.issue"); if (!tr || e.target.closest("a")) return;
    const id = +tr.dataset.issue;
    S.expanded.has(id) ? S.expanded.delete(id) : S.expanded.add(id);
    drawIssues();
  });
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-page]"); if (!b || b.disabled) return;
    if (b.dataset.page === "issue") { S.issuePage = +b.dataset.go; drawIssues(); } else { S.artPage = +b.dataset.go; drawArticles(); }
  });
  const gradeKo = { l: "대", m: "중", s: "소" };
  el("issueCsvBtn").addEventListener("click", () => csv(`${RAW.meta.region}_주요이슈_${S.from}_${S.to}.csv`,
    ["통합 제목", "주제", "기사 수", "매체 수", "첫 보도일", "마지막 보도일", "확인 조회수", "확산 등급"],
    issueList().map(g => [g.title, g.topic, g.items.length, g.outlets.size, g.first, g.last, g.viewed ? g.views : "", gradeKo[g.size]])));
  el("artCsvBtn").addEventListener("click", () => csv(`${RAW.meta.region}_기사목록_${S.from}_${S.to}.csv`,
    ["보도일", "매체", "제목", "URL", "주제", "통합 이슈", "조회수"],
    articleList().map(a => [a.date, a.press, a.title, a.url, a.topic, issueName(a.cluster, a.title), a.views ?? ""])));

  // ── 관리자 (/admin) : server.py 의 API 사용 ─────────────────────────────
  const msg = (text, { busy = false, err = false } = {}) => {
    el("refreshMsg").textContent = text; el("refreshMsg").classList.toggle("err", err);
    el("refreshBtn").disabled = busy;
    el("refreshBtn").innerHTML = busy ? '<span class="spin">⟳</span> 갱신 중…' : "⟳ 최신 데이터로 갱신";
  };
  const api = async (path, opts) => { const r = await fetch(path, { cache: "no-store", ...opts }); return { status: r.status, body: await r.json() }; };
  function showLogin(text = "") { el("adminBox").hidden = true; el("loginModal").hidden = false; el("loginErr").textContent = text; el("loginId").focus(); }
  let pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const { body } = await api("/api/refresh-status");
        if (body.state === "running") { msg(`수집 중… ${body.message || ""}`, { busy: true }); return poll(); }
        if (body.state === "failed") return msg(body.message || "수집에 실패했습니다.", { err: true });
        msg("완료되었습니다. 화면을 새로 고칩니다…", { busy: true }); setTimeout(() => location.reload(), 1000);
      } catch (e) { msg("서버 응답을 기다리는 중…", { busy: true }); poll(); }
    }, 5000);
  }
  async function enterAdmin() {
    el("loginModal").hidden = true; el("adminBox").hidden = false;
    try {
      const { status, body } = await api("/api/refresh-status");
      if (status === 401) return showLogin();
      if (!body.enabled) { msg(body.message, { err: true }); el("refreshBtn").disabled = true; return; }
      if (body.state === "running") { msg("수집 중…", { busy: true }); poll(); }
    } catch (e) { msg("갱신 서버에 연결할 수 없습니다.", { err: true }); }
  }
  if (location.pathname.replace(/\/+$/, "") === "/admin") {
    document.title = `관리자 · ${document.title}`;
    api("/api/admin/me").then(r => r.body.admin ? enterAdmin() : showLogin()).catch(() => showLogin("관리자 기능을 지원하지 않는 서버입니다. server.py 로 실행하세요."));
  }
  el("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const { status, body } = await api("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: el("loginId").value.trim(), password: el("loginPw").value }) });
      el("loginPw").value = "";
      status === 200 ? enterAdmin() : showLogin(body.message || "로그인에 실패했습니다.");
    } catch (err) { showLogin("서버에 연결할 수 없습니다."); }
  });
  el("logoutBtn").addEventListener("click", async () => { try { await fetch("/api/admin/logout", { method: "POST" }); } catch (e) {} location.href = "/"; });
  el("refreshBtn").addEventListener("click", async () => {
    if (!confirm("네이버 뉴스에서 최신 기사를 다시 수집하고 분석합니다.\n몇 분 정도 걸릴 수 있습니다. 진행할까요?")) return;
    msg("수집 요청 중…", { busy: true });
    try {
      const { status, body } = await api("/api/refresh", { method: "POST" });
      if (status === 401) return showLogin("로그인이 만료되었습니다. 다시 로그인하세요.");
      if (status === 202) { msg(body.message, { busy: true }); poll(); } else msg(body.message || "갱신 요청에 실패했습니다.", { err: true });
    } catch (e) { msg("서버에 연결할 수 없습니다.", { err: true }); }
  });

  fromIn.value = S.from; toIn.value = S.to;
  U.initTheme(draw);
  draw();
})();
