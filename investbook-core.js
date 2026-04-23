// ============================================================================
//  InvestBook Core — čisté (pure) funkce pro výpočty
// ----------------------------------------------------------------------------
//  Tento soubor obsahuje matematickou logiku InvestBooku vytaženou z HTML,
//  aby se dala samostatně testovat (viz tests.html) a aby se v jednom místě
//  řešily výpočty portfolia, rizikových metrik, YTD, FIRE a inflace.
//
//  Pravidla:
//  - žádné React/DOM/síťové závislosti
//  - každá funkce má vstup → výstup, žádný skrytý stav
//  - data (historie portfolia, FX kurzy, CPI) se předávají jako argumenty
//
//  Použití v prohlížeči:  <script src="investbook-core.js"></script>
//                          → window.InvestBookCore.<funkce>
//  Použití v Node testu:   const C = require('./investbook-core.js');
// ============================================================================

(function (globalObj) {
  'use strict';

  // ── Parsing čísel (mezery jako oddělovač tisíců, čárka jako desetinná) ──
  const pf = s => {
    if (s == null || s === "") return 0;
    const n = parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : 0;
  };
  const pfn = s => {
    if (s == null || s === "") return null;
    const n = parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
    return isFinite(n) ? n : null;
  };
  const parseFlt = s => {
    const n = parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
    return isNaN(n) ? 0 : n;
  };

  // ── FX helper ─────────────────────────────────────────────────────────
  // pos.fx má přednost; jinak se použije slovník aktuálních kurzů podle měny.
  const fxRate = (pos, rates) => {
    if (pos.fx) return pos.fx;
    if (pos.currency === "EUR") return rates.EUR;
    if (pos.currency === "GBP") return rates.GBP;
    if (pos.currency === "USD") return rates.USD;
    return 1; // CZK nebo neznámá měna
  };

  // ── Max Drawdown (největší propad od vrcholu, v %) ───────────────────
  // Bere historii [{d, v}, ...], vrací kladné číslo v %.
  function maxDrawdown(history) {
    let peak = 0, dd = 0;
    history.forEach(pt => {
      if (pt.v > peak) peak = pt.v;
      const d = peak > 0 ? (peak - pt.v) / peak * 100 : 0;
      if (d > dd) dd = d;
    });
    return dd;
  }

  // ── Volatilita (anualizovaná z měsíčních returnů, v %) ───────────────
  function portfolioVolatility(history) {
    if (history.length < 2) return 0;
    const rets = [];
    for (let i = 1; i < history.length; i++) {
      if (history[i - 1].v > 0) {
        rets.push((history[i].v - history[i - 1].v) / history[i - 1].v);
      }
    }
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (rets.length - 1);
    return Math.sqrt(variance * 12) * 100;
  }

  // ── Portfolio CAGR z historie (první → poslední bod) ────────────────
  // Vrací null, pokud nejde spočítat (málo dat, nulová výchozí hodnota).
  function portfolioCAGR(history) {
    if (history.length < 2) return null;
    const first = history[0].v;
    const last = history[history.length - 1].v;
    const yrs = (new Date(history[history.length - 1].d + "-01")
      - new Date(history[0].d + "-01")) / (1000 * 60 * 60 * 24 * 365.25);
    if (yrs <= 0 || first <= 0) return null;
    return (Math.pow(last / first, 1 / yrs) - 1) * 100;
  }

  // ── Sharpe ratio = (CAGR − bezriziková sazba) / volatilita ──────────
  function sharpeRatio(cagr, vol, riskFree) {
    if (riskFree == null) riskFree = 3.5; // default 3.5% CZK
    if (cagr == null || vol === 0 || !isFinite(vol)) return null;
    return (cagr - riskFree) / vol;
  }

  // ── Vážený průměrný roční výnos portfolia (CAGR) ────────────────────
  // Počítá CAGR s tím, že každá pozice přispívá k délce portfolio life
  // proporčně ke své investované částce. Tím neprotahuje staré crypto pozice
  // (malý objem, hodně let) celé portfolio.
  function calcWeightedAnnReturn(rows, nowYear) {
    let totalValCZK = 0, totalInvCZK = 0, weightedYearsSum = 0;
    for (const p of rows) {
      if (!p.invested || p.invested <= 0) continue;
      if (!p.investedCZK || p.investedCZK <= 0) continue;
      let valCZK;
      if (p.currency === "CZK") {
        valCZK = p.value || p.invested;
      } else {
        valCZK = (p.priceCZK && p.shares) ? p.priceCZK * p.shares : null;
      }
      if (valCZK === null) continue;
      const years = Math.max(1, nowYear - (p.start || nowYear));
      totalValCZK += valCZK;
      totalInvCZK += p.investedCZK;
      weightedYearsSum += p.investedCZK * years;
    }
    if (totalInvCZK <= 0 || totalValCZK <= 0) return 0;
    const years = Math.max(1, weightedYearsSum / totalInvCZK);
    const ratio = totalValCZK / totalInvCZK;
    const cagr = (Math.pow(ratio, 1 / years) - 1) * 100;
    return isFinite(cagr) ? cagr : 0;
  }

  // ── YTD výnos s FX korekcí ────────────────────────────────────────────
  // Když přepneš zobrazení do USD/EUR, baseline se přepočítá lednovým
  // kurzem a "now" aktuálním kurzem — tím odstraníš zkreslení kvůli pohybu
  // CZK vůči cizí měně.
  //   opts = { history, nowYear, dispValue, janFx, nowFx, chartKey? }
  //   chartKey = pro filtrovanou kategorii ("fond" / "akcie" / "crypto")
  function ytdGainPct(opts) {
    const { history, nowYear, dispValue, janFx, nowFx, chartKey } = opts;
    if (!history || history.length === 0) return null;
    const startEntry = history.slice().reverse().find(h => {
      const [y, m] = h.d.split("-");
      return parseInt(y) === nowYear && m === "01";
    });
    if (!startEntry) return null;
    const startV = chartKey ? (startEntry[chartKey] || startEntry.v) : startEntry.v;
    if (startV <= 0 || !janFx || !nowFx) return null;
    const nowNative = dispValue / nowFx;
    const startNative = startV / janFx;
    if (startNative <= 0) return null;
    return ((nowNative - startNative) / startNative) * 100;
  }

  // ── Benchmark (S&P 500 / MSCI World) rekonstrukce z ročních výnosů ──
  // Bere historii portfolia jako osu X a aplikuje roční výnosy benchmarku,
  // čímž vytvoří srovnatelnou linku. Volitelně extraDates = ["2026-04", ...].
  function computeBenchmarkValue(date, history, annualReturns) {
    if (!history || history.length === 0) return 0;
    const startVal = history[0].v;
    const startYr = Number(history[0].d.split("-")[0]);
    const [yr, mo] = date.split("-").map(Number);
    let cum = 1;
    for (let y = startYr; y < yr; y++) cum *= (1 + (annualReturns[y] || 0) / 100);
    cum *= (1 + ((annualReturns[yr] || 0) / 100) * (mo / 12));
    return Math.round(startVal * cum);
  }
  function buildBenchmarkMap(history, annualReturns, extraDates) {
    if (!history || history.length === 0) return {};
    const m = {};
    history.forEach(pt => { m[pt.d] = computeBenchmarkValue(pt.d, history, annualReturns); });
    if (Array.isArray(extraDates)) {
      extraDates.forEach(d => { if (!m[d]) m[d] = computeBenchmarkValue(d, history, annualReturns); });
    }
    return m;
  }

  // ── FIRE kalkulačka (pravidlo 4 %) ────────────────────────────────────
  // Iterativně hledá počet let, za který dosáhneš cílové částky (fireNum)
  //   fireNum = fireExpenses * 12 / (fireWithdrawal/100)
  // Vrací:
  //   0 — už jsi nad cílem
  //   N — za N let (max 80)
  //   null — není dosažitelné (žádný fireNum, nebo nad 80 let)
  function calcFireYears(opts) {
    const { totalValue, fireExpenses, fireWithdrawal, fireReturnPct,
            monthlyContrib, maxYears } = opts;
    const limit = maxYears || 80;
    const fireNum = fireExpenses > 0
      ? Math.round(fireExpenses * 12 / (fireWithdrawal / 100))
      : 0;
    if (fireNum <= 0) return null;
    if (totalValue >= fireNum) return 0;
    const annContrib = (monthlyContrib || 0) * 12;
    let v = totalValue;
    for (let y = 1; y <= limit; y++) {
      v = v * (1 + fireReturnPct / 100) + annContrib;
      if (v >= fireNum) return y;
    }
    return null;
  }

  // ── Inflace ČR (CPI) ─────────────────────────────────────────────────
  // Meziroční změna indexu spotřebitelských cen v % (ČSÚ, prosinec).
  // Zdroj: https://csu.gov.cz/inflace ... aktualizuj ručně při publikaci.
  const CZ_CPI_YEARLY = {
    2015: 0.3, 2016: 0.7, 2017: 2.5, 2018: 2.1, 2019: 2.8,
    2020: 3.2, 2021: 3.8, 2022: 15.1, 2023: 10.7, 2024: 2.4,
    2025: 2.5, 2026: 2.3 // 2026 = předběžný odhad, aktualizuj
  };

  // Kumulativní inflace mezi dvěma datumy ("YYYY-MM"), v %.
  // Počítá se složeně (compound): (1+r1)*(1+r2)*... - 1
  function cumulativeInflation(fromD, toD, cpiData) {
    const cpi = cpiData || CZ_CPI_YEARLY;
    const [fromY, fromM] = fromD.split("-").map(Number);
    const [toY, toM] = toD.split("-").map(Number);
    if (toY < fromY || (toY === fromY && toM < fromM)) return 0;
    let cum = 1;
    for (let y = fromY; y <= toY; y++) {
      const rate = (cpi[y] || 0) / 100;
      let frac;
      if (y === fromY && y === toY) frac = (toM - fromM) / 12;
      else if (y === fromY)          frac = (12 - fromM + 1) / 12;
      else if (y === toY)            frac = toM / 12;
      else                           frac = 1;
      cum *= Math.pow(1 + rate, frac);
    }
    return (cum - 1) * 100;
  }

  // Reálný výnos = (1+nominal)/(1+inflation) - 1  (Fisher equation)
  function realReturn(nominalPct, inflationPct) {
    return ((1 + nominalPct / 100) / (1 + inflationPct / 100) - 1) * 100;
  }

  // ── Export ────────────────────────────────────────────────────────────
  const api = {
    // parsing
    pf, pfn, parseFlt,
    // FX
    fxRate,
    // metriky
    maxDrawdown, portfolioVolatility, portfolioCAGR, sharpeRatio,
    calcWeightedAnnReturn, ytdGainPct,
    // benchmark
    computeBenchmarkValue, buildBenchmarkMap,
    // FIRE
    calcFireYears,
    // inflace
    CZ_CPI_YEARLY, cumulativeInflation, realReturn,
  };

  globalObj.InvestBookCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
