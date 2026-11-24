const GITHUB_USER = "RockoDevXda";
const NCAA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/ncaa-sim/main/daily_slate.json`;
const NBA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/nba-props-sim/main/nba_props_slate.json`;
const NBA_GAMES_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/nba-props-sim/main/nba_games_slate.json`;
const STORAGE_KEY = "simlab_tracked_bets_v1";
const WATCH_KEY = "simlab_watchlist_v1";
const BANKROLL_KEY = "simlab_bankroll_v1";
const BOOK_KEY = "simlab_preferred_book_v1";

const SPORTSBOOKS = {
  pp: { name: "PrizePicks", mode: "pickem", web: "https://app.prizepicks.com/", scheme: "prizepicks://" },
  ud: { name: "Underdog", mode: "pickem", web: "https://underdogfantasy.com/pick-em", scheme: "underdog://" },
  dk: { name: "DraftKings", mode: "book", web: "https://sportsbook.draftkings.com/", scheme: "dksb://" },
  pk6: { name: "DK Pick6", mode: "pickem", web: "https://pick6.draftkings.com/", scheme: "dkpick6://" },
  fd: { name: "FanDuel", mode: "book", web: "https://sportsbook.fanduel.com/", scheme: "fanduel://" },
  hr: { name: "Hard Rock Bet", mode: "book", web: "https://app.hardrock.bet/", scheme: "hardrockbet://" },
  mgm: { name: "BetMGM", mode: "book", web: "https://sports.betmgm.com/", scheme: "betmgm://" },
  sl: { name: "Sleeper", mode: "pickem", web: "https://sleeper.com/picks", scheme: "sleeper://" },
  betr: { name: "Betr Picks", mode: "pickem", web: "https://betr.app/", scheme: "betr://" }
};

let activeHub = "ev"; // "ev" | "nba" | "ncaa" | "bets"
let nbaSubView = "props"; // "props" | "games" | "recap"
let ncaaSubView = "games"; // "games" | "recap"
let evFilter = "ALL", subFilter = "ALL", nbaGamesFilter = "ALL", ncaaFilter = "ALL", recapOutcomeFilter = "ALL", visibleLimit = 25;

let ncaaGames = [], nbaGames = [], nbaPlayers = [], evBoard = [], recapItems = [], topParlayLegs = [], slip = [], pickRegistry = {};
let activePropByPlayer = {};
let openHedgeMap = {};
let hedgeOddsMap = {};
let watchlist = loadJson(WATCH_KEY, []);
let trackedBets = loadJson(STORAGE_KEY, []);
let lastKellyDollar = 0;
let livePollTimer = null, deferredPrompt = null;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "OPEN_BETS_TAB") switchHub("bets");
  });
}
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.getElementById("installBtn");
  if (btn) btn.style.display = "inline-block";
});

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(val);
}
function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (e) { return fallback; }
}
function fmtAmerican(odds) {
  const n = parseInt(odds, 10);
  if (isNaN(n)) return "-110";
  return n > 0 ? `+${n}` : `${n}`;
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
  setText("betsCount", trackedBets.length);
  setText("bBetsCount", trackedBets.length);
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
  const p = (parseFloat(probPct) || 0) / 100.0;
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
  if (activeHub === "ev") render();
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

function toggleHedgeDrawer(betId) {
  openHedgeMap[betId] = !openHedgeMap[betId];
  if (!hedgeOddsMap[betId]) hedgeOddsMap[betId] = "+140";
  renderBetsTab();
}

function updateHedgeCalc(betId, rawOdds) {
  hedgeOddsMap[betId] = rawOdds;
  const bet = trackedBets.find(b => b.id === betId);
  if (!bet) return;
  const metrics = computeHedgeNumbers(bet.stake, bet.payout, rawOdds);
  const stakeEl = document.getElementById(`h-stake-${betId}`);
  const profEl = document.getElementById(`h-prof-${betId}`);
  const freeEl = document.getElementById(`h-free-${betId}`);
  if (stakeEl) stakeEl.textContent = `$${metrics.equalHedgeStake.toFixed(2)}`;
  if (profEl) {
    profEl.textContent = `${metrics.lockedProfit >= 0 ? "+" : "-"}$${Math.abs(metrics.lockedProfit).toFixed(2)}`;
    profEl.style.color = metrics.lockedProfit >= 0 ? "var(--emerald)" : "var(--danger)";
  }
  if (freeEl) freeEl.textContent = `$${metrics.freerollStake.toFixed(2)}`;
}

function computeHedgeNumbers(origStake, origPayout, hedgeAmerican) {
  const dec = americanToDecimal(hedgeAmerican);
  const equalHedgeStake = dec > 0 ? (origPayout / dec) : 0;
  const lockedProfit = origPayout - origStake - equalHedgeStake;
  const freerollStake = dec > 1 ? (origStake / (dec - 1)) : 0;
  return { equalHedgeStake, lockedProfit, freerollStake };
}

async function togglePinNotification(betId) {
  const bet = trackedBets.find(b => b.id === betId);
  if (!bet) return;

  if (bet.pinned) {
    bet.pinned = false;
    persistBets();
    await closePinnedNotification(bet.id);
    if (activeHub !== "bets") stopLivePoller();
    renderBetsTab();
    return;
  }

  if (!("Notification" in window)) {
    alert("Notifications are not supported in this browser.");
    return;
  }

  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("Enable notifications in your browser/app settings to pin live tickets.");
    return;
  }

  bet.pinned = true;
  bet.lastNotifSig = "";
  bet.lastLegSig = bet.legs.map(l => l.status).join(",");
  persistBets();
  startLivePoller();
  await refreshTrackedBets();
  await pushPinnedNotification(bet, true);
  renderBetsTab();
}

async function pushPinnedNotification(bet, forceAlert = false) {
  if (!bet?.pinned || Notification.permission !== "granted") return;

  const isSettled = bet.status === "won" || bet.status === "lost";
  const hitCount = bet.legs.filter(l => l.status === "hit").length;
  const prefix = bet.status === "won"
    ? `🏆 CASHED +$${(bet.payout - bet.stake).toFixed(0)}`
    : (bet.status === "lost" ? `❌ SETTLED -$${bet.stake}` : `📌 LIVE (${hitCount}/${bet.legs.length} Hit)`);

  const title = `${prefix} • $${bet.stake} → $${bet.payout}`;
  const body = bet.legs.map(l => {
    const ic = l.status === "hit" ? "✅" : (l.status === "miss" ? "❌" : (l.status === "live" ? "⚡" : "⏳"));
    const clk = l.clock ? ` (${l.clock})` : "";
    return `${ic} ${l.label}: ${l.liveScore}${clk}`;
  }).join("\n");

  const legSig = bet.legs.map(l => l.status).join(",");
  const milestoneChanged = Boolean(bet.lastLegSig && bet.lastLegSig !== legSig);
  const sig = `${bet.status}|${body}`;
  const scoreChanged = bet.lastNotifSig !== sig;

  if (!forceAlert && !scoreChanged && !milestoneChanged) return;

  bet.lastNotifSig = sig;
  bet.lastLegSig = legSig;
  persistBets();

  const shouldAlert = isSettled || milestoneChanged || forceAlert;
  const opts = {
    body,
    tag: `simlab-pin-${bet.id}`,
    icon: "./icon-512.jpeg",
    badge: "./icon-512.jpeg",
    requireInteraction: !isSettled,
    silent: !shouldAlert,
    renotify: shouldAlert
  };

  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, opts);
        return;
      }
    }
    new Notification(title, opts);
  } catch (e) {}
}

async function closePinnedNotification(betId) {
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      const list = await reg.getNotifications({ tag: `simlab-pin-${betId}` });
      list.forEach(n => n.close());
    }
  } catch (e) {}
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
    const bookTag = s.meta?.bestBook ? ` [${s.meta.bestBook} ${fmtAmerican(s.meta.bestOdds)}]` : "";
    return `${i + 1}. ${lbl} (${s.prob}%)${bookTag}`;
  });

  return [
    `🎯 SimLab ${slip.length}-Leg Card (${pct}% Hit | Odds ${oddsVal} | $${stakeVal} → $${payoutVal}):`,
    ...lines,
    `📊 Terminal: https://rockodevxda.github.io/sports-command-center/`
  ].join("\n");
}

function copyTextSync(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "2em";
  ta.style.height = "2em";
  ta.style.opacity = "0.01";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, 99999);
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
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
  copyTextSync(text);

  const btn = document.getElementById("openBookBtn");
  if (btn) {
    btn.textContent = `✓ Copied! Launching ${book.name}...`;
    setTimeout(() => { btn.textContent = "🚀 Copy & Open App"; }, 2400);
  }

  const ua = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);

  if (isMobile && book.scheme) {
    window.location.href = book.scheme;
    setTimeout(() => {
      if (!document.hidden && book.web) window.location.assign(book.web);
    }, 1200);
  } else if (book.web) {
    window.open(book.web, "_blank", "noopener,noreferrer");
  }
}

function exportSlipToPhoneUrl() {
  const payload = {
    s: slip.map(item => ({
      k: item.key,
      l: item.label,
      p: item.prob,
      m: item.meta || {}
    })),
    b: trackedBets.slice(0, 10)
  };
  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const shareUrl = `${window.location.origin}${window.location.pathname}?sync=${encodeURIComponent(encoded)}`;

  triggerShareOrCopy(
    shareUrl,
    document.getElementById("syncPhoneBtn"),
    "📱 Send to Phone"
  );
}

function importFromPhoneUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("sync");
  if (!raw) return;

  try {
    const decoded = JSON.parse(decodeURIComponent(escape(atob(raw))));
    if (Array.isArray(decoded.s) && decoded.s.length) {
      slip = decoded.s.map(x => ({
        key: x.k,
        label: x.l,
        prob: x.p,
        meta: x.m || {}
      }));
      updateSlipUI(true);
    }
    if (Array.isArray(decoded.b) && decoded.b.length) {
      const existingIds = new Set(trackedBets.map(t => t.id));
      const incoming = decoded.b.filter(t => t && t.id && !existingIds.has(t.id));
      if (incoming.length) {
        trackedBets = [...incoming, ...trackedBets];
        persistBets();
      }
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (e) {
    console.warn("Phone sync decode error:", e);
  }
}

function switchHub(hub, sub = null) {
  if (hub === "nba" && !sub && activeHub === "nba") {
    nbaSubView = nbaSubView === "props" ? "games" : (nbaSubView === "games" ? "recap" : "props");
  } else {
    activeHub = hub;
    if (hub === "nba" && sub) nbaSubView = sub;
    if (hub === "ncaa" && sub) ncaaSubView = sub;
  }
  visibleLimit = 25;

  const railEv = document.getElementById("railEv");
  const railNba = document.getElementById("railNba");
  const railNcaa = document.getElementById("railNcaa");
  const railBets = document.getElementById("railBets");
  if (railEv) railEv.className = activeHub === "ev" ? "rail-btn active-ev" : "rail-btn";
  if (railNba) railNba.className = activeHub === "nba" ? "rail-btn active-nba" : "rail-btn";
  if (railNcaa) railNcaa.className = activeHub === "ncaa" ? "rail-btn active-ncaa" : "rail-btn";
  if (railBets) railBets.className = activeHub === "bets" ? "rail-btn active-bets" : "rail-btn";

  const bNavEv = document.getElementById("bNavEv");
  const bNavNba = document.getElementById("bNavNba");
  const bNavNcaa = document.getElementById("bNavNcaa");
  const bNavBets = document.getElementById("bNavBets");
  if (bNavEv) bNavEv.className = activeHub === "ev" ? "b-nav-btn active-ev" : "b-nav-btn";
  if (bNavNba) bNavNba.className = activeHub === "nba" ? "b-nav-btn active-nba" : "b-nav-btn";
  if (bNavNcaa) bNavNcaa.className = activeHub === "ncaa" ? "b-nav-btn active-ncaa" : "b-nav-btn";
  if (bNavBets) bNavBets.className = activeHub === "bets" ? "b-nav-btn active-bets" : "b-nav-btn";

  const p = document.getElementById("subNbaProps");
  const g = document.getElementById("subNbaGames");
  const r = document.getElementById("subNbaRecap");
  if (p) p.className = nbaSubView === "props" ? "sub-tab active-nba" : "sub-tab";
  if (g) g.className = nbaSubView === "games" ? "sub-tab active-nba" : "sub-tab";
  if (r) r.className = nbaSubView === "recap" ? "sub-tab active-nba" : "sub-tab";

  const ng = document.getElementById("subNcaaGames");
  const nr = document.getElementById("subNcaaRecap");
  if (ng) ng.className = ncaaSubView === "games" ? "sub-tab active-ncaa" : "sub-tab";
  if (nr) nr.className = ncaaSubView === "recap" ? "sub-tab active-ncaa" : "sub-tab";

  const nbaSubTabs = document.getElementById("nbaSubTabs");
  const ncaaSubTabs = document.getElementById("ncaaSubTabs");
  if (nbaSubTabs) nbaSubTabs.style.display = activeHub === "nba" ? "flex" : "none";
  if (ncaaSubTabs) ncaaSubTabs.style.display = activeHub === "ncaa" ? "flex" : "none";

  syncHubControlsAndHeader();

  if (activeHub === "bets") {
    refreshTrackedBets();
    startLivePoller();
  } else {
    stopLivePoller();
    const isRecap = (activeHub === "nba" && nbaSubView === "recap") || (activeHub === "ncaa" && ncaaSubView === "recap");
    if (isRecap) gradeSlateRecap().then(render);
    else render();
  }
}

function syncHubControlsAndHeader() {
  const marketControls = document.getElementById("marketControls");
  const betsControls = document.getElementById("betsControls");
  const heroParlay = document.getElementById("heroParlay");

  ["evChips", "nbaChips", "nbaGamesChips", "ncaaChips", "recapChips"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  if (activeHub === "ev") {
    setText("hubTitle", "💎 Cross-Sport +EV Edge Finder");
    setText("hubSub", "Top mathematically positive expected value edges across NBA & NCAA");
    if (marketControls) marketControls.style.display = "block";
    if (betsControls) betsControls.style.display = "none";
    const chips = document.getElementById("evChips");
    if (chips) chips.style.display = "flex";
    if (heroParlay && topParlayLegs.length >= 2) heroParlay.style.display = "flex";
  } else if (activeHub === "nba") {
    if (marketControls) marketControls.style.display = "block";
    if (betsControls) betsControls.style.display = "none";
    if (heroParlay) heroParlay.style.display = "none";
    if (nbaSubView === "props") {
      setText("hubTitle", "🔥 NBA Player Props & Hit Form");
      setText("hubSub", "Real sportsbook prop lines, No-Vig fair odds & last-10 ESPN game logs");
      const chips = document.getElementById("nbaChips");
      if (chips) chips.style.display = "flex";
    } else if (nbaSubView === "games") {
      setText("hubTitle", "🏀 NBA Game Predictions (ATS & Totals)");
      setText("hubSub", "Team pace, offensive/defensive efficiency & multi-book line edges");
      const chips = document.getElementById("nbaGamesChips");
      if (chips) chips.style.display = "flex";
    } else {
      setText("hubTitle", "📊 NBA Graded Model Recap");
      setText("hubSub", "Completed NBA props and game lines graded automatically via ESPN");
      const chips = document.getElementById("recapChips");
      if (chips) chips.style.display = "flex";
    }
  } else if (activeHub === "ncaa") {
    if (marketControls) marketControls.style.display = "block";
    if (betsControls) betsControls.style.display = "none";
    if (heroParlay) heroParlay.style.display = "none";
    if (ncaaSubView === "games") {
      setText("hubTitle", "🎓 NCAA Basketball Predictions");
      setText("hubSub", "D1 matchup projections, spreads, totals & moneyline win probabilities");
      const chips = document.getElementById("ncaaChips");
      if (chips) chips.style.display = "flex";
    } else {
      setText("hubTitle", "📊 NCAA Predictions Recap");
      setText("hubSub", "Completed NCAA spreads & totals graded automatically via ESPN");
      const chips = document.getElementById("recapChips");
      if (chips) chips.style.display = "flex";
    }
  } else if (activeHub === "bets") {
    setText("hubTitle", "🎟️ Live Tracked Bets & Hedge Terminal");
    setText("hubSub", "Real-time ESPN score tracking, progress bars & live cashout/hedge math");
    if (marketControls) marketControls.style.display = "none";
    if (betsControls) betsControls.style.display = "block";
  }
}

function startLivePoller() {
  stopLivePoller();
  const hasPinned = trackedBets.some(b => b.pinned && b.status !== "won" && b.status !== "lost");
  const intervalMs = hasPinned ? 20000 : 45000;
  livePollTimer = setInterval(() => {
    if (trackedBets.some(b => (b.status !== "won" && b.status !== "lost") && (activeHub === "bets" || b.pinned))) {
      refreshTrackedBets();
    }
  }, intervalMs);
}
function stopLivePoller() {
  if (trackedBets.some(b => b.pinned && b.status !== "won" && b.status !== "lost")) return;
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}
function handleManualRefresh() {
  const isRecap = (activeHub === "nba" && nbaSubView === "recap") || (activeHub === "ncaa" && ncaaSubView === "recap");
  if (activeHub === "bets") refreshTrackedBets();
  else if (isRecap) gradeSlateRecap().then(render);
  else loadAllData(true);
}

function setEvFilter(val, btn) { evFilter = val; visibleLimit = 25; document.querySelectorAll("#evChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); buildTopParlay(); render(); }
function setSubFilter(val, btn) { subFilter = val; visibleLimit = 25; document.querySelectorAll("#nbaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setNbaGamesFilter(val, btn) { nbaGamesFilter = val; visibleLimit = 25; document.querySelectorAll("#nbaGamesChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setNcaaFilter(val, btn) { ncaaFilter = val; visibleLimit = 25; document.querySelectorAll("#ncaaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setRecapOutcomeFilter(val, btn) { recapOutcomeFilter = val; visibleLimit = 25; document.querySelectorAll("#recapChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
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

function getPickOddsAmerican(s) {
  if (s?.meta?.bestOdds !== undefined && s?.meta?.bestOdds !== null) return fmtAmerican(s.meta.bestOdds);
  if (s?.meta?.isAlt && s?.meta?.fairOdds) return fmtAmerican(s.meta.fairOdds);
  return "-110";
}

function updateSlipUI(recalcDefaultOdds = true) {
  const has = slip.length > 0;
  document.body.classList.toggle("has-slip", has);
  if (!has) return;

  const oddsEl = document.getElementById("bookOddsInput");
  if (recalcDefaultOdds) {
    if (slip.length === 1) {
      oddsEl.value = getPickOddsAmerican(slip[0]);
    } else {
      let decParlay = 1.0;
      slip.forEach(s => { decParlay *= americanToDecimal(getPickOddsAmerican(s)); });
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
  setText("slipCount", slip.length);
  setText("slipPayout", `→ $${estPayout}`);
  const chipsEl = document.getElementById("slipChips");
  if (chipsEl) {
    chipsEl.innerHTML = slip.map(s => {
      const oddsTag = s.meta?.bestOdds ? ` ${fmtAmerican(s.meta.bestOdds)}` : "";
      return `<div class="s-chip">${escHtml(s.label)} (${s.prob}%${oddsTag}) <span data-key="${escHtml(s.key)}" onclick="toggleSlipByKey(this.dataset.key)">×</span></div>`;
    }).join("");
  }
}

function saveTrackedBet() {
  if (!slip.length) return;
  const stake = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const decOdds = americanToDecimal(document.getElementById("bookOddsInput").value);
  const payout = +(stake * decOdds).toFixed(2);
  const todayIso = new Date().toLocaleDateString("en-CA").replace(/-/g, "");
  trackedBets.unshift({
    id: "bet-" + Date.now(),
    createdAt: new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    dateStr: todayIso, stake, payout, status: "pending", pinned: false,
    legs: slip.map(s => ({
      key: s.key, label: s.label, prob: s.prob, meta: s.meta || {},
      status: "pending", liveScore: "Scheduled", currentVal: 0, targetVal: parseFloat(s.meta?.line) || 0, clock: ""
    }))
  });
  persistBets();
  slip = [];
  updateSlipUI(true);
  switchHub("bets");
}

function deleteTrackedBet(betId) {
  closePinnedNotification(betId);
  trackedBets = trackedBets.filter(b => b.id !== betId);
  persistBets();
  renderBetsTab();
}

function buildEvBoard() {
  const items = [];

  for (const p of (Array.isArray(nbaPlayers) ? nbaPlayers : [])) {
    if (!p || !p.player) continue;
    const pidStr = String(p.id || p.player);
    for (const m of (Array.isArray(p.all_props) ? p.all_props : [])) {
      if (!m || !m.market) continue;
      const bestOdds = m.best_odds !== undefined && m.best_odds !== null ? m.best_odds : -110;
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(m.prob, americanToDecimal(bestOdds));
      if (evPct >= 3.0) {
        const side = m.side || "O";
        const k = `nba-${pidStr}-${m.stat || "PROP"}-${side}-${m.line || 0}`;
        const meta = {
          sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player,
          awayShort: p.opponent || "", homeShort: p.team || "",
          stat: m.stat || "PTS", side, line: m.line, isAlt: false, fairOdds: m.fair_odds, marketKey: m.market,
          bestBook: m.best_book || "", bestOdds, noVigOdds: m.no_vig_odds || null, noVigProb: m.no_vig_prob || null
        };
        registerPick(k, `${p.player} ${m.market}`, m.prob, meta);
        const bookSnippet = m.best_book ? ` • Best: ${m.best_book} ${fmtAmerican(bestOdds)}` : "";
        const nvSnippet = m.no_vig_odds ? ` • No-Vig: ${fmtAmerican(m.no_vig_odds)}` : "";
        items.push({
          key: k, category: "PROPS", badge: "🔥 NBA PROP",
          title: `${p.player} ${m.market}`,
          subtitle: `${p.team || ""} vs ${p.opponent || ""} • Sim: ${m.proj ?? "-"}${bookSnippet}${nvSnippet}`,
          tags: p.tags || [], prob: m.prob, evPct, qKellyPct, bestBook: m.best_book || "Consensus", bestOdds, noVigOdds: m.no_vig_odds || null, dots: m.dots || "", gameId: p.game_id
        });
      }
    }
  }

  for (const g of (Array.isArray(nbaGames) ? nbaGames : [])) {
    if (!g) continue;
    const awayLbl = g.away_abbr || g.away_short || "AWY";
    const homeLbl = g.home_abbr || g.home_short || "HOM";
    if (g.has_line && g.spread_pick) {
      const bestOdds = g.best_odds !== undefined && g.best_odds !== null ? g.best_odds : -110;
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.spread_cover_pct, americanToDecimal(bestOdds));
      if (evPct >= 3.0) {
        const k = `nbagame-${g.id}-ats`;
        const meta = { sport: "nbagame", betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick, bestBook: g.best_book || "", bestOdds, noVigOdds: g.no_vig_odds || null };
        registerPick(k, g.spread_pick, g.spread_cover_pct, meta);
        const bookSnippet = g.best_book ? ` • Best: ${g.best_book} ${fmtAmerican(bestOdds)}` : "";
        const nvSnippet = g.no_vig_odds ? ` • No-Vig: ${fmtAmerican(g.no_vig_odds)}` : "";
        items.push({
          key: k, category: "NBAGAMES", badge: "🏀 NBA SPREAD",
          title: g.spread_pick,
          subtitle: `${awayLbl} (${g.away_proj ?? "-"}) @ ${homeLbl} (${g.home_proj ?? "-"})${bookSnippet}${nvSnippet}`,
          tags: g.move_badges || [], prob: g.spread_cover_pct, evPct, qKellyPct, bestBook: g.best_book || "Consensus", bestOdds, noVigOdds: g.no_vig_odds || null, dots: "", gameId: g.id
        });
      }
    }
    if (g.has_total && g.total_pick) {
      const bestOdds = g.total_best_odds !== undefined && g.total_best_odds !== null ? g.total_best_odds : -110;
      const bestBook = g.total_best_book || g.best_book || "";
      const nvOdds = g.total_no_vig_odds || g.no_vig_odds || null;
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.total_cover_pct, americanToDecimal(bestOdds));
      if (evPct >= 3.0) {
        const k = `nbagame-${g.id}-tot`;
        const meta = { sport: "nbagame", betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under, bestBook, bestOdds, noVigOdds: nvOdds };
        registerPick(k, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, meta);
        const bookSnippet = bestBook ? ` • Best: ${bestBook} ${fmtAmerican(bestOdds)}` : "";
        const nvSnippet = nvOdds ? ` • No-Vig: ${fmtAmerican(nvOdds)}` : "";
        items.push({
          key: k, category: "NBAGAMES", badge: "🏀 NBA TOTAL",
          title: `${awayLbl}/${homeLbl} ${g.total_pick}`,
          subtitle: `Sim: ${g.total_proj ?? "-"} vs O/U ${g.over_under}${bookSnippet}${nvSnippet}`,
          tags: g.move_badges || [], prob: g.total_cover_pct, evPct, qKellyPct, bestBook: bestBook || "Consensus", bestOdds, noVigOdds: nvOdds, dots: "", gameId: g.id
        });
      }
    }
  }

  for (const g of (Array.isArray(ncaaGames) ? ncaaGames : [])) {
    if (!g || g.verified_d1 === false) continue;
    const awayLbl = g.away_short || g.away_team || "AWY";
    const homeLbl = g.home_short || g.home_team || "HOM";
    if (g.has_line && g.spread_pick && Math.abs(g.home_spread || 0) <= 24.5) {
      const spOdds = g.best_odds !== undefined && g.best_odds !== null ? g.best_odds : -110;
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.spread_cover_pct, americanToDecimal(spOdds));
      if (evPct >= 3.0) {
        const k = `ncaa-${g.id}-ats`;
        const meta = { sport: "ncaa", betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick, bestBook: g.best_book || "", bestOdds: spOdds, noVigOdds: g.no_vig_odds || null };
        registerPick(k, g.spread_pick, g.spread_cover_pct, meta);
        const bookSnippet = g.best_book ? ` • Best: ${g.best_book} ${fmtAmerican(spOdds)}` : "";
        const nvSnippet = g.no_vig_odds ? ` • No-Vig: ${fmtAmerican(g.no_vig_odds)}` : "";
        items.push({
          key: k, category: "NCAA", badge: "🎓 NCAA ATS",
          title: g.spread_pick,
          subtitle: `${awayLbl} (${g.away_proj ?? "-"}) @ ${homeLbl} (${g.home_proj ?? "-"})${bookSnippet}${nvSnippet}`,
          tags: g.move_badges || [], prob: g.spread_cover_pct, evPct, qKellyPct, bestBook: g.best_book || "Consensus", bestOdds: spOdds, noVigOdds: g.no_vig_odds || null, dots: "", gameId: g.id
        });
      }
    }
    if (g.has_total && g.total_pick && (g.total_edge_pts || 0) <= 14.0) {
      const totOdds = g.total_best_odds !== undefined && g.total_best_odds !== null ? g.total_best_odds : -110;
      const totBook = g.total_best_book || g.best_book || "";
      const nvOdds = g.total_no_vig_odds || g.no_vig_odds || null;
      const { evPct, qKellyPct } = calcEvAndQuarterKelly(g.total_cover_pct, americanToDecimal(totOdds));
      if (evPct >= 3.0) {
        const k = `ncaa-${g.id}-tot`;
        const meta = { sport: "ncaa", betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under, bestBook: totBook, bestOdds: totOdds, noVigOdds: nvOdds };
        registerPick(k, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, meta);
        const bookSnippet = totBook ? ` • Best: ${totBook} ${fmtAmerican(totOdds)}` : "";
        const nvSnippet = nvOdds ? ` • No-Vig: ${fmtAmerican(nvOdds)}` : "";
        items.push({
          key: k, category: "NCAA", badge: "🎓 NCAA TOTAL",
          title: `${awayLbl}/${homeLbl} ${g.total_pick}`,
          subtitle: `Sim: ${g.total_proj ?? "-"} vs O/U ${g.over_under}${bookSnippet}${nvSnippet}`,
          tags: g.move_badges || [], prob: g.total_cover_pct, evPct, qKellyPct, bestBook: totBook || "Consensus", bestOdds: totOdds, noVigOdds: nvOdds, dots: "", gameId: g.id
        });
      }
    }
  }

  items.sort((a, b) => b.evPct - a.evPct);
  evBoard = items;
  setText("evCount", evBoard.length);
  setText("bEvCount", evBoard.length);
}

async function gradeSlateRecap() {
  const dates = getDateWindowStrings();
  const nbaEvents = {}, ncaaEvents = {}, nbaBoxCache = {};
  for (const d of dates) {
    const [nbaRes, ncaaRes] = await Promise.allSettled([
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}&limit=100`),
      fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d}&groups=50&limit=200`)
    ]);
    if (nbaRes.status === "fulfilled" && nbaRes.value.ok) ((await nbaRes.value.json()).events || []).forEach(ev => { nbaEvents[String(ev.id)] = ev; });
    if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) ((await ncaaRes.value.json()).events || []).forEach(ev => { ncaaEvents[String(ev.id)] = ev; });
  }

  const graded = [];
  const seenIds = new Set();

  const gradeGamePick = (g, sportKey, sportBadge, betKind, pickTitle, lineVal, sideOrPick, oddsAm, probPct) => {
    const uid = `${sportKey}-${g.id}-${betKind}`;
    if (seenIds.has(uid)) return;
    const { evPct } = calcEvAndQuarterKelly(probPct || 50, americanToDecimal(oddsAm || -110));
    if (evPct < 3.0) return;

    const pool = sportKey === "NBA" ? nbaEvents : ncaaEvents;
    const awayLbl = g.away_abbr || g.away_short || "";
    const homeLbl = g.home_abbr || g.home_short || "";
    const ev = findMatchingEvent(pool, String(g.id || ""), awayLbl, homeLbl);
    if (!ev || ev.status?.type?.state !== "post") return;

    seenIds.add(uid);
    const comp = ev.competitions?.[0];
    const awayC = comp?.competitors?.find(c => c.homeAway === "away");
    const homeC = comp?.competitors?.find(c => c.homeAway === "home");
    const aS = parseFloat(awayC?.score || 0), hS = parseFloat(homeC?.score || 0);
    const aAbbr = awayC?.team?.abbreviation || awayLbl;
    const hAbbr = homeC?.team?.abbreviation || homeLbl;

    let hit = false;
    let finalLine = `${aAbbr} ${aS} - ${hAbbr} ${hS} (Final)`;
    if (betKind === "total") {
      const comb = aS + hS;
      hit = sideOrPick === "O" ? comb > lineVal : comb < lineVal;
      finalLine = `${aAbbr} ${aS} - ${hAbbr} ${hS} • Final Tot: ${comb} vs ${lineVal}`;
    } else if (betKind === "ats") {
      const parts = String(sideOrPick || "").split(" ");
      const ln = parseFloat(parts[parts.length - 1]) || 0;
      const tm = parts.slice(0, -1).join(" ");
      const marg = (tm === homeLbl || tm === hAbbr) ? (hS + ln - aS) : (aS + ln - hS);
      hit = marg > 0;
    }

    const dec = americanToDecimal(oddsAm || -110);
    const unitDelta = hit ? +(dec - 1).toFixed(2) : -1;
    graded.push({
      id: uid,
      sport: sportKey,
      badge: sportBadge,
      title: pickTitle,
      finalText: finalLine,
      oddsAm: oddsAm || -110,
      probPct: probPct || 55,
      hit,
      unitDelta
    });
  };

  for (const g of (Array.isArray(nbaGames) ? nbaGames : [])) {
    if (!g) continue;
    if (g.has_line && g.spread_pick) gradeGamePick(g, "NBA", "🏀 NBA ATS", "ats", g.spread_pick, g.home_spread, g.spread_pick, g.best_odds, g.spread_cover_pct);
    if (g.has_total && g.total_pick) gradeGamePick(g, "NBA", "🏀 NBA TOTAL", "total", `${g.away_abbr || g.away_short}/${g.home_abbr || g.home_short} ${g.total_pick}`, g.over_under, (g.total_pick || "").startsWith("U") ? "U" : "O", g.total_best_odds || g.best_odds, g.total_cover_pct);
  }

  for (const g of (Array.isArray(ncaaGames) ? ncaaGames : [])) {
    if (!g || g.verified_d1 === false) continue;
    if (g.has_line && g.spread_pick) gradeGamePick(g, "NCAA", "🎓 NCAA ATS", "ats", g.spread_pick, g.home_spread, g.spread_pick, g.best_odds, g.spread_cover_pct);
    if (g.has_total && g.total_pick) gradeGamePick(g, "NCAA", "🎓 NCAA TOTAL", "total", `${g.away_short || g.away_team}/${g.home_short || g.home_team} ${g.total_pick}`, g.over_under, (g.total_pick || "").startsWith("U") ? "U" : "O", g.total_best_odds || g.best_odds, g.total_cover_pct);
  }

  for (const p of (Array.isArray(nbaPlayers) ? nbaPlayers : [])) {
    if (!p || !p.player || !p.best_prop) continue;
    const m = p.best_prop;
    const bestOdds = m.best_odds !== undefined && m.best_odds !== null ? m.best_odds : -110;
    const { evPct } = calcEvAndQuarterKelly(m.prob || 50, americanToDecimal(bestOdds));
    if (evPct < 3.0) continue;

    const uid = `PROP-${p.game_id}-${p.id}`;
    if (seenIds.has(uid)) continue;

    const ev = findMatchingEvent(nbaEvents, String(p.game_id || ""), p.opponent, p.team);
    if (!ev || ev.status?.type?.state !== "post") continue;

    seenIds.add(uid);
    const gid = String(ev.id);
    if (!nbaBoxCache[gid]) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gid}`);
        if (r.ok) nbaBoxCache[gid] = await r.json();
      } catch (e) {}
    }

    const actual = extractNbaPlayerStat(nbaBoxCache[gid], String(p.id || ""), p.player, m.stat || "PTS");
    const tgt = parseFloat(m.line) || 0;
    const isU = m.side === "U";
    const hit = isU ? actual < tgt : actual > tgt;
    const dec = americanToDecimal(bestOdds);
    graded.push({
      id: uid,
      sport: "PROPS",
      badge: "🔥 NBA PROP",
      title: `${p.player} ${m.market}`,
      finalText: `Actual: ${actual} ${m.stat || "PTS"} vs Line ${tgt} (Final)`,
      oddsAm: bestOdds,
      probPct: m.prob || 55,
      hit,
      unitDelta: hit ? +(dec - 1).toFixed(2) : -1
    });
  }

  graded.sort((a, b) => (b.hit === a.hit ? b.probPct - a.probPct : (b.hit ? 1 : -1)));
  recapItems = graded;
}

function renderScopedRecap(scopeSport) {
  const listEl = document.getElementById("cardsList");
  const moreBtn = document.getElementById("loadMoreBtn");
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();

  const filtered = recapItems.filter(item => {
    if (scopeSport === "NCAA" && item.sport !== "NCAA") return false;
    if (scopeSport === "NBA" && item.sport !== "NBA" && item.sport !== "PROPS") return false;
    if (q && !item.title.toLowerCase().includes(q) && !item.finalText.toLowerCase().includes(q)) return false;
    if (recapOutcomeFilter === "HIT" && !item.hit) return false;
    if (recapOutcomeFilter === "MISS" && item.hit) return false;
    return true;
  });

  const hits = filtered.filter(x => x.hit).length;
  const misses = filtered.length - hits;
  const pct = filtered.length ? ((hits / filtered.length) * 100).toFixed(1) : "0.0";
  const netUnits = filtered.reduce((acc, x) => acc + x.unitDelta, 0);
  const label = scopeSport === "NCAA" ? "🎓 NCAA Predictions" : "🏀 NBA Props & Games";

  const summaryHtml = `<div class="card recap-card ${netUnits >= 0 ? "hit" : "miss"}" style="grid-column:1/-1;">
    <div class="c-head">
      <div>
        <div class="c-name">📊 ${escHtml(label)} Recap • ${hits}W - ${misses}L (${pct}%)</div>
        <div class="c-meta">Green = Hit • Red = Miss • Net Flat Units: <strong style="color:${netUnits >= 0 ? "var(--emerald)" : "var(--danger)"};">${netUnits >= 0 ? "+" : ""}${netUnits.toFixed(2)}u</strong></div>
      </div>
      <span class="edge-tag" style="background:${netUnits >= 0 ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)"}; color:${netUnits >= 0 ? "#10b981" : "#ef4444"};">${netUnits >= 0 ? "+" : ""}${netUnits.toFixed(2)}u</span>
    </div>
  </div>`;

  if (!filtered.length) {
    listEl.innerHTML = summaryHtml + `<div class="card" style="grid-column:1/-1; text-align:center; padding:20px;"><div style="font-size:0.88rem; font-weight:700;">No Finalized ${escHtml(label)} to Grade Yet</div><div style="font-size:0.74rem; color:var(--sub);">Once games finish on ESPN, graded green (HIT) and red (MISS) cards appear here automatically.</div></div>`;
    if (moreBtn) moreBtn.style.display = "none";
    return;
  }

  const slice = filtered.slice(0, visibleLimit);
  if (moreBtn) {
    moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
    moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
  }

  listEl.innerHTML = summaryHtml + slice.map(item => `
    <article class="card recap-card ${item.hit ? "hit" : "miss"}">
      <div class="c-head">
        <div>
          <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px; flex-wrap:wrap;">
            <span class="s-tag ${item.hit ? "" : "cyan"}" style="background:${item.hit ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)"}; color:${item.hit ? "#34d399" : "#f87171"};">${item.hit ? "✅ HIT" : "❌ MISS"}</span>
            <span class="s-tag gold">${escHtml(item.badge)}</span>
          </div>
          <div class="c-name">${escHtml(item.title)}</div>
          <div class="c-meta">${escHtml(item.finalText)} • ${fmtAmerican(item.oddsAm)} (${item.probPct}% Sim)</div>
        </div>
        <span style="font-weight:800; font-size:0.85rem; color:${item.hit ? "#10b981" : "#ef4444"};">${item.unitDelta >= 0 ? "+" : ""}${item.unitDelta.toFixed(2)}u</span>
      </div>
    </article>
  `).join("");
}

function buildTopParlay() {
  const legs = [];
  const usedGames = new Set();
  const usedPlayers = new Set();

  let pool = evBoard;
  if (evFilter === "MAX") pool = evBoard.filter(x => x.evPct >= 15.0);
  else if (evFilter === "PROPS") pool = evBoard.filter(x => x.category === "PROPS");
  else if (evFilter === "NBAGAMES") pool = evBoard.filter(x => x.category === "NBAGAMES");
  else if (evFilter === "NCAA") pool = evBoard.filter(x => x.category === "NCAA");

  const tryAdd = (item) => {
    if (!item || legs.length >= 4) return false;
    const meta = pickRegistry[item.key]?.meta || {};
    const gid = String(item.gameId || meta.gameId || item.key);
    const pName = (meta.playerName || "").toLowerCase().trim();
    if (usedGames.has(gid)) return false;
    if (pName && usedPlayers.has(pName)) return false;

    legs.push({ key: item.key, label: item.title, prob: item.prob, meta });
    usedGames.add(gid);
    if (pName) usedPlayers.add(pName);
    return true;
  };

  if (evFilter === "ALL") {
    const topNcaa = pool.filter(x => x.category === "NCAA");
    const topNbaGames = pool.filter(x => x.category === "NBAGAMES");
    const topProps = pool.filter(x => x.category === "PROPS");

    topNcaa.slice(0, 2).forEach(tryAdd);
    topNbaGames.slice(0, 1).forEach(tryAdd);
    topProps.slice(0, 2).forEach(tryAdd);
  }

  for (const item of pool) {
    if (legs.length >= 4) break;
    tryAdd(item);
  }

  topParlayLegs = legs;
  const banner = document.getElementById("heroParlay");
  if (!banner) return;
  if (legs.length < 2 || activeHub !== "ev") {
    banner.style.display = "none";
    return;
  }

  let c = 1.0;
  legs.forEach(l => { c *= (l.prob / 100); });
  const pct = +(c * 100).toFixed(1);
  banner.style.display = "flex";
  setText("heroParlaySub", `${legs.map(l => l.label).join(" • ")} (${pct}% | ${probToAmerican(pct)})`);
}

function getDateWindowStrings(extraDateStr = "") {
  const out = new Set();
  const now = new Date();
  for (const offsetDays of [-1, 0, 1]) {
    const d = new Date(now.getTime() + offsetDays * 86400000);
    out.add(d.toISOString().slice(0, 10).replace(/-/g, ""));
    out.add(d.toLocaleDateString("en-CA").replace(/-/g, ""));
  }
  if (extraDateStr) out.add(String(extraDateStr).replace(/-/g, ""));
  return Array.from(out);
}

function findMatchingEvent(eventsMap, gid, awayShort, homeShort) {
  if (gid && eventsMap[gid]) return eventsMap[gid];
  const aUp = (awayShort || "").toUpperCase();
  const hUp = (homeShort || "").toUpperCase();
  if (!aUp && !hUp) return null;
  for (const ev of Object.values(eventsMap)) {
    const comp = ev.competitions?.[0];
    const awayAbbr = (comp?.competitors?.find(c => c.homeAway === "away")?.team?.abbreviation || "").toUpperCase();
    const homeAbbr = (comp?.competitors?.find(c => c.homeAway === "home")?.team?.abbreviation || "").toUpperCase();
    if ((aUp && awayAbbr === aUp) || (hUp && homeAbbr === hUp)) return ev;
  }
  return null;
}

async function refreshTrackedBets() {
  const statusEl = document.getElementById("livePollStatus");
  if (statusEl) statusEl.textContent = "Fetching live ESPN scores & box scores...";
  const datesToFetch = new Set(getDateWindowStrings());
  trackedBets.forEach(b => {
    if (b.dateStr) getDateWindowStrings(b.dateStr).forEach(ds => datesToFetch.add(ds));
  });

  const nbaEvents = {}, ncaaEvents = {}, nbaBoxCache = {};
  try {
    for (const d of datesToFetch) {
      const [nbaRes, ncaaRes] = await Promise.allSettled([
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d}&limit=100`),
        fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d}&groups=50&limit=200`)
      ]);
      if (nbaRes.status === "fulfilled" && nbaRes.value.ok) ((await nbaRes.value.json()).events || []).forEach(ev => { nbaEvents[String(ev.id)] = ev; });
      if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) ((await ncaaRes.value.json()).events || []).forEach(ev => { ncaaEvents[String(ev.id)] = ev; });
    }

    for (const bet of trackedBets) {
      for (const leg of bet.legs) {
        const m = leg.meta || {}, gid = String(m.gameId || "");
        const targetLine = parseFloat(m.line) || 0;
        leg.targetVal = targetLine;

        if (m.sport === "nba") {
          const ev = findMatchingEvent(nbaEvents, gid, m.awayShort, m.homeShort);
          if (!ev) {
            if (!leg.liveScore || leg.liveScore === "Scheduled") leg.liveScore = `0 / ${targetLine || ""} ${m.stat || ""}`.trim();
            continue;
          }
          const evId = String(ev.id);
          const state = ev.status?.type?.state || "pre", detail = ev.status?.type?.shortDetail || "";
          const comp = ev.competitions?.[0], away = comp?.competitors?.find(c => c.homeAway === "away"), home = comp?.competitors?.find(c => c.homeAway === "home");
          leg.clock = `${away?.team?.abbreviation || ""} ${away?.score || 0} - ${home?.team?.abbreviation || ""} ${home?.score || 0}${detail ? ` • ${detail}` : ""}`;
          const isUnder = m.side === "U";
          if (state === "pre") { leg.status = "pending"; leg.currentVal = 0; leg.liveScore = `0 / ${targetLine} ${m.stat || "PTS"}`; }
          else {
            if (!nbaBoxCache[evId]) {
              try {
                const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${evId}`);
                if (r.ok) nbaBoxCache[evId] = await r.json();
              } catch (e) {}
            }
            const val = extractNbaPlayerStat(nbaBoxCache[evId], String(m.playerId || ""), m.playerName, m.stat || "PTS");
            leg.currentVal = val;
            leg.liveScore = `${val} / ${targetLine} ${m.stat || "PTS"}`;
            if (isUnder) {
              if (val > targetLine) leg.status = "miss";
              else leg.status = state === "post" ? "hit" : "live";
            } else {
              leg.status = state === "post" ? (val > targetLine ? "hit" : "miss") : (val > targetLine ? "hit" : "live");
            }
          }
        } else if (m.sport === "ncaa" || m.sport === "nbagame") {
          const pool = m.sport === "nbagame" ? nbaEvents : ncaaEvents;
          const ev = findMatchingEvent(pool, gid, m.awayShort, m.homeShort);
          if (!ev) continue;
          const state = ev.status?.type?.state || "pre", detail = ev.status?.type?.shortDetail || "";
          const comp = ev.competitions?.[0], away = comp?.competitors?.find(c => c.homeAway === "away"), home = comp?.competitors?.find(c => c.homeAway === "home");
          const aS = parseFloat(away?.score || 0), hS = parseFloat(home?.score || 0);
          const sStr = `${m.awayShort || away?.team?.abbreviation || "AWY"} ${aS} - ${m.homeShort || home?.team?.abbreviation || "HOM"} ${hS}`;
          leg.clock = detail;
          if (state === "pre") { leg.status = "pending"; leg.currentVal = 0; leg.liveScore = "Tipoff scheduled"; }
          else if (m.betType === "total") {
            const comb = aS + hS; leg.currentVal = comb; leg.targetVal = targetLine; leg.liveScore = `${sStr} (Tot: ${comb} vs ${targetLine})`;
            leg.status = state === "post" ? ((m.side === "O" ? comb > targetLine : comb < targetLine) ? "hit" : "miss") : "live";
          } else if (m.betType === "ml") {
            leg.currentVal = Math.max(aS, hS); leg.targetVal = Math.max(aS, hS) || 1; leg.liveScore = sStr;
            const lead = (m.favoredTeam === m.homeShort) ? hS > aS : aS > hS;
            leg.status = state === "post" ? (lead ? "hit" : "miss") : "live";
          } else if (m.betType === "ats") {
            leg.currentVal = Math.max(aS, hS); leg.targetVal = Math.max(aS, hS) || 1; leg.liveScore = sStr;
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

      if (bet.pinned) {
        await pushPinnedNotification(bet, false);
        if (bet.status === "won" || bet.status === "lost") {
          bet.pinned = false;
          if (activeHub !== "bets") stopLivePoller();
        }
      }
    }
    persistBets();
    const hasPinned = trackedBets.some(b => b.pinned && b.status !== "won" && b.status !== "lost");
    if (statusEl) statusEl.textContent = `Live ESPN synced at ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}${hasPinned ? " • 📌 Pinned live (20s)" : ""}`;
  } catch (e) { if (statusEl) statusEl.textContent = "Live check paused (offline)"; }
  if (activeHub === "bets") renderBetsTab();
}

function extractNbaPlayerStat(sum, pid, pname, stat) {
  if (!sum?.boxscore?.players) return 0;
  const targetNorm = (pname || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const tb of sum.boxscore.players) {
    const sg = tb.statistics?.[0];
    if (!sg) continue;
    const names = (sg.names || []).map(n => n.toUpperCase());
    const iP = names.indexOf("PTS"), iR = names.indexOf("REB"), iA = names.indexOf("AST"), i3 = names.findIndex(n => n === "3PT" || n === "3PM");
    for (const ae of (sg.athletes || [])) {
      const athNameNorm = (ae.athlete?.displayName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if ((pid && String(ae.athlete?.id) === pid) || (targetNorm && athNameNorm === targetNorm)) {
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
  const moreBtn = document.getElementById("loadMoreBtn");
  if (moreBtn) moreBtn.style.display = "none";
  let activeRisk = 0, netPL = 0, wins = 0, losses = 0;
  trackedBets.forEach(b => {
    if (b.status === "won") { wins++; netPL += (b.payout - b.stake); }
    else if (b.status === "lost") { losses++; netPL -= b.stake; }
    else activeRisk += b.stake;
  });
  setText("statActiveRisk", `$${activeRisk.toFixed(0)}`);
  const plEl = document.getElementById("statNetPL");
  if (plEl) {
    plEl.textContent = `${netPL >= 0 ? "+" : "-"}$${Math.abs(netPL).toFixed(0)}`;
    plEl.style.color = netPL >= 0 ? "var(--emerald)" : "var(--danger)";
  }
  setText("statRecord", `${wins}-${losses}`);

  if (!trackedBets.length) {
    listEl.innerHTML = `<div class="card" style="grid-column:1/-1; text-align:center; padding:24px 16px;"><div style="font-size:0.95rem; font-weight:800; margin-bottom:4px;">No Tracked Bets Yet</div><div style="font-size:0.76rem; color:var(--sub);">Tap any +EV edge, apply your Kelly stake in the bottom drawer, and tap <strong>📌 Track</strong> to sweat live stats here.</div></div>`;
    return;
  }
  listEl.innerHTML = trackedBets.map(bet => {
    const badgeMap = { won: `<span class="status-pill won">🏆 WON +$${(bet.payout - bet.stake).toFixed(0)}</span>`, lost: `<span class="status-pill lost">❌ LOST -$${bet.stake}</span>`, live: `<span class="status-pill live">⚡ LIVE SWEAT</span>`, pending: `<span class="status-pill pending">⏳ UPCOMING</span>` };
    const isOpen = Boolean(openHedgeMap[bet.id]);
    const hOdds = hedgeOddsMap[bet.id] || "+140";
    const hm = computeHedgeNumbers(bet.stake, bet.payout, hOdds);
    const canHedge = bet.status === "live" || bet.status === "pending";
    const isPinned = Boolean(bet.pinned);

    const legsHtml = bet.legs.map(leg => {
      const icon = leg.status === "hit" ? "✅" : (leg.status === "miss" ? "❌" : (leg.status === "live" ? "⚡" : "⏳"));
      const cur = parseFloat(leg.currentVal) || 0;
      const tgt = parseFloat(leg.targetVal) || 0;
      const pct = tgt > 0 ? Math.min(100, Math.max(0, Math.round((cur / tgt) * 100))) : 0;
      const showBar = tgt > 0 && (leg.meta?.sport === "nba" || leg.meta?.betType === "total");
      return `<div class="leg-row"><div class="leg-top"><span>${icon} ${escHtml(leg.label)}</span><span style="color:var(--emerald); font-size:0.7rem;">${leg.prob}%</span></div><div class="leg-sub"><span>${escHtml(leg.liveScore || "Scheduled")}</span><span>${escHtml(leg.clock || "")}</span></div>${showBar ? `<div class="prog-track"><div class="prog-fill ${leg.status || "pending"}" style="width:${pct}%"></div></div>` : ""}</div>`;
    }).join("");

    const hedgeHtml = (canHedge && isOpen) ? `
      <div class="hedge-drawer">
        <div class="hedge-head">
          <span>🛡️ Live Hedge & Cashout Calculator</span>
          <span class="stake-box" style="color:var(--gold);">Opp Odds<input type="text" value="${escHtml(hOdds)}" data-id="${escHtml(bet.id)}" oninput="updateHedgeCalc(this.dataset.id, this.value)" /></span>
        </div>
        <div class="hedge-grid">
          <div><div class="ev-m-lbl">Equal Hedge</div><div class="ev-m-val" id="h-stake-${escHtml(bet.id)}" style="color:#fff;">$${hm.equalHedgeStake.toFixed(2)}</div></div>
          <div><div class="ev-m-lbl">Locked Profit</div><div class="ev-m-val" id="h-prof-${escHtml(bet.id)}" style="color:${hm.lockedProfit >= 0 ? "var(--emerald)" : "var(--danger)"};">${hm.lockedProfit >= 0 ? "+" : "-"}$${Math.abs(hm.lockedProfit).toFixed(2)}</div></div>
          <div><div class="ev-m-lbl">Risk-Free Stake</div><div class="ev-m-val" id="h-free-${escHtml(bet.id)}" style="color:var(--cyan);">$${hm.freerollStake.toFixed(2)}</div></div>
        </div>
      </div>` : "";

    return `<article class="bet-card ${bet.status}">
      <div class="c-head">
        <div>
          <div class="c-name">${bet.legs.length}-Leg ${bet.legs.length === 1 ? "Straight" : "Parlay"} • $${bet.stake} → $${bet.payout}</div>
          <div class="c-meta">Placed ${escHtml(bet.createdAt)}</div>
        </div>
        <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap; justify-content:flex-end;">
          ${badgeMap[bet.status] || badgeMap.pending}
          ${canHedge ? `<button class="btn-sm" style="padding:2px 6px; font-size:0.68rem; border-color:var(--emerald); color:${isPinned ? "#03150a" : "var(--emerald)"}; background:${isPinned ? "var(--emerald)" : "var(--card)"};" data-id="${escHtml(bet.id)}" onclick="togglePinNotification(this.dataset.id)">${isPinned ? "📌 Pinned" : "📌 Pin"}</button>` : ""}
          ${canHedge ? `<button class="btn-sm" style="padding:2px 6px; font-size:0.68rem; border-color:var(--gold); color:var(--gold);" data-id="${escHtml(bet.id)}" onclick="toggleHedgeDrawer(this.dataset.id)">🛡️ Hedge</button>` : ""}
          <button class="btn-sm" style="padding:2px 6px; font-size:0.68rem; border-color:var(--cyan); color:var(--cyan);" data-id="${escHtml(bet.id)}" onclick="shareSavedBet(this.dataset.id)">📤</button>
          <button class="btn-sm" style="padding:2px 6px; font-size:0.68rem;" data-id="${escHtml(bet.id)}" onclick="deleteTrackedBet(this.dataset.id)">🗑️</button>
        </div>
      </div>
      ${legsHtml}
      ${hedgeHtml}
    </article>`;
  }).join("");
}

function renderGameCards(gamesList, prefix, sportTag, activeSubFilter, q, filter, listEl, moreBtn) {
  const safeList = Array.isArray(gamesList) ? gamesList.filter(Boolean) : [];
  const sorted = [...safeList].sort((a, b) => {
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
  if (moreBtn) {
    moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
    moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
  }

  listEl.innerHTML = slice.map(g => {
    const awayLbl = g.away_abbr || g.away_short || "AWY";
    const homeLbl = g.home_abbr || g.home_short || "HOM";
    const atsKey = `${prefix}-${g.id}-ats`, totKey = `${prefix}-${g.id}-tot`, mlKey = `${prefix}-${g.id}-ml`;
    const spOdds = g.best_odds !== undefined && g.best_odds !== null ? g.best_odds : -110;
    const totOdds = g.total_best_odds !== undefined && g.total_best_odds !== null ? g.total_best_odds : -110;
    const totBook = g.total_best_book || g.best_book || "";

    if (g.has_line && g.spread_pick) registerPick(atsKey, g.spread_pick, g.spread_cover_pct, { sport: sportTag, betType: "ats", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, pickText: g.spread_pick, bestBook: g.best_book || "", bestOdds: spOdds, noVigOdds: g.no_vig_odds || null });
    if (g.has_total && g.total_pick) registerPick(totKey, `${awayLbl}/${homeLbl} ${g.total_pick}`, g.total_cover_pct, { sport: sportTag, betType: "total", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under, bestBook: totBook, bestOdds: totOdds, noVigOdds: g.total_no_vig_odds || null });
    registerPick(mlKey, `${g.favored_team || homeLbl} ML`, g.favored_prob || 55, { sport: sportTag, betType: "ml", gameId: g.id, awayShort: awayLbl, homeShort: homeLbl, favoredTeam: g.favored_team || homeLbl });

    const atsSel = slip.some(s => s.key === atsKey), totSel = slip.some(s => s.key === totKey), mlSel = slip.some(s => s.key === mlKey);
    const simTotal = g.total_proj ?? +((parseFloat(g.away_proj) || 0) + (parseFloat(g.home_proj) || 0)).toFixed(1);
    const moveTags = (g.move_badges || []).map(b => `<span class="s-tag ${b.includes("B2B") ? "" : "cyan"}">${escHtml(b)}</span>`).join("");
    const bookTag = g.best_book ? `<span class="s-tag gold">Best: ${escHtml(g.best_book)} ${fmtAmerican(spOdds)}${g.no_vig_odds ? ` • NV ${fmtAmerican(g.no_vig_odds)}` : ""}</span>` : "";

    return `<article class="card ${(atsSel || totSel || mlSel) ? "in-slip" : ""}">
      <div class="c-head">
        <div>
          <div class="c-name">${escHtml(awayLbl)} @ ${escHtml(homeLbl)}</div>
          <div class="c-meta">${escHtml(g.tipoff || "")} • ${escHtml(g.market_line || "PK")}${g.has_total ? ` • O/U ${g.over_under}` : ""}${g.exp_pace ? ` • Pace ${g.exp_pace}` : ""}</div>
          ${(moveTags || bookTag) ? `<div class="sharp-tags">${bookTag}${moveTags}</div>` : ""}
        </div>
        ${g.has_line ? `<span class="edge-tag">+${g.edge_pts ?? 0} ATS</span>` : ""}
      </div>
      ${g.h2h_summary ? `<div class="h2h-bar">📜 ${escHtml(g.h2h_summary)}</div>` : ""}
      <div class="ncaa-scores">
        <span><strong>${escHtml(awayLbl)}</strong> ${g.away_proj ?? "-"} • <strong>${escHtml(homeLbl)}</strong> ${g.home_proj ?? "-"}</span>
        <span style="color:var(--cyan); font-weight:700;">Tot: ${simTotal}</span>
      </div>
      <div class="ncaa-grid">
        ${g.has_line && g.spread_pick ? `<button class="p-btn ${atsSel ? "selected" : ""} ${(g.spread_cover_pct || 0) >= 58 ? "hot" : ""}" data-key="${escHtml(atsKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.spread_pick)}</span><span class="prob-val">${g.spread_cover_pct ?? 50}%</span></button>` : `<button class="p-btn" disabled><span>No Line</span></button>`}
        ${g.has_total && g.total_pick ? `<button class="p-btn ${totSel ? "selected" : ""} ${(g.total_cover_pct || 0) >= 58 ? "hot" : ""}" data-key="${escHtml(totKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.total_pick)}</span><span class="prob-val">${g.total_cover_pct ?? 50}%</span></button>` : `<button class="p-btn" disabled><span>No O/U</span></button>`}
        <button class="p-btn ${mlSel ? "selected" : ""} ${(g.favored_prob || 0) >= 70 ? "hot" : ""}" data-key="${escHtml(mlKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.favored_team || homeLbl)} ML</span><span class="prob-val">${g.favored_prob ?? 50}%</span></button>
      </div>
    </article>`;
  }).join("");
}

function render() {
  if (activeHub === "bets") { renderBetsTab(); return; }
  if (activeHub === "nba" && nbaSubView === "recap") { renderScopedRecap("NBA"); return; }
  if (activeHub === "ncaa" && ncaaSubView === "recap") { renderScopedRecap("NCAA"); return; }

  const listEl = document.getElementById("cardsList"), moreBtn = document.getElementById("loadMoreBtn");
  if (!listEl) return;
  const q = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();
  const filter = document.getElementById("filterSelect")?.value || "ALL";

  if (activeHub === "ev") {
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
    if (moreBtn) {
      moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
      moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
    }

    listEl.innerHTML = slice.map((item, idx) => {
      const sel = slip.some(s => s.key === item.key);
      const kellyDollar = Math.max(1, Math.round(bankroll * (item.qKellyPct / 100)));
      const tagsHtml = (item.tags || []).slice(0, 3).map(t => `<span class="s-tag ${t.includes("DEF") || t.includes("B2B") || t.includes("UNDER") ? "cyan" : ""}">${escHtml(t)}</span>`).join("");
      const oddsLbl = `+EV (${fmtAmerican(item.bestOdds)})`;

      return `<article class="card ${sel ? "in-slip" : ""}">
        <div class="c-head">
          <div>
            <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px; flex-wrap:wrap;">
              <span class="s-tag gold">#${idx + 1} ${escHtml(item.badge)}</span>
              ${item.bestBook ? `<span class="s-tag cyan">${escHtml(item.bestBook)} ${fmtAmerican(item.bestOdds)}</span>` : ""}
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
          <div><div class="ev-m-lbl">${escHtml(oddsLbl)}</div><div class="ev-m-val" style="color:var(--emerald);">+${item.evPct}%</div></div>
          <div><div class="ev-m-lbl">1/4 Kelly</div><div class="ev-m-val" style="color:var(--cyan);">$${kellyDollar} (${item.qKellyPct}%)</div></div>
        </div>
      </article>`;
    }).join("");
    return;
  }

  if (activeHub === "nba" && nbaSubView === "props") {
    const validPlayers = (Array.isArray(nbaPlayers) ? nbaPlayers : []).filter(p => p && p.player);
    const sorted = [...validPlayers].sort((a, b) => {
      if (subFilter === "ALTS") return ((b.alt_props?.[0]?.prob || 0) - (a.alt_props?.[0]?.prob || 0));
      if (["PTS", "REB", "AST", "PRA"].includes(subFilter)) return (b.all_props?.find(x => x.stat === subFilter)?.prob || 0) - (a.all_props?.find(x => x.stat === subFilter)?.prob || 0);
      return (b.best_prop?.prob || 0) - (a.best_prop?.prob || 0);
    });
    const filtered = sorted.filter(p => {
      if (q && !p.player.toLowerCase().includes(q) && !(p.team || "").toLowerCase().includes(q) && !(p.opponent || "").toLowerCase().includes(q)) return false;
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
    if (moreBtn) {
      moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
      moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
    }
    listEl.innerHTML = slice.map(p => {
      const pidStr = String(p.id || p.player);
      const isWatched = watchlist.includes(pidStr);
      const inSlip = slip.some(s => s.key.startsWith(`nba-${pidStr}`));

      let pool = Array.isArray(p.all_props) ? p.all_props : [];
      if (subFilter === "ALTS") pool = Array.isArray(p.alt_props) ? p.alt_props : [];
      else if (subFilter === "UNDERS") pool = pool.filter(m => m.side === "U");
      else if (["PTS", "REB", "AST", "PRA"].includes(subFilter)) pool = pool.filter(m => m.stat === subFilter);

      const selectedKey = activePropByPlayer[pidStr];
      const focusProp = (selectedKey && [...(p.all_props || []), ...(p.alt_props || [])].find(x => (x.market || x.stat) === selectedKey || x.stat === selectedKey)) || pool[0] || p.best_prop || {};
      const tagsHtml = (p.tags || []).map(t => `<span class="s-tag ${t.includes("DEF") || t.includes("B2B") || t.includes("UNDER") ? "cyan" : ""}">${escHtml(t)}</span>`).join("");

      return `<article class="card ${inSlip ? "in-slip" : ""}">
        <div class="c-head">
          <div>
            <div class="c-name">${escHtml(p.player)} <span class="c-meta">• ${escHtml(p.team || "")} vs ${escHtml(p.opponent || "")} (${p.avg_min ?? 30}m)</span></div>
            ${tagsHtml ? `<div class="sharp-tags">${tagsHtml}</div>` : ""}
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <span class="c-meta">O/U ${p.game_total ?? "-"}</span>
            <button class="btn-sm" style="padding:2px 6px; font-size:0.75rem; border-color:${isWatched ? "var(--orange)" : "var(--border)"}; color:${isWatched ? "var(--orange)" : "var(--muted)"};" onclick="toggleWatch('${escHtml(pidStr)}', event)">${isWatched ? "★" : "☆"}</button>
          </div>
        </div>
        ${focusProp.dots ? `<div class="streak-bar"><span><strong>${escHtml(focusProp.market || "")}</strong> Recent Form: <strong style="color:var(--emerald);">${escHtml(focusProp.hit_str || "")}</strong></span>${renderDots(focusProp.dots)}</div>` : ""}
        <div class="prop-grid" style="${pool.length === 1 ? "grid-template-columns:1fr;" : ""}">
          ${pool.map(m => {
            const side = m.side || "O";
            const isAlt = Boolean(m.is_alt || subFilter === "ALTS");
            const bestOdds = m.best_odds !== undefined && m.best_odds !== null ? m.best_odds : (isAlt && m.fair_odds ? m.fair_odds : -110);
            const k = `nba-${pidStr}-${m.stat || "PROP"}-${side}-${m.line || 0}`;
            registerPick(k, `${p.player} ${m.market}`, m.prob, {
              sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player,
              awayShort: p.opponent || "", homeShort: p.team || "",
              stat: m.stat || "PTS", side, line: m.line, isAlt, fairOdds: m.fair_odds, marketKey: m.market,
              bestBook: m.best_book || "", bestOdds, noVigOdds: m.no_vig_odds || null
            });
            const sel = slip.some(s => s.key === k), hot = (m.prob || 0) >= 60;
            const bookSub = m.best_book ? ` • ${m.best_book} ${fmtAmerican(bestOdds)}` : (isAlt && m.fair_odds ? ` • ${m.fair_odds}` : "");
            const nvSub = m.no_vig_odds ? `NV ${fmtAmerican(m.no_vig_odds)}` : (m.hit_str || "");
            return `<button class="p-btn ${sel ? "selected" : ""} ${hot ? "hot" : ""} ${isAlt ? "alt-btn" : ""}" data-key="${escHtml(k)}" onclick="toggleSlipByKey(this.dataset.key)">
              <div>
                <span>${escHtml(m.market)}</span>
                <span class="sim-hint">Sim: ${m.proj ?? "-"}${escHtml(bookSub)}</span>
              </div>
              <div class="prob-val">
                <span>${m.prob ?? 50}%</span>
                ${nvSub ? `<span class="hit-mini">${escHtml(nvSub)}</span>` : ""}
              </div>
            </button>`;
          }).join("")}
        </div>
      </article>`;
    }).join("");
    return;
  }

  if (activeHub === "nba" && nbaSubView === "games") {
    renderGameCards(nbaGames, "nbagame", "nbagame", nbaGamesFilter, q, filter, listEl, moreBtn);
  } else if (activeHub === "ncaa") {
    renderGameCards(ncaaGames, "ncaa", "ncaa", ncaaFilter, q, filter, listEl, moreBtn);
  }
}

function formatEasternTimestamp(rawTs) {
  if (!rawTs || rawTs === "Live") return "Live (ET)";
  const str = String(rawTs).trim();
  const m = str.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*UTC$/i);
  if (m) {
    const yr = new Date().getUTCFullYear();
    const utcDate = new Date(`${m[1]} ${m[2]}, ${yr} ${m[3].padStart(2, "0")}:${m[4]}:00 UTC`);
    if (!isNaN(utcDate.getTime())) {
      return utcDate.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }) + " ET";
    }
  }
  return /\bET\b/i.test(str) ? str : `${str} ET`;
}

async function loadAllData(force = false) {
  importFromPhoneUrl();
  const savedBr = localStorage.getItem(BANKROLL_KEY);
  if (savedBr && document.getElementById("bankrollInput")) document.getElementById("bankrollInput").value = savedBr;

  const savedBk = localStorage.getItem(BOOK_KEY);
  if (savedBk && document.getElementById("sportsbookSelect")) document.getElementById("sportsbookSelect").value = savedBk;

  const bust = force ? `?t=${Date.now()}` : `?t=${Math.floor(Date.now() / 60000)}`;
  setText("syncText", "Syncing...");
  setText("betsCount", trackedBets.length);
  setText("bBetsCount", trackedBets.length);

  const openBetsTab = new URLSearchParams(window.location.search).get("tab") === "bets";
  if (openBetsTab) switchHub("bets");
  else if (trackedBets.some(b => b.pinned && b.status !== "won" && b.status !== "lost")) {
    refreshTrackedBets();
    startLivePoller();
  }

  let anyLoaded = false;

  try {
    const [ncaaRes, nbaRes, nbaGamesRes] = await Promise.allSettled([
      fetch(NCAA_JSON_URL + bust),
      fetch(NBA_JSON_URL + bust),
      fetch(NBA_GAMES_JSON_URL + bust)
    ]);

    if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) {
      const d = await ncaaRes.value.json();
      if (Array.isArray(d)) {
        ncaaGames = d;
        anyLoaded = true;
      }
    }
    if (nbaRes.status === "fulfilled" && nbaRes.value.ok) {
      const d = await nbaRes.value.json();
      if (Array.isArray(d)) {
        const seenP = new Set();
        nbaPlayers = d.filter(x => {
          if (!x || !x.player) return false;
          const k = `${x.game_id}-${x.id || x.player}`;
          if (seenP.has(k)) return false;
          seenP.add(k);
          return true;
        });
        anyLoaded = true;
      }
    }
    if (nbaGamesRes.status === "fulfilled" && nbaGamesRes.value.ok) {
      const d = await nbaGamesRes.value.json();
      if (Array.isArray(d)) {
        nbaGames = d;
        anyLoaded = true;
      }
    }

    setText("ncaaCount", ncaaGames.length);
    setText("bNcaaCount", ncaaGames.length);
    setText("nbaCount", nbaPlayers.length);
    setText("nbaGamesCount", nbaGames.length);
    setText("nbaHubCount", nbaPlayers.length + nbaGames.length);
    setText("bNbaCount", nbaPlayers.length + nbaGames.length);

    const ts = nbaGames[0]?.generated_at || ncaaGames[0]?.generated_at || nbaPlayers[0]?.generated_at || "Live";
    setText("syncText", anyLoaded ? `Synced • ${formatEasternTimestamp(ts)}` : "Offline cache");
  } catch (e) {
    console.warn("SimLab fetch warning:", e);
    setText("syncText", "Offline cache");
  }

  try {
    buildEvBoard();
    buildTopParlay();
    if (!openBetsTab) switchHub(activeHub);
  } catch (err) {
    console.warn("SimLab render warning:", err);
  }
}

loadAllData();
