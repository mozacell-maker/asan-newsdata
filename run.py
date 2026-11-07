#!/usr/bin/env python3
"""지역 뉴스 홍보 성과 분석 시스템 — 수집·가공·통계 파이프라인.

사용법
  python run.py sample   # 샘플 데이터로 data.js 생성 (API 키 없이 화면 확인용)
  python run.py collect  # 네이버 뉴스 검색 API로 기사 수집 (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필요)
  python run.py build    # 수집 기사 → 이슈 통합·주제 분류 → data.js
  python run.py report   # 통계 분석(+ GEMINI_API_KEY 있으면 AI 해석) → data.js 에 보고서 포함
  python run.py all      # collect → build → report
"""
import html
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
STORE = DATA_DIR / "articles.jsonl"
REPORT_FILE = DATA_DIR / "report.json"
OUT_JS = ROOT / "data.js"
CFG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
DATA_DIR.mkdir(exist_ok=True)


# ─────────────────────────── 저장소 ───────────────────────────
def load_store():
    if not STORE.exists():
        return []
    return [json.loads(l) for l in STORE.read_text(encoding="utf-8").splitlines() if l.strip()]


def save_store(rows):
    rows.sort(key=lambda r: (r["date"], r["url"]))
    STORE.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")


def clean(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def relevant(title, desc):
    text = f"{title} {desc}"
    if any(x in text for x in CFG["exclude"]):
        # 제외어가 있어도 '아산시'가 명시되면 유지
        return CFG["region"] in text
    return any(k in text for k in CFG["mustContain"])


# ─────────────────────────── 수집 ───────────────────────────
def press_from_url(url):
    host = urllib.parse.urlparse(url).netloc.lower()
    return re.sub(r"^(www|m|news)\.", "", host) or "알 수 없음"


def press_from_page(url, page):
    m = re.search(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']{1,40})', page)
    name = clean(m.group(1)) if m else ""
    return name if name and len(name) <= 20 else press_from_url(url)


def http_get(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (news-monitor)", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read(600_000)
        enc = r.headers.get_content_charset() or "utf-8"
    return raw.decode(enc, errors="replace")


def fetch_page_info(url):
    """원문 페이지에서 매체명·조회수를 추출(공개된 경우만)."""
    try:
        page = http_get(url, timeout=10)
    except Exception:
        return press_from_url(url), None
    views = None
    if CFG["viewCount"]["enabled"]:
        for pat in CFG["viewCount"]["patterns"]:
            m = re.search(pat, re.sub(r"<[^>]+>", " ", page))
            if m:
                views = int(m.group(1).replace(",", ""))
                break
    return press_from_page(url, page), views


def collect():
    cid, secret = os.environ.get("NAVER_CLIENT_ID"), os.environ.get("NAVER_CLIENT_SECRET")
    if not cid or not secret:
        sys.exit("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 필요합니다. (developers.naver.com 에서 발급)")
    rows = load_store()
    seen = {r["url"] for r in rows}
    start = CFG["startDate"]
    added = 0
    for q in CFG["queries"]:
        for st in range(1, 1001, 100):  # 네이버 검색은 검색어당 최대 1,000건
            url = "https://openapi.naver.com/v1/search/news.json?" + urllib.parse.urlencode(
                {"query": q, "display": 100, "start": st, "sort": "date"})
            try:
                data = json.loads(http_get(url, {"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": secret}))
            except Exception as e:
                print(f"  ! {q} start={st}: {e}")
                break
            items = data.get("items", [])
            stop = False
            for it in items:
                link = it.get("originallink") or it.get("link")
                d = parsedate_to_datetime(it["pubDate"]).date().isoformat()
                if d < start:
                    stop = True
                    continue
                title, desc = clean(it["title"]), clean(it["description"])
                if link in seen or not relevant(title, desc):
                    continue
                press, views = fetch_page_info(link)
                rows.append({"date": d, "press": press, "title": title, "desc": desc, "url": link, "views": views, "src": "naver"})
                seen.add(link)
                added += 1
            print(f"  {q} start={st}: {len(items)}건 조회, 누적 신규 {added}건")
            if stop or len(items) < 100:
                break
            time.sleep(0.15)
    save_store(rows)
    print(f"수집 완료: 신규 {added}건, 전체 {len(rows)}건")


# ─────────────────────────── 가공 ───────────────────────────
def norm_title(t):
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)|【[^】]*】", " ", t)
    return re.sub(r"[^0-9A-Za-z가-힣]", "", t)


def bigrams(t):
    t = norm_title(t)
    return {t[i:i + 2] for i in range(len(t) - 1)} or {t}


def cluster(rows, window=3, threshold=0.45):
    """3일 이내 기사 중 제목 바이그램 유사도(Dice)가 기준 이상이면 같은 이슈로 묶는다."""
    parent = list(range(len(rows)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    grams = [bigrams(r["title"]) for r in rows]
    dates = [date.fromisoformat(r["date"]) for r in rows]
    order = sorted(range(len(rows)), key=lambda i: dates[i])
    first = {i: dates[i] for i in range(len(rows))}  # 이슈(루트)별 최초 보도일 — 연쇄 병합 방지
    for a_pos, i in enumerate(order):
        for j in order[a_pos + 1:]:
            if (dates[j] - dates[i]).days > window:
                break
            ri, rj = find(i), find(j)
            if ri == rj or (dates[j] - first[ri]).days > window:
                continue
            gi, gj = grams[i], grams[j]
            if 2 * len(gi & gj) / (len(gi) + len(gj)) >= threshold:
                parent[rj] = ri
                first[ri] = min(first[ri], first[rj])
    return [find(i) for i in range(len(rows))]


def classify(title, desc):
    text = f"{title} {title} {desc}"  # 제목 가중치 2배
    scores = {t: sum(text.count(k) for k in kws) for t, kws in CFG["topics"].items()}
    best = max(scores.items(), key=lambda x: x[1])
    return best[0] if best[1] > 0 else "기타"


def build(sample=False):
    rows = load_store()
    if not rows:
        sys.exit("수집된 기사가 없습니다. python run.py collect 또는 python run.py sample 을 먼저 실행하세요.")
    rows.sort(key=lambda r: (r["date"], r["url"]))
    roots = cluster(rows)
    # 이슈 대표 제목: 가장 짧지 않은 '중간 길이'의 최초 보도 제목
    groups = defaultdict(list)
    for i, root in enumerate(roots):
        groups[root].append(i)
    cid = {root: n for n, root in enumerate(sorted(groups, key=lambda r: groups[r][0]))}
    cluster_titles = {}
    for root, idx in groups.items():
        if len(idx) > 1:
            cluster_titles[cid[root]] = rows[idx[0]]["title"]
    topics = list(CFG["topics"]) + ["기타"]
    press = sorted({r["press"] for r in rows}, key=lambda p: -sum(1 for r in rows if r["press"] == p))
    pidx = {p: i for i, p in enumerate(press)}
    arts = []
    for i, r in enumerate(rows):
        t = r.get("topic") or classify(r["title"], r.get("desc", ""))
        arts.append([i, r["date"], cid[roots[i]], pidx[r["press"]], r["title"], r["url"], r.get("views"), topics.index(t)])
    data = {
        "meta": {
            "generated": datetime.now().strftime("%Y-%m-%dT%H:%M"),
            "sample": sample,
            "region": CFG["region"],
            "systemName": CFG["systemName"],
            "orgName": CFG["orgName"],
            "startDate": CFG["startDate"],
            "queries": CFG["queries"],
            "sources": dict(Counter(r.get("src", "naver") for r in rows)),
        },
        "press": press, "topics": topics, "clusters": cluster_titles, "articles": arts,
    }
    report = json.loads(REPORT_FILE.read_text(encoding="utf-8")) if REPORT_FILE.exists() else None
    write_js(data, report)
    print(f"data.js 생성: 기사 {len(arts)}건, 이슈 {len(groups)}개, 매체 {len(press)}곳")
    return data


def write_js(data, report):
    js = "window.NEWS_DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    js += "window.NEWS_REPORT = " + json.dumps(report, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUT_JS.write_text(js, encoding="utf-8")


def read_js():
    s = OUT_JS.read_text(encoding="utf-8")
    m = re.match(r"window\.NEWS_DATA = (.*?);\nwindow\.NEWS_REPORT = ", s, re.S)
    return json.loads(m.group(1))


# ─────────────────────────── 통계 보고서 ───────────────────────────
def report():
    import numpy as np
    from scipy import stats

    D = read_js()
    topics, press = D["topics"], D["press"]
    A = [{"date": a[1], "cluster": a[2], "press": press[a[3]], "views": a[6], "topic": topics[a[7]]} for a in D["articles"]]
    d0 = min(date.fromisoformat(a["date"]) for a in A)
    d1 = max(date.fromisoformat(a["date"]) for a in A)
    days = [d0 + timedelta(n) for n in range((d1 - d0).days + 1)]
    daily = Counter(a["date"] for a in A)
    daily_vals = np.array([daily.get(d.isoformat(), 0) for d in days], float)

    def wk(s):
        d = date.fromisoformat(s)
        return (d - timedelta(d.weekday())).isoformat()

    # 진행 중인 마지막 주(7일 미만)는 제외
    last_full = (d1 - timedelta(d1.weekday())) if d1.weekday() == 6 else (d1 - timedelta(d1.weekday() + 7))
    weeks = sorted({wk(a["date"]) for a in A} | {wk(d.isoformat()) for d in days})
    weeks = [w for w in weeks if w <= last_full.isoformat()]
    byw = defaultdict(list)
    for a in A:
        byw[wk(a["date"])].append(a)
    W = []
    for w in weeks:
        L = byw.get(w, [])
        cl = Counter(a["cluster"] for a in L)
        pr = {a["press"] for a in L}
        vv = [a["views"] for a in L if a["views"] is not None]
        W.append({"week": w, "articles": len(L), "issues": len(cl), "spread": len(L) / len(cl) if cl else 0,
                  "press": len(pr), "wide": sum(1 for c in cl if len({a["press"] for a in L if a["cluster"] == c}) >= 5),
                  "views_per": float(np.mean(vv)) if vv else None})
    y = np.array([w["articles"] for w in W], float)

    def desc(v):
        v = np.asarray(v, float)
        m = v.mean()
        return {"n": int(len(v)), "mean": round(m, 2), "sd": round(v.std(ddof=1), 2), "median": float(np.median(v)),
                "min": int(v.min()), "max": int(v.max()), "cv": round(v.std(ddof=1) / m, 3) if m else None}

    def sig_text(p):
        if p is None:
            return "판단 불가"
        return "매우 유의 (p<0.001)" if p < .001 else "유의 (p<0.01)" if p < .01 else "유의 (p<0.05)" if p < .05 else "유의하지 않음"

    def strength(r):
        r = abs(r)
        return "매우 강함" if r >= .8 else "강함" if r >= .6 else "보통" if r >= .4 else "약함" if r >= .2 else "거의 없음"

    x = np.arange(len(y))
    lr = stats.linregress(x, y)
    sp = stats.spearmanr(x, y)
    trend = {"n": len(y), "slope_per_week": round(lr.slope, 2), "intercept": round(lr.intercept, 2), "r2": round(lr.rvalue ** 2, 3),
             "p": float(lr.pvalue), "spearman_rho": round(float(sp.statistic), 3), "spearman_p": float(sp.pvalue),
             "significance": sig_text(lr.pvalue), "direction": "증가" if lr.slope > 0 else "감소",
             "series": [{"week": w["week"], "articles": w["articles"]} for w in W]}

    specs = [
        ("issues", "통합 이슈 수", "보도자료·이슈가 많을수록 보도량이 늘어나는가",
         "보도 건수 = 이슈 수 × 이슈당 보도 건수이므로 구조적으로 높은 상관이 예상됨"),
        ("spread", "이슈당 보도 건수", "이슈가 여러 매체로 퍼질수록 보도량이 늘어나는가", None),
        ("press", "보도 매체 수", "다양한 매체가 다룰수록 보도량이 늘어나는가", None),
        ("wide", "대형 확산 이슈 수", "대형 이슈가 보도량을 끌어올리는가", None),
        ("views_per", "기사당 확인 조회수", "보도량이 많은 주에 기사당 조회수도 높은가", None),
    ]
    corr = []
    for key, label, q, note in specs:
        pts = [(w[key], w["articles"]) for w in W if w[key] is not None]
        if len(pts) < 5 or len({p[0] for p in pts}) < 2:
            continue
        xs, ys = np.array(pts, float).T
        r, p = stats.pearsonr(xs, ys)
        n = len(xs)
        z, se = np.arctanh(np.clip(r, -.9999, .9999)), 1 / np.sqrt(max(n - 3, 1))
        rho = stats.spearmanr(xs, ys)
        corr.append({"var": key, "label": label, "question": q, "note": note, "n": n, "small_sample": n < 20,
                     "pearson_r": round(float(r), 3), "pearson_p": float(p),
                     "ci95": [round(float(np.tanh(z - 1.96 * se)), 3), round(float(np.tanh(z + 1.96 * se)), 3)],
                     "spearman_rho": round(float(rho.statistic), 3), "strength": strength(r),
                     "points": [[round(a, 2), int(b)] for a, b in pts]})
    # Holm 보정
    order = sorted(range(len(corr)), key=lambda i: corr[i]["pearson_p"])
    prev = 0
    for rank, i in enumerate(order):
        adj = min(1.0, max(prev, corr[i]["pearson_p"] * (len(corr) - rank)))
        corr[i]["p_holm"], corr[i]["significance"] = adj, sig_text(adj)
        prev = adj
    keys = ["articles"] + [c["var"] for c in corr]
    labels = ["보도 건수"] + [c["label"] for c in corr]
    M = []
    for a in keys:
        row = []
        for b in keys:
            pts = [(w[a], w[b]) for w in W if w[a] is not None and w[b] is not None]
            xs, ys = np.array(pts, float).T
            row.append(round(float(np.corrcoef(xs, ys)[0, 1]), 3) if xs.std() and ys.std() else None)
        M.append(row)

    wd_flag = np.array([d.weekday() < 5 for d in days])
    wkd, wke = daily_vals[wd_flag], daily_vals[~wd_flag]
    mw = stats.mannwhitneyu(wkd, wke, alternative="two-sided")
    zval = stats.norm.isf(mw.pvalue / 2)
    by_dow = [daily_vals[[d.weekday() == k for d in days]] for k in range(7)]
    kw = stats.kruskal(*by_dow)
    weekday = {"weekday_mean": round(wkd.mean(), 2), "weekend_mean": round(wke.mean(), 2),
               "ratio": round(wkd.mean() / wke.mean(), 2) if wke.mean() else None,
               "mannwhitney_u": float(mw.statistic), "p": float(mw.pvalue), "effect_r": round(zval / np.sqrt(len(daily_vals)), 3),
               "kruskal_h": round(float(kw.statistic), 2), "kruskal_p": float(kw.pvalue),
               "dow_mean": [round(float(v.mean()), 2) for v in by_dow]}

    # 주제별 확산력
    cl_press, cl_topic = defaultdict(set), defaultdict(Counter)
    for a in A:
        cl_press[a["cluster"]].add(a["press"])
        cl_topic[a["cluster"]][a["topic"]] += 1
    tgroups = defaultdict(list)
    for c, ps in cl_press.items():
        tgroups[cl_topic[c].most_common(1)[0][0]].append(len(ps))
    tg = {t: v for t, v in tgroups.items() if len(v) >= 20}
    topic_spread = None
    if len(tg) >= 2:
        h = stats.kruskal(*tg.values())
        N = sum(len(v) for v in tg.values())
        topic_spread = {"kruskal_h": round(float(h.statistic), 2), "p": float(h.pvalue), "epsilon2": round(float(h.statistic) / (N - 1), 3),
                        "groups": sorted([{"topic": t, "issues": len(v), "mean_press": round(float(np.mean(v)), 2),
                                           "median_press": float(np.median(v)), "wide_share": round(sum(1 for x in v if x >= 5) / len(v), 3)}
                                          for t, v in tg.items()], key=lambda g: -g["mean_press"])}

    months = sorted({a["date"][:7] for a in A})
    tlist = [t for t in topics if any(a["topic"] == t for a in A)]
    tab = np.array([[sum(1 for a in A if a["date"][:7] == m and a["topic"] == t) for t in tlist] for m in months], float)
    tab_nz = tab[:, tab.sum(0) > 0][tab.sum(1) > 0]
    chi = stats.chi2_contingency(tab_nz)
    topic_month = {"chi2": round(float(chi.statistic), 2), "dof": int(chi.dof), "p": float(chi.pvalue),
                   "cramers_v": round(float(np.sqrt(chi.statistic / (tab_nz.sum() * (min(tab_nz.shape) - 1)))), 3),
                   "months": months, "topics": tlist,
                   "share": [[round(v / row.sum() * 100, 1) if row.sum() else 0 for v in row] for row in tab]}

    budget_file = DATA_DIR / "budget.json"  # {"2026-01": 12000000, ...}
    budget = {"available": False, "note": "홍보비 집행 자료(data/budget.json, 월별 금액)가 없어 분석하지 않았습니다."}
    if budget_file.exists():
        bud = json.loads(budget_file.read_text(encoding="utf-8"))
        mc = Counter(a["date"][:7] for a in A)
        pts = [(bud[m], mc.get(m, 0)) for m in sorted(bud) if m in mc]
        if len(pts) >= 4:
            xs, ys = np.array(pts, float).T
            r, p = stats.pearsonr(xs, ys)
            budget = {"available": True, "n": len(pts), "pearson_r": round(float(r), 3), "pearson_p": float(p),
                      "spearman_rho": round(float(stats.spearmanr(xs, ys).statistic), 3),
                      "cost_per_article": round(xs.sum() / ys.sum()) if ys.sum() else None}

    R = {"ok": True, "generated": datetime.now().strftime("%Y-%m-%dT%H:%M"),
         "period": {"from": weeks[0] if weeks else d0.isoformat(), "until": d1.isoformat(), "days": len(days), "weeks": len(W)},
         "n_articles": len(A), "alpha": 0.05,
         "descriptive": {"weekly_articles": desc(y), "daily_articles": desc(daily_vals)},
         "trend": trend, "correlation": corr, "matrix": {"labels": labels, "r": M}, "weekday": weekday,
         "topic_spread": topic_spread, "topic_month": topic_month, "budget": budget,
         "limitations": [
             "네이버 뉴스 검색 결과 기반으로, 검색어에 걸리지 않은 기사는 포함되지 않음",
             "조회수는 원문에 조회수를 공개한 일부 매체만 수집되어 전체 노출 규모를 대표하지 않음",
             "주제 분류는 키워드 규칙 기반 자동 분류로 오분류 가능성이 있음",
             "상관관계는 인과관계를 의미하지 않음",
         ]}
    R["ai"] = gemini_interpret(R)
    REPORT_FILE.write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
    write_js(D, R)
    print(f"보고서 생성: {len(W)}주, 상관 {len(corr)}개 변수" + (" · AI 해석 포함" if R["ai"] else " · AI 해석 없음(GEMINI_API_KEY 미설정)"))


def gemini_interpret(R):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    slim = {k: v for k, v in R.items() if k not in ("ai",)}
    slim["trend"] = {k: v for k, v in R["trend"].items() if k != "series"}
    slim["correlation"] = [{k: v for k, v in c.items() if k != "points"} for c in R["correlation"]]
    prompt = (f"다음은 {CFG['region']} 관련 언론 보도 통계 분석 결과(JSON)이다. 수치만 근거로, 과장 없이 지방자치단체 홍보 담당자용 해석을 한국어로 작성하라. "
              "상관은 인과가 아님을 유의하라. 반드시 아래 JSON 형식만 출력하라: "
              '{"headline": "한 문장", "key_findings": ["3~5개"], "sections": {"trend": "", "correlation": "", "weekday": "", '
              '"topic_spread": "", "topic_month": "", "budget": ""}, "recommendations": ["3~5개"]}\n\n'
              + json.dumps(slim, ensure_ascii=False))
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}],
                       "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3}}).encode()
    req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                                 data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            out = json.loads(r.read())
        ai = json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
        ai["model"] = model
        return ai
    except Exception as e:
        print(f"  ! Gemini 해석 실패: {e}")
        return None


# ─────────────────────────── 샘플 데이터 ───────────────────────────
def sample():
    """화면 확인용 가상 데이터. 매체명·기사·조회수는 모두 가짜입니다."""
    rnd = random.Random(42)
    press = [f"{a}{b}" for a in ["충청", "중부", "한빛", "새벽", "온누리", "바른", "열린", "푸른", "미래", "지역"] for b in ["일보", "뉴스", "신문", "타임즈"]]
    view_press = set(press[::3])
    subjects = {
        "경제·산업·일자리": ["{r}, 반도체 기업과 {n}억 규모 투자 협약", "{r} 청년 일자리 박람회 성황", "{r} 소상공인 경영안정자금 지원 확대"],
        "관광·문화·축제": ["{r} 봄꽃 축제 관광객 {n}만 명 돌파", "{r} 온천 관광 활성화 프로그램 운영", "{r} 가을 문화공연 시리즈 개막"],
        "의회·정치": ["{r}의회, 정례회서 조례안 {n}건 의결", "{r}의회 의장단 지역 현안 간담회"],
        "도시·교통·개발": ["{r} 광역철도 연장 사업 탄력", "{r} 도심 도로 확장 공사 착공", "{r} 신도시 개발 계획 발표"],
        "행정·시정": ["{r}, 내년 예산 {n}억 편성", "{r}장, 읍면동 순회 민원 간담회", "{r} 시정 성과 보고회 개최"],
        "체육": ["{r} 시민 마라톤 대회 {n}명 참가", "{r} 축구단 홈경기 승리"],
        "교육·청년": ["{r} 청년 정책 설명회 개최", "{r} 학교 급식 지원 확대"],
        "환경·안전": ["{r} 여름철 폭우 대비 안전 점검", "{r} 탄소중립 실천 캠페인"],
        "복지·보건": ["{r} 어르신 돌봄 서비스 확대", "{r} 임산부 교통비 지원 시행", "{r} 이웃돕기 성금 기탁 이어져"],
    }
    region = CFG["region"]
    start = date.fromisoformat(CFG["startDate"])
    end = date.today()
    rows = []
    n_days = (end - start).days + 1
    for di in range(n_days):
        d = start + timedelta(di)
        growth = 0.4 + 2.2 * di / n_days
        n_issues = max(0, int(rnd.gauss(4 * growth, 2) * (0.45 if d.weekday() >= 5 else 1)))
        for _ in range(n_issues):
            topic = rnd.choices(list(subjects), weights=[14, 16, 8, 13, 18, 6, 7, 7, 11])[0]
            base = rnd.choice(subjects[topic]).format(r=region, n=rnd.randint(2, 90))
            k = max(1, int(rnd.paretovariate(1.3)))
            k = min(k, 18)
            for pr in rnd.sample(press, k):
                dd = d + timedelta(rnd.choice([0, 0, 0, 1, 2]))
                if dd > end:
                    continue
                title = base if rnd.random() < .5 else rnd.choice(["", "[포토] ", "[지역] "]) + base + rnd.choice(["", "…주민 호응", " 눈길"])
                views = int(rnd.lognormvariate(6.3, .8)) if pr in view_press else None
                rows.append({"date": dd.isoformat(), "press": pr, "title": title, "desc": "", "topic": topic,
                             "url": f"https://example.com/news/{len(rows) + 1}", "views": views, "src": "sample"})
    save_store(rows)
    REPORT_FILE.unlink(missing_ok=True)
    build(sample=True)
    report()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "help"
    if cmd == "collect":
        collect()
    elif cmd == "build":
        build()
    elif cmd == "report":
        report()
    elif cmd == "sample":
        sample()
    elif cmd == "all":
        collect(); build(); report()
    else:
        print(__doc__)
