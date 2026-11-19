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
  btn.textContent = `✓ Copied! Launching ${book.name}...`;
  setTimeout(() => { btn.textContent = "🚀 Copy & Open App"; }, 2400);

  const ua = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);

  setTimeout(() => {
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
  }, 180);
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
        decParlay *= (s.meta?.isAlt && s.meta?.fairOdds) ? americanToDecimal(s.meta
