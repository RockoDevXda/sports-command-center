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
let openHedgeMap = {};
let hedgeOddsMap = {};
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
  return {
