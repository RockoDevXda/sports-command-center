const GITHUB_USER = "RockoDevXda";
const NCAA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/ncaa-sim/main/daily_slate.json`;
const NBA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/nba-props-sim/main/nba_props_slate.json`;
const NBA_GAMES_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/nba-props-sim/main/nba_games_slate.json`;
const STORAGE_KEY = "simlab_tracked_bets_v1";
const WATCH_KEY = "simlab_watchlist_v1";
const BANKROLL_KEY = "simlab_bankroll_v1";
const BOOK_KEY = "simlab_preferred_book_v1";

const SPORTSBOOKS = {
  pp: {
    name: "PrizePicks",
    mode: "pickem",
    web: "https://app.prizepicks.com/",
    scheme: "prizepicks://"
  },
  ud: {
    name: "Underdog",
    mode: "pickem",
    web: "https://underdogfantasy.com/pick-em",
    scheme: "underdog://"
  },
  dk: {
    name: "DraftKings",
    mode: "book",
    web: "https://sportsbook.draftkings.com/",
    scheme: "dksb://"
  },
  pk6: {
    name: "DK Pick6",
    mode: "pickem",
    web: "https://pick6.draftkings.com/",
    scheme: "dkpick6://"
  },
  fd: {
    name: "FanDuel",
    mode: "book",
    web: "https://sportsbook.fanduel.com/",
    scheme: "fanduel://"
  },
  hr: {
    name: "Hard Rock Bet",
    mode: "book",
    web: "https://app.hardrock.bet/",
    scheme: "hardrockbet://"
  },
  mgm: {
    name: "BetMGM",
    mode: "book",
    web: "https://sports.betmgm.com/",
    scheme: "betmgm://"
  },
  sl: {
    name: "Sleeper",
    mode: "pickem",
    web: "https://sleeper.com/picks",
    scheme: "sleeper://"
  },
  betr: {
    name: "Betr Picks",
    mode: "pickem",
    web: "https://betr.app/",
    scheme: "betr://"
  }
};

let activeSport = "ev", evFilter = "ALL", subFilter = "ALL", nbaGamesFilter = "ALL", ncaaFilter = "ALL", visibleLimit = 25;
let ncaaGames = [], nbaGames = [], nbaPlayers = [], evBoard = [], topParlayLegs = [], slip = [], pickRegistry = {};
let activePropByPlayer = {};
let watchlist = loadJson(WATCH_KEY, []);
let trackedBets = loadJson(STORAGE_KEY, []);
let lastKellyDollar = 0;
let livePollTimer = null, deferredPrompt = null;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "inline-block";
});

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (e) { return fallback; }
}
function toggleWatch(playerId, e) {
  if (e) e.stopPropagation();
  const idStr = String(playerId);
  const idx = watchlist.indexOf(idStr);
  if (idx !== -1) watchlist.splice(idx, 1);
  else watchlist.push(idStr);
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)); } catch (err) {}
  render();
}
function persistBets() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(trackedBets)); } catch (e) {}
  const el = document.getElementById("betsCount");
  if (el) el.textContent = trackedBets.length;
}
function probToAmerican(pct) {
  const p = pct / 100;
  if (p <= 0 || p >= 1) return "N/A";
  return p >= 0.5 ? `${Math.round(-100 * p / (1 - p))}` : `+${Math.round(100 * (1 - p) / p)}`;
}
function americanToDecimal(am) {
  const n = parseFloat(am);
  if (isNaN(n) || n === 0 || (n > -100 && n < 100)) return 1.909;
  return n > 0 ? 1 + (n / 100) : 1 + (100 / Math.abs(n));
}
function calcEvAndQuarterKelly(probPct, decOdds = 1.909) {
  const p = probPct / 100.0;
  const q = 1.0 - p;
  const b = decOdds - 1.0;
  const evPct = +((p * b - q) * 100).toFixed(1);
  const rawKelly = b > 0 ? Math.max(0, (b * p - q) / b) : 0;
  const qKellyPct = +(rawKelly * 0.25 * 100).toFixed(1);
  return { evPct, qKellyPct };
}

function saveBankrollAndCalc() {
  const br = Math.max(1, parseFloat(document.getElementById("bankrollInput").value) || 500);
  try { localStorage.setItem(BANKROLL_KEY, String(br)); } catch (e) {}
  updateSlipUI(false);
  if (activeSport === "ev") render();
}

function savePreferredBook() {
  const bk = document.getElementById("sportsbookSelect").value;
  try { localStorage.setItem(BOOK_KEY, bk); } catch (e) {}
}

function applyKellyStake() {
  if (lastKellyDollar > 0) {
    document.getElementById("stakeInput").value = lastKellyDollar;
    updateSlipUI(false);
  }
}

function formatSlipForPlatform(mode) {
  const oddsVal = document.getElementById("bookOddsInput").value;
  const stakeVal = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const payoutVal = +(stakeVal * americanToDecimal(oddsVal)).toFixed(2);
  let comb = 1.0;
  slip.forEach(s => { comb *= (s.prob / 100); });
  const pct = +(comb * 100).toFixed(1);

  const lines = slip.map((s, i) => {
    let lbl = s.label;
    if (mode === "pickem") {
      lbl = lbl.replace(/\bO\s+(\d+(\.\d+)?)/g, "MORE $1").replace(/\bU\s+(\d+(\.\d+)?)/g, "LESS $1");
    }
    return `${i + 1}. ${lbl} (${s.prob}%)`;
  });

  return [
    `🎯 SimLab ${slip.length}-Leg Card (${pct}% Hit | Odds ${oddsVal} | $${stakeVal} → $${payoutVal}):`,
    ...lines,
    `📊 Terminal: https://rockodevxda.github.io/sports-command-center/`
  ].join("\n");
}

function copyTextSync(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

async function triggerShareOrCopy(text, btnEl, defaultLabel) {
  if (navigator.share) {
    try {
      await navigator.share({ title: "SimLab Bet Slip", text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  copyTextSync(text);
  if (btnEl) {
    btnEl.textContent = "✓ Copied!";
    setTimeout(() => { btnEl.textContent = defaultLabel; }, 1800);
  }
}

function shareCurrentSlip() {
  if (!slip.length) return;
  const text = formatSlipForPlatform("book");
  triggerShareOrCopy(text, document.getElementById("shareSlipBtn"), "📤 Share");
}

function shareSavedBet(betId) {
  const bet = trackedBets.find(b => b.id === betId);
  if (!bet) return;
  const statusTag = bet.status === "won" ? "🏆 WON" : (bet.status === "lost" ? "❌ LOST" : "⚡ LIVE");
  const lines = [
    `🎯 SimLab ${bet.legs.length}-Leg Card [${statusTag}]`,
    `💵 $${bet.stake} → $${bet.payout}`,
    ...bet.legs.map((l, i) => {
      const ic = l.status === "hit" ? "✅" : (l.status === "miss" ? "❌" : "⏳");
      return `${i + 1}. ${ic} ${l.label} (${l.liveScore})`;
    }),
    `📊 https://rockodevxda.github.io/sports-command-center/`
  ].join("\n");
  triggerShareOrCopy(lines, null, "📤");
}

function openSportsbookWithSlip() {
  if (!slip.length) return;
  const bkKey = document.getElementById("sportsbookSelect").value || "pp";
  const book = SPORTSBOOKS[bkKey] || SPORTSBOOKS.pp;
  const text = formatSlipForPlatform(book.mode);

  // Copy synchronously so the browser keeps the user tap gesture alive
  copyTextSync(text);

  const btn = document.getElementById("openBookBtn");
  btn.textContent = `✓ Copied! Launching ${book.name}...`;
  setTimeout(() => { btn.textContent = "🚀 Copy & Open App"; }, 2400);

  const ua = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);

  if (isMobile && book.scheme) {
    window.location.href = book.scheme;
    setTimeout(() => {
      if (!document.hidden) {
        window.location.href = book.web;
      }
    }, 1500);
  } else {
    window.open(book.web, "_blank", "noopener");
  }
}

function switchSport(sport) {
  activeSport = sport;
  visibleLimit = 25;
  document.getElementById("tabEv").className = sport === "ev" ? "tab active-ev" : "tab";
  document.getElementById("tabNba").className = sport === "nba" ? "tab active-nba" : "tab";
  document.getElementById("tabNbaGames").className = sport === "nbagames" ? "tab active-nbagames" : "tab";
  document.getElementById("tabNcaa").className = sport === "ncaa" ? "tab active-ncaa" : "tab";
  document.getElementById("tabBets").className = sport === "bets" ? "tab active-bets" : "tab";

  document.getElementById("marketControls").style.display = sport === "bets" ? "none" : "block";
  document.getElementById("betsControls").style.display = sport === "bets" ? "block" : "none";
  document.getElementById("evChips").style.display = sport === "ev" ? "flex" : "none";
  document.getElementById("nbaChips").style.display = sport === "nba" ? "flex" : "none";
  document.getElementById("nbaGamesChips").style.display = sport === "nbagames" ? "flex" : "none";
  document.getElementById("ncaaChips").style.display = sport === "ncaa" ? "flex" : "none";

  if (sport === "bets") { refreshTrackedBets(); startLivePoller(); }
  else { stopLivePoller(); render(); }
}

function startLivePoller() {
  stopLivePoller();
  livePollTimer = setInterval(() => {
    if (activeSport === "bets" && trackedBets.some(b => b.status !== "won" && b.status !== "lost")) refreshTrackedBets();
  }, 45000);
}
function stopLivePoller() { if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; } }
function handleManualRefresh() { if (activeSport === "bets") refreshTrackedBets(); else loadAllData(true); }
function setEvFilter(val, btn) { evFilter = val; visibleLimit = 25; document.querySelectorAll("#evChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setSubFilter(val, btn) { subFilter = val; visibleLimit = 25; document.querySelectorAll("#nbaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setNbaGamesFilter(val, btn) { nbaGamesFilter = val; visibleLimit = 25; document.querySelectorAll("#nbaGamesChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setNcaaFilter(val, btn) { ncaaFilter = val; visibleLimit = 25; document.querySelectorAll("#ncaaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function resetAndRender() { visibleLimit = 25; render(); }
function showMore() { visibleLimit += 25; render(); }
function registerPick(key, label, prob, meta) { pickRegistry[key] = { key, label, prob, meta }; }

function toggleSlipByKey(key) {
  const pick = pickRegistry[key];
  if (pick?.meta?.sport === "nba" && pick.meta.playerId) {
    activePropByPlayer[String(pick.meta.playerId)] = pick.meta.marketKey || pick.meta.stat;
  }
  const idx = slip.findIndex(s => s.key === key);
  if (idx !== -1) slip.splice(idx, 1);
  else if (pick) slip.push({ ...pick });
  updateSlipUI(true);
  render();
}
function clearSlip() { slip = []; updateSlipUI(true); render(); }
function loadTopParlay() { if (!topParlayLegs.length) return; slip = topParlayLegs.map(x => ({ ...x })); updateSlipUI(true); render(); }

function updateSlipUI(recalcDefaultOdds = true) {
  const has = slip.length > 0;
  document.body.classList.toggle("has-slip", has);
  if (!has) return;

  const oddsEl = document.getElementById("bookOddsInput");
  if (recalcDefaultOdds) {
    if (slip.length === 1) {
      oddsEl.value = slip[0].meta?.fairOdds && slip[0].meta.isAlt ? slip[0].meta.fairOdds : "-110";
    } else {
      let decParlay = 1.0;
      slip.forEach(s => {
        decParlay *= (s.meta?.isAlt && s.meta?.fairOdds) ? americanToDecimal(s.meta.fairOdds) : 1.909;
      });
      oddsEl.value = `+${Math.round((decParlay - 1) * 100)}`;
    }
  }

  let combProb = 1.0;
  slip.forEach(s => { combProb *= (s.prob / 100); });
  const q = 1.0 - combProb;
  const decOdds = americanToDecimal(oddsEl.value);
  const b = decOdds - 1.0;

  const bankroll = Math.max(1, parseFloat(document.getElementById("bankrollInput").value) || 500);
  const kellyMult = parseFloat(document.getElementById("kellyFracSelect").value) || 0.25;
  const rawKelly = b > 0 ? ((b * combProb - q) / b) : 0;
  const adjKellyPct = Math.max(0, rawKelly * kellyMult);
  const evPct = +((combProb * b - q) * 100).toFixed(1);

  lastKellyDollar = adjKellyPct > 0 ? Math.max(1, Math.round(bankroll * adjKellyPct)) : 0;
  const kBtn = document.getElementById("kellyApplyBtn");
  if (lastKellyDollar > 0) {
    kBtn.className = "kelly-pill";
    kBtn.textContent = `⚡ Kelly: $${lastKellyDollar} (${(adjKellyPct * 100).toFixed(1)}% | +${evPct}% EV)`;
  } else {
    kBtn.className = "kelly-pill no-edge";
    kBtn.textContent = `⚠️ NO +EV EDGE (${evPct}% EV)`;
  }

  const stake = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const estPayout = +(stake * decOdds).toFixed(2);
  document.getElementById("slipCount").textContent = slip.length;
  document.getElementById("slipPayout").textContent = `→ $${estPayout}`;
  document.getElementById("slipChips").innerHTML = slip.map(s => `<div class="s-chip">${escHtml(s.label)} (${s.prob}%) <span data-key="${escHtml(s.key)}" onclick="toggleSlipByKey(this.dataset.key)">×</span></div>`).join("");
}

function saveTrackedBet() {
  if (!slip.length) return;
  const stake = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const decOdds = americanToDecimal(document.getElementById("bookOddsInput").value);
  const payout = +(stake * decOdds).toFixed(2);
  const todayIso = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  trackedBets.unshift({
    id: "bet-" + Date.now(),
    createdAt: new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    dateStr: todayIso, stake, payout, status: "pending",
    legs: slip.map(s => ({ key: s.key, label: s.label, prob: s.prob, meta: s.meta || {}, status: "pending", liveScore: "Scheduled", currentVal: 0, targetVal: s.meta?.line || 0, clock: "" }))
  });
  persistBets();
  slip = [];
  updateSlipUI(true);
  switchSport("bets");
}

function deleteTrackedBet(betId) {
  trackedBets = trackedBets.filter(b => b.id !== betId);
  persistBets();
  renderBetsTab();
}

function buildEvBoard() {
  const items = [];

  for (const p of nbaPlayers) {
    const pidStr = String(p.id);
    for (const m of (p.all_props || [])) {
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(m.prob, 1.909);
      if (evPct >= 3.0) {
        const side = m.side || "O";
        const k = `nba-${pidStr}-${m.stat}-${side}-${m.line}`;
        const meta = {
          sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player,
          stat: m.stat, side, line: m.line, isAlt: false, fairOdds: m.fair_odds, marketKey: m.market
        };
        registerPick(k, `${p.player} ${m.market}`, m.prob, meta);
        items.push({
          key: k, category: "PROPS", badge: "🔥 NBA PROP",
          title: `${p.player} ${m.market}`,
          subtitle: `${p.team} vs ${p.opponent} • Sim: ${m.proj} • L10: ${m.hit_str || "N/A"}`,
          tags: p.tags || [], prob: m.prob, evPct, qKellyPct, dots: m.dots || "", gameId: p.game_id
        });
      }
    }
  }

  for (const g of nbaGames) {
    const awayLbl = g.away_abbr || g.away_short;
    const homeLbl = g.home_abbr || g.home_short;
    if (g.has_line) {
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.spread_cover_pct, 1.909);
      if (evPct >= 3.0) {
        const k = `nbagame-${g.id}-ats`;
        const meta = { sport: "nbagame", betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick };
        registerPick(k, g.spread_pick, g.spread_cover_pct, meta);
        items.push({
          key: k, category: "NBAGAMES", badge: "🏀 NBA SPREAD",
          title: g.spread_pick,
          subtitle: `${awayLbl} (${g.away_proj}) @ ${homeLbl} (${g.home_proj}) • +${g.edge_pts} pt edge`,
          tags: g.move_badges || [], prob: g.spread_cover_pct, evPct, qKellyPct, dots: "", gameId: g.id
        });
      }
    }
    if (g.has_total) {
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.total_cover_pct, 1.909);
      if (evPct >= 3.0) {
        const k = `nbagame-${g.id}-tot`;
        const meta = { sport: "nbagame", betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under };
        registerPick(k, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, meta);
        items.push({
          key: k, category: "NBAGAMES", badge: "🏀 NBA TOTAL",
          title: `${awayLbl}/${homeLbl} ${g.total_pick}`,
          subtitle: `Sim Total: ${g.total_proj} vs O/U ${g.over_under} (+${g.total_edge_pts} edge)`,
          tags: g.move_badges || [], prob: g.total_cover_pct, evPct, qKellyPct, dots: "", gameId: g.id
        });
      }
    }
  }

  for (const g of ncaaGames) {
    if (g.verified_d1 === false) continue;
    const awayLbl = g.away_short || g.away_team;
    const homeLbl = g.home_short || g.home_team;
    if (g.has_line && Math.abs(g.home_spread || 0) <= 24.5) {
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.spread_cover_pct, 1.909);
      if (evPct >= 3.0) {
        const k = `ncaa-${g.id}-ats`;
        const meta = { sport: "ncaa", betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick };
        registerPick(k, g.spread_pick, g.spread_cover_pct, meta);
        items.push({
          key: k, category: "NCAA", badge: "🏀 NCAA ATS",
          title: g.spread_pick,
          subtitle: `${awayLbl} (${g.away_proj}) @ ${homeLbl} (${g.home_proj}) • +${g.edge_pts} pt edge`,
          tags: g.move_badges || [], prob: g.spread_cover_pct, evPct, qKellyPct, dots: "", gameId: g.id
        });
      }
    }
    if (g.has_total && (g.total_edge_pts || 0) <= 14.0) {
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.total_cover_pct, 1.909);
      if (evPct >= 3.0) {
        const k = `ncaa-${g.id}-tot`;
        const meta = { sport: "ncaa", betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under };
        registerPick(k, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, meta);
        items.push({
          key: k, category: "NCAA", badge: "🏀 NCAA TOTAL",
          title: `${awayLbl}/${homeLbl} ${g.total_pick}`,
          subtitle: `Sim Total: ${g.total_proj} vs O/U ${g.over_under} (+${g.total_edge_pts} edge)`,
          tags: g.move_badges || [], prob: g.total_cover_pct, evPct, qKellyPct, dots: "", gameId: g.id
        });
      }
    }
  }

  items.sort((a, b) => b.evPct - a.evPct);
  evBoard = items;
  document.getElementById("evCount").textContent = evBoard.length;
}

function buildTopParlay() {
  const legs = [], usedGames = new Set();
  for (const item of evBoard) {
    if (legs.length >= 4) break;
    if (!usedGames.has(item.gameId)) {
      legs.push({ key: item.key, label: item.title, prob: item.prob, meta: pickRegistry[item.key]?.meta || {} });
      usedGames.add(item.gameId);
    }
  }
  topParlayLegs = legs;
  const banner = document.getElementById("heroParlay");
  if (legs.length < 2) { banner.style.display = "none"; return; }
  let c = 1.0;
  legs.forEach(l => { c *= (l.prob / 100); });
  const pct = +(c * 100).toFixed(1);
  banner.style.display = "flex";
  document.getElementById("heroParlaySub").textContent = `${legs.map(l => l.label).join(" • ")} (${pct}% | ${probToAmerican(pct)})`;
}

async function refreshTrackedBets() {
  const statusEl = document.getElementById("livePollStatus");
  if (statusEl) statusEl.textContent = "Fetching live ESPN scores & box scores...";
  const datesToFetch = new Set([new Date().toISOString().slice(0, 10).replace(/-/g, "")]);
  trackedBets.forEach(b => { if (b.dateStr) datesToFetch.add(b.dateStr); });
  const nbaEvents = {}, ncaaEvents = {}, nbaBoxCache = {};
  try {
    for (const d of datesToFetch) {
      const [nbaRes, ncaaRes] = await Promise.allSettled([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}`),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d}&groups=50&limit=200`)
      ]);
      if (nbaRes.status === "fulfilled" && nbaRes.value.ok) ((await nbaRes.value.json()).events || []).forEach(ev => { nbaEvents[String(ev.id)] = ev; });
      if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) ((await ncaaRes.value.json()).events || []).forEach(ev => { ncaaEvents[String(ev.id)] = ev; });
    }
    for (const bet of trackedBets) {
      for (const leg of bet.legs) {
        const m = leg.meta || {}, gid = String(m.gameId || "");
        if (m.sport === "nba" && gid && nbaEvents[gid]) {
          const ev = nbaEvents[gid], state = ev.status?.type?.state || "pre", detail = ev.status?.type?.shortDetail || "";
          const comp = ev.competitions?.[0], away = comp?.competitors?.find(c => c.homeAway === "away"), home = comp?.competitors?.find(c => c.homeAway === "home");
          leg.clock = `${away?.team?.abbreviation || ""} ${away?.score || 0} - ${home?.team?.abbreviation || ""} ${home?.score || 0} • ${detail}`;
          const isUnder = m.side === "U";
          if (state === "pre") { leg.status = "pending"; leg.liveScore = `0 / ${m.line} ${m.stat}`; }
          else {
            if (!nbaBoxCache[gid]) { try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gid}`); if (r.ok) nbaBoxCache[gid] = await r.json(); } catch (e) {} }
            const val = extractNbaPlayerStat(nbaBoxCache[gid], String(m.playerId || ""), m.playerName, m.stat);
            leg.currentVal = val; leg.targetVal = m.line; leg.liveScore = `${val} / ${m.line} ${m.stat}`;
            if (isUnder) {
              if (val > m.line) leg.status = "miss";
              else leg.status = state === "post" ? "hit" : "live";
            } else {
              leg.status = state === "post" ? (val > m.line ? "hit" : "miss") : (val > m.line ? "hit" : "live");
            }
          }
        } else if ((m.sport === "ncaa" || m.sport === "nbagame") && gid) {
          const ev = m.sport === "nbagame" ? nbaEvents[gid] : ncaaEvents[gid];
          if (!ev) continue;
          const state = ev.status?.type?.state || "pre", detail = ev.status?.type?.shortDetail || "";
          const comp = ev.competitions?.[0], away = comp?.competitors?.find(c => c.homeAway === "away"), home = comp?.competitors?.find(c => c.homeAway === "home");
          const aS = parseFloat(away?.score || 0), hS = parseFloat(home?.score || 0);
          const sStr = `${m.awayShort || away?.team?.abbreviation} ${aS} - ${m.homeShort || home?.team?.abbreviation} ${hS}`;
          leg.clock = detail;
          if (state === "pre") { leg.status = "pending"; leg.liveScore = "Tipoff scheduled"; }
          else if (m.betType === "total") {
            const comb = aS + hS; leg.currentVal = comb; leg.targetVal = m.line; leg.liveScore = `${sStr} (Tot: ${comb} vs ${m.line})`;
            leg.status = state === "post" ? ((m.side === "O" ? comb > m.line : comb < m.line) ? "hit" : "miss") : "live";
          } else if (m.betType === "ml") {
            leg.liveScore = sStr;
            const lead = (m.favoredTeam === m.homeShort) ? hS > aS : aS > hS;
            leg.status = state === "post" ? (lead ? "hit" : "miss") : "live";
          } else if (m.betType === "ats") {
            leg.liveScore = sStr;
            const parts = (m.pickText || "").split(" "), ln = parseFloat(parts[parts.length - 1]) || 0, tm = parts.slice(0, -1).join(" ");
            const marg = (tm === m.homeShort) ? (hS + ln - aS) : (aS + ln - hS);
            leg.status = state === "post" ? (marg > 0 ? "hit" : "miss") : "live";
          }
        }
      }
      if (bet.legs.some(l => l.status === "miss")) bet.status = "lost";
      else if (bet.legs.length > 0 && bet.legs.every(l => l.status === "hit")) bet.status = "won";
      else if (bet.legs.some(l => l.status === "live" || l.status === "hit")) bet.status = "live";
      else bet.status = "pending";
    }
    persistBets();
    if (statusEl) statusEl.textContent = `Live ESPN synced at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (e) { if (statusEl) statusEl.textContent = "Live check paused (offline)"; }
  if (activeSport === "bets") renderBetsTab();
}

function extractNbaPlayerStat(sum, pid, pname, stat) {
  if (!sum?.boxscore?.players) return 0;
  for (const tb of sum.boxscore.players) {
    const sg = tb.statistics?.[0];
    if (!sg) continue;
    const names = (sg.names || []).map(n => n.toUpperCase());
    const iP = names.indexOf("PTS"), iR = names.indexOf("REB"), iA = names.indexOf("AST"), i3 = names.findIndex(n => n === "3PT" || n === "3PM");
    for (const ae of (sg.athletes || [])) {
      if ((pid && String(ae.athlete?.id) === pid) || (pname && ae.athlete?.displayName?.toLowerCase() === pname.toLowerCase())) {
        const s = ae.stats || [], pts = parseFloat(s[iP]) || 0, reb = parseFloat(s[iR]) || 0, ast = parseFloat(s[iA]) || 0;
        const tpm = (i3 >= 0 && s[i3]) ? (parseFloat(String(s[i3]).split("-")[0]) || 0) : 0;
        if (stat === "PTS") return pts; if (stat === "REB") return reb; if (stat === "AST") return ast; if (stat === "3PM") return tpm; if (stat === "PRA") return pts + reb + ast;
      }
    }
  }
  return 0;
}

function renderDots(dotsStr) {
  if (!dotsStr) return "";
  return `<div class="dots-wrap">${dotsStr.split("").map(d => `<span class="g-dot ${d === "1" ? "hit" : ""}"></span>`).join("")}</div>`;
}

function renderBetsTab() {
  const listEl = document.getElementById("cardsList");
  document.getElementById("loadMoreBtn").style.display = "none";
  let activeRisk = 0, netPL = 0, wins = 0, losses = 0;
  trackedBets.forEach(b => {
    if (b.status === "won") { wins++; netPL += (b.payout - b.stake); }
    else if (b.status === "lost") { losses++; netPL -= b.stake; }
    else activeRisk += b.stake;
  });
  document.getElementById("statActiveRisk").textContent = `$${activeRisk.toFixed(0)}`;
  const plEl = document.getElementById("statNetPL");
  plEl.textContent = `${netPL >= 0 ? "+" : "-"}$${Math.abs(netPL).toFixed(0)}`;
  plEl.style.color = netPL >= 0 ? "var(--emerald)" : "var(--danger)";
  document.getElementById("statRecord").textContent = `${wins}-${losses}`;

  if (!trackedBets.length) {
    listEl.innerHTML = `<div class="card" style="grid-column:1/-1; text-align:center; padding:24px 16px;"><div style="font-size:0.95rem; font-weight:800; margin-bottom:4px;">No Tracked Bets Yet</div><div style="font-size:0.76rem; color:var(--sub);">Tap any +EV edge, apply your Kelly stake in the bottom drawer, and tap <strong>📌 Track</strong> to sweat live stats here.</div></div>`;
    return;
  }
  listEl.innerHTML = trackedBets.map(bet => {
    const badgeMap = { won: `<span class="status-pill won">🏆 WON +$${(bet.payout - bet.stake).toFixed(0)}</span>`, lost: `<span class="status-pill lost">❌ LOST -$${bet.stake}</span>`, live: `<span class="status-pill live">⚡ LIVE SWEAT</span>`, pending: `<span class="status-pill pending">⏳ UPCOMING</span>` };
    const legsHtml = bet.legs.map(leg => {
      const icon = leg.status === "hit" ? "✅" : (leg.status === "miss" ? "❌" : (leg.status === "live" ? "⚡" : "⏳"));
      const pct = leg.targetVal > 0 ? Math.min(100, Math.round((leg.currentVal / leg.targetVal) * 100)) : 0;
      const showBar = leg.meta?.sport === "nba" || leg.meta?.betType === "total";
      return `<div class="leg-row"><div class="leg-top"><span>${icon} ${escHtml(leg.label)}</span><span style="color:var(--emerald); font-size:0.7rem;">${leg.prob}%</span></div><div class="leg-sub"><span>${escHtml(leg.liveScore)}</span><span>${escHtml(leg.clock || "")}</span></div>${showBar ? `<div class="prog-track"><div class="prog-fill ${leg.status}" style="width:${pct}%"></div></div>` : ""}</div>`;
    }).join("");
    return `<article class="bet-card ${bet.status}">
      <div class="c-head">
        <div>
          <div class="c-name">${bet.legs.length}-Leg ${bet.legs.length === 1 ? "Straight" : "Parlay"} • $${bet.stake} → $${bet.payout}</div>
          <div class="c-meta">Placed ${escHtml(bet.createdAt)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:5px;">
          ${badgeMap[bet.status] || badgeMap.pending}
          <button class="btn-sm" style="padding:2px 6px; font-size:0.68rem; border-color:var(--cyan); color:var(--cyan);" data-id="${escHtml(bet.id)}" onclick="shareSavedBet(this.dataset.id)">📤</button>
          <button class="btn-sm" style="padding:2px 6px; font-size:0.68rem;" data-id="${escHtml(bet.id)}" onclick="deleteTrackedBet(this.dataset.id)">🗑️</button>
        </div>
      </div>
      ${legsHtml}
    </article>`;
  }).join("");
}

function renderGameCards(gamesList, prefix, sportTag, activeSubFilter, q, filter, listEl, moreBtn) {
  const sorted = [...gamesList].sort((a, b) => {
    if (activeSubFilter === "TOTALS") return (b.total_cover_pct || 0) - (a.total_cover_pct || 0);
    if (activeSubFilter === "SPREADS") return (b.spread_cover_pct || 0) - (a.spread_cover_pct || 0);
    if (activeSubFilter === "MOVES") return (Math.abs(b.spread_move || 0) + Math.abs(b.total_move || 0)) - (Math.abs(a.spread_move || 0) + Math.abs(a.total_move || 0));
    if (activeSubFilter === "B2B") return (b.has_b2b ? 1 : 0) - (a.has_b2b ? 1 : 0);
    return Math.max(b.spread_cover_pct || 0, b.total_cover_pct || 0) - Math.max(a.spread_cover_pct || 0, a.total_cover_pct || 0);
  });

  const filtered = sorted.filter(g => {
    const awayLbl = g.away_abbr || g.away_short || "";
    const homeLbl = g.home_abbr || g.home_short || "";
    if (q && !(g.away_team || "").toLowerCase().includes(q) && !(g.home_team || "").toLowerCase().includes(q) && !awayLbl.toLowerCase().includes(q) && !homeLbl.toLowerCase().includes(q)) return false;
    if (activeSubFilter === "B2B" && !g.has_b2b) return false;
    if (activeSubFilter === "MOVES" && !g.has_move) return false;
    if (activeSubFilter === "TOTALS" && !g.has_total) return false;
    if (activeSubFilter === "SPREADS" && !g.has_line) return false;
    if (filter === "edge" && (g.spread_cover_pct || 0) < 57 && (g.total_cover_pct || 0) < 57) return false;
    if (filter === "slip" && !slip.some(s => s.key.startsWith(`${prefix}-${g.id}`))) return false;
    return true;
  });

  const slice = filtered.slice(0, visibleLimit);
  moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
  moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;

  listEl.innerHTML = slice.map(g => {
    const awayLbl = g.away_abbr || g.away_short;
    const homeLbl = g.home_abbr || g.home_short;
    const atsKey = `${prefix}-${g.id}-ats`, totKey = `${prefix}-${g.id}-tot`, mlKey = `${prefix}-${g.id}-ml`;
    if (g.has_line) registerPick(atsKey, g.spread_pick, g.spread_cover_pct, { sport: sportTag, betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick });
    if (g.has_total) registerPick(totKey, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, { sport: sportTag, betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under });
    registerPick(mlKey, `${g.favored_team} ML`, g.favored_prob, { sport: sportTag, betType: "ml", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, favoredTeam: g.favored_team });

    const atsSel = slip.some(s => s.key === atsKey), totSel = slip.some(s => s.key === totKey), mlSel = slip.some(s => s.key === mlKey);
    const simTotal = g.total_proj || +(g.away_proj + g.home_proj).toFixed(1);
    const moveTags = (g.move_badges || []).map(b => `<span class="s-tag ${b.includes("B2B") ? "" : "cyan"}">${escHtml(b)}</span>`).join("");

    return `<article class="card ${(atsSel || totSel || mlSel) ? "in-slip" : ""}">
      <div class="c-head">
        <div>
          <div class="c-name">${escHtml(awayLbl)} @ ${escHtml(homeLbl)}</div>
          <div class="c-meta">${escHtml(g.tipoff || "")} • ${escHtml(g.market_line || "PK")}${g.has_total ? ` • O/U ${g.over_under}` : ""}${g.exp_pace ? ` • Pace ${g.exp_pace}` : ""}</div>
          ${moveTags ? `<div class="sharp-tags">${moveTags}</div>` : ""}
        </div>
        ${g.has_line ? `<span class="edge-tag">+${g.edge_pts} ATS</span>` : ""}
      </div>
      ${g.h2h_summary ? `<div class="h2h-bar">📜 ${escHtml(g.h2h_summary)}</div>` : ""}
      <div class="ncaa-scores">
        <span><strong>${escHtml(awayLbl)}</strong> ${g.away_proj} • <strong>${escHtml(homeLbl)}</strong> ${g.home_proj}</span>
        <span style="color:var(--cyan); font-weight:700;">Tot: ${simTotal}</span>
      </div>
      <div class="ncaa-grid">
        ${g.has_line ? `<button class="p-btn ${atsSel ? "selected" : ""} ${g.spread_cover_pct >= 58 ? "hot" : ""}" data-key="${escHtml(atsKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.spread_pick)}</span><span class="prob-val">${g.spread_cover_pct}%</span></button>` : `<button class="p-btn" disabled><span>No Line</span></button>`}
        ${g.has_total ? `<button class="p-btn ${totSel ? "selected" : ""} ${g.total_cover_pct >= 58 ? "hot" : ""}" data-key="${escHtml(totKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.total_pick)}</span><span class="prob-val">${g.total_cover_pct}%</span></button>` : `<button class="p-btn" disabled><span>No O/U</span></button>`}
        <button class="p-btn ${mlSel ? "selected" : ""} ${g.favored_prob >= 70 ? "hot" : ""}" data-key="${escHtml(mlKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.favored_team)} ML</span><span class="prob-val">${g.favored_prob}%</span></button>
      </div>
    </article>`;
  }).join("");
}

function render() {
  if (activeSport === "bets") { renderBetsTab(); return; }
  const listEl = document.getElementById("cardsList"), moreBtn = document.getElementById("loadMoreBtn");
  const q = document.getElementById("searchInput").value.toLowerCase().trim(), filter = document.getElementById("filterSelect").value;

  if (activeSport === "ev") {
    const bankroll = Math.max(1, parseFloat(document.getElementById("bankrollInput")?.value) || 500);
    const filtered = evBoard.filter(item => {
      if (q && !item.title.toLowerCase().includes(q) && !item.subtitle.toLowerCase().includes(q)) return false;
      if (evFilter === "MAX" && item.evPct < 15.0) return false;
      if (evFilter === "PROPS" && item.category !== "PROPS") return false;
      if (evFilter === "NBAGAMES" && item.category !== "NBAGAMES") return false;
      if (evFilter === "NCAA" && item.category !== "NCAA") return false;
      if (filter === "edge" && item.evPct < 12.0) return false;
      if (filter === "slip" && !slip.some(s => s.key === item.key)) return false;
      return true;
    });

    const slice = filtered.slice(0, visibleLimit);
    moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
    moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;

    listEl.innerHTML = slice.map((item, idx) => {
      const sel = slip.some(s => s.key === item.key);
      const kellyDollar = Math.max(1, Math.round(bankroll * (item.qKellyPct / 100)));
      const tagsHtml = (item.tags || []).slice(0, 3).map(t => `<span class="s-tag ${t.includes("DEF") || t.includes("B2B") || t.includes("UNDER") ? "cyan" : ""}">${escHtml(t)}</span>`).join("");

      return `<article class="card ${sel ? "in-slip" : ""}">
        <div class="c-head">
          <div>
            <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px;">
              <span class="s-tag gold">#${idx + 1} ${escHtml(item.badge)}</span>
            </div>
            <div class="c-name">${escHtml(item.title)}</div>
            <div class="c-meta">${escHtml(item.subtitle)}</div>
            ${tagsHtml ? `<div class="sharp-tags">${tagsHtml}</div>` : ""}
          </div>
          <button class="btn-quick-parlay" style="${sel ? "background:var(--cyan); color:#03131f;" : ""}" data-key="${escHtml(item.key)}" onclick="toggleSlipByKey(this.dataset.key)">
            ${sel ? "✓ In Slip" : "+ Add"}
          </button>
        </div>
        ${item.dots ? `<div class="streak-bar"><span>Last-10 Hit Form</span>${renderDots(item.dots)}</div>` : ""}
        <div class="ev-metrics">
          <div><div class="ev-m-lbl">Sim Win %</div><div class="ev-m-val" style="color:#fff;">${item.prob}%</div></div>
          <div><div class="ev-m-lbl">+EV (-110)</div><div class="ev-m-val" style="color:var(--emerald);">+${item.evPct}%</div></div>
          <div><div class="ev-m-lbl">1/4 Kelly</div><div class="ev-m-val" style="color:var(--cyan);">$${kellyDollar} (${item.qKellyPct}%)</div></div>
        </div>
      </article>`;
    }).join("");
    return;
  }

  if (activeSport === "nba") {
    const sorted = [...nbaPlayers].sort((a, b) => {
      if (subFilter === "ALTS") return ((b.alt_props?.[0]?.prob || 0) - (a.alt_props?.[0]?.prob || 0));
      if (["PTS", "REB", "AST", "PRA"].includes(subFilter)) return (b.all_props?.find(x => x.stat === subFilter)?.prob || 0) - (a.all_props?.find(x => x.stat === subFilter)?.prob || 0);
      return (b.best_prop?.prob || 0) - (a.best_prop?.prob || 0);
    });
    const filtered = sorted.filter(p => {
      if (q && !p.player.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q) && !p.opponent.toLowerCase().includes(q)) return false;
      if (subFilter === "WATCH" && !watchlist.includes(String(p.id))) return false;
      if (subFilter === "UNDERS" && !p.has_under && !(p.all_props || []).some(x => x.side === "U")) return false;
      if (subFilter === "ALTS" && (!p.alt_props || p.alt_props.length === 0)) return false;
      if (subFilter === "USG" && (p.usage_bump_pct || 0) <= 0) return false;
      if (subFilter === "HOT" && (p.best_prop?.hits || 0) < 8) return false;
      if (filter === "edge" && (p.best_prop?.prob || 0) < 58 && (p.usage_bump_pct || 0) <= 0) return false;
      if (filter === "slip" && !slip.some(s => s.key.startsWith(`nba-${p.id}`))) return false;
      return true;
    });
    const slice = filtered.slice(0, visibleLimit);
    moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
    moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
    listEl.innerHTML = slice.map(p => {
      const pidStr = String(p.id);
      const isWatched = watchlist.includes(pidStr);
      const inSlip = slip.some(s => s.key.startsWith(`nba-${pidStr}`));

      let pool = p.all_props || [];
      if (subFilter === "ALTS") pool = p.alt_props || [];
      else if (subFilter === "UNDERS") pool = (p.all_props || []).filter(m => m.side === "U");
      else if (["PTS", "REB", "AST", "PRA"].includes(subFilter)) pool = (p.all_props || []).filter(m => m.stat === subFilter);

      const selectedKey = activePropByPlayer[pidStr];
      const focusProp = (selectedKey && [...(p.all_props || []), ...(p.alt_props || [])].find(x => (x.market || x.stat) === selectedKey || x.stat === selectedKey)) || pool[0] || p.best_prop || {};
      const tagsHtml = (p.tags || []).map(t => `<span class="s-tag ${t.includes("DEF") || t.includes("B2B") || t.includes("UNDER") ? "cyan" : ""}">${escHtml(t)}</span>`).join("");

      return `<article class="card ${inSlip ? "in-slip" : ""}">
        <div class="c-head">
          <div>
            <div class="c-name">${escHtml(p.player)} <span class="c-meta">• ${escHtml(p.team)} vs ${escHtml(p.opponent)} (${p.avg_min}m)</span></div>
            ${tagsHtml ? `<div class="sharp-tags">${tagsHtml}</div>` : ""}
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="c-meta">O/U ${p.game_total}</span>
            <button class="btn-sm" style="padding:2px 6px; font-size:0.75rem; border-color:${isWatched ? "var(--orange)" : "var(--border)"}; color:${isWatched ? "var(--orange)" : "var(--muted)"};" onclick="toggleWatch('${escHtml(pidStr)}', event)">${isWatched ? "★" : "☆"}</button>
          </div>
        </div>
        ${focusProp.dots ? `<div class="streak-bar"><span><strong>${escHtml(focusProp.market)}</strong> Recent Form: <strong style="color:var(--emerald);">${escHtml(focusProp.hit_str)}</strong></span>${renderDots(focusProp.dots)}</div>` : ""}
        <div class="prop-grid" style="${pool.length === 1 ? "grid-template-columns:1fr;" : ""}">
          ${pool.map(m => {
            const side = m.side || "O";
            const isAlt = Boolean(m.is_alt || subFilter === "ALTS");
            const k = `nba-${pidStr}-${m.stat}-${side}-${m.line}`;
            registerPick(k, `${p.player} ${m.market}`, m.prob, {
              sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player,
              stat: m.stat, side, line: m.line, isAlt, fairOdds: m.fair_odds, marketKey: m.market
            });
            const sel = slip.some(s => s.key === k), hot = m.prob >= 60;
            return `<button class="p-btn ${sel ? "selected" : ""} ${hot ? "hot" : ""} ${isAlt ? "alt-btn" : ""}" data-key="${escHtml(k)}" onclick="toggleSlipByKey(this.dataset.key)">
              <div>
                <span>${escHtml(m.market)}</span>
                <span class="sim-hint">Sim: ${m.proj}${isAlt && m.fair_odds ? ` • ${m.fair_odds}` : ""}</span>
              </div>
              <div class="prob-val">
                <span>${m.prob}%</span>
                ${m.hit_str ? `<span class="hit-mini">${escHtml(m.hit_str)}</span>` : ""}
              </div>
            </button>`;
          }).join("")}
        </div>
      </article>`;
    }).join("");
  } else if (activeSport === "nbagames") {
    renderGameCards(nbaGames, "nbagame", "nbagame", nbaGamesFilter, q, filter, listEl, moreBtn);
  } else {
    renderGameCards(ncaaGames, "ncaa", "ncaa", ncaaFilter, q, filter, listEl, moreBtn);
  }
}

async function loadAllData(force = false) {
  const savedBr = localStorage.getItem(BANKROLL_KEY);
  if (savedBr && document.getElementById("bankrollInput")) document.getElementById("bankrollInput").value = savedBr;

  const savedBk = localStorage.getItem(BOOK_KEY);
  if (savedBk && document.getElementById("sportsbookSelect")) document.getElementById("sportsbookSelect").value = savedBk;

  const bust = force ? `?t=${Date.now()}` : `?t=${Math.floor(Date.now() / 60000)}`;
  document.getElementById("syncText").textContent = "Syncing...";
  document.getElementById("betsCount").textContent = trackedBets.length;
  try {
    const [ncaaRes, nbaRes, nbaGamesRes] = await Promise.allSettled([
      fetch(NCAA_JSON_URL + bust),
      fetch(NBA_JSON_URL + bust),
      fetch(NBA_GAMES_JSON_URL + bust)
    ]);
    if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) ncaaGames = await ncaaRes.value.json();
    if (nbaRes.status === "fulfilled" && nbaRes.value.ok) nbaPlayers = await nbaRes.value.json();
    if (nbaGamesRes.status === "fulfilled" && nbaGamesRes.value.ok) nbaGames = await nbaGamesRes.value.json();

    document.getElementById("ncaaCount").textContent = ncaaGames.length;
    document.getElementById("nbaCount").textContent = nbaPlayers.length;
    document.getElementById("nbaGamesCount").textContent = nbaGames.length;
    const ts = nbaGames[0]?.generated_at || ncaaGames[0]?.generated_at || nbaPlayers[0]?.generated_at || "Live";
    document.getElementById("syncText").textContent = `Synced • ${ts}`;

    buildEvBoard();
    buildTopParlay();
    render();
  } catch (e) {
    document.getElementById("syncText").textContent = "Offline cache";
  }
}

loadAllData();
