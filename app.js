const GITHUB_USER = "RockoDevXda";
const NCAA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/ncaa-sim/main/daily_slate.json`;
const NBA_JSON_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/nba-props-sim/main/nba_props_slate.json`;
const STORAGE_KEY = "simlab_tracked_bets_v1";
const WATCH_KEY = "simlab_watchlist_v1";

let activeSport = "nba", subFilter = "ALL", ncaaFilter = "ALL", visibleLimit = 25;
let ncaaGames = [], nbaPlayers = [], topParlayLegs = [], slip = [], pickRegistry = {};
let activePropByPlayer = {};
let watchlist = loadWatchlist();
let trackedBets = loadStoredBets(), livePollTimer = null, deferredPrompt = null;

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
function loadStoredBets() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch (e) { return []; }
}
function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"); } catch (e) { return []; }
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

function switchSport(sport) {
  activeSport = sport;
  visibleLimit = 25;
  document.getElementById("tabNba").className = sport === "nba" ? "tab active-nba" : "tab";
  document.getElementById("tabNcaa").className = sport === "ncaa" ? "tab active-ncaa" : "tab";
  document.getElementById("tabBets").className = sport === "bets" ? "tab active-bets" : "tab";
  document.getElementById("marketControls").style.display = sport === "bets" ? "none" : "block";
  document.getElementById("betsControls").style.display = sport === "bets" ? "block" : "none";
  document.getElementById("nbaChips").style.display = sport === "nba" ? "flex" : "none";
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
function setSubFilter(val, btn) { subFilter = val; visibleLimit = 25; document.querySelectorAll("#nbaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function setNcaaFilter(val, btn) { ncaaFilter = val; visibleLimit = 25; document.querySelectorAll("#ncaaChips .f-chip").forEach(c => c.classList.remove("active")); btn.classList.add("active"); render(); }
function resetAndRender() { visibleLimit = 25; render(); }
function showMore() { visibleLimit += 25; render(); }
function registerPick(key, label, prob, meta) { pickRegistry[key] = { key, label, prob, meta }; }

function toggleSlipByKey(key) {
  const pick = pickRegistry[key];
  if (pick?.meta?.sport === "nba" && pick.meta.playerId) {
    activePropByPlayer[String(pick.meta.playerId)] = pick.meta.stat;
  }
  const idx = slip.findIndex(s => s.key === key);
  if (idx !== -1) slip.splice(idx, 1);
  else if (pick) slip.push({ ...pick });
  updateSlipUI();
  render();
}
function clearSlip() { slip = []; updateSlipUI(); render(); }
function loadTopParlay() { if (!topParlayLegs.length) return; slip = topParlayLegs.map(x => ({ ...x })); updateSlipUI(); render(); }

function copySlipText() {
  if (!slip.length) return;
  let comb = 1.0;
  slip.forEach(s => { comb *= (s.prob / 100); });
  const pct = +(comb * 100).toFixed(1);
  const lines = [`🎯 SimLab ${slip.length}-Leg Parlay (${pct}% | Fair ${probToAmerican(pct)}):`, ...slip.map((s, i) => `${i + 1}. ${s.label} (${s.prob}%)`)].join("\n");
  if (navigator.clipboard) navigator.clipboard.writeText(lines).then(() => { const b = document.getElementById("copySlipBtn"); b.textContent = "✓"; setTimeout(() => { b.textContent = "📋"; }, 1600); });
}

function updateSlipUI() {
  const has = slip.length > 0;
  document.body.classList.toggle("has-slip", has);
  if (!has) return;
  const stake = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const estPayout = +(stake * Math.pow(1.909, slip.length)).toFixed(2);
  document.getElementById("slipCount").textContent = slip.length;
  document.getElementById("slipPayout").textContent = `→ $${estPayout}`;
  document.getElementById("slipChips").innerHTML = slip.map(s => `<div class="s-chip">${escHtml(s.label)} (${s.prob}%) <span data-key="${escHtml(s.key)}" onclick="toggleSlipByKey(this.dataset.key)">×</span></div>`).join("");
}

function saveTrackedBet() {
  if (!slip.length) return;
  const stake = Math.max(1, parseFloat(document.getElementById("stakeInput").value) || 25);
  const payout = +(stake * Math.pow(1.909, slip.length)).toFixed(2);
  const todayIso = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  trackedBets.unshift({
    id: "bet-" + Date.now(),
    createdAt: new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    dateStr: todayIso, stake, payout, status: "pending",
    legs: slip.map(s => ({ key: s.key, label: s.label, prob: s.prob, meta: s.meta || {}, status: "pending", liveScore: "Scheduled", currentVal: 0, targetVal: s.meta?.line || 0, clock: "" }))
  });
  persistBets();
  slip = [];
  updateSlipUI();
  switchSport("bets");
}

function deleteTrackedBet(betId) {
  trackedBets = trackedBets.filter(b => b.id !== betId);
  persistBets();
  renderBetsTab();
}

function buildTopParlay() {
  const legs = [], usedGames = new Set();
  const sortedNba = [...nbaPlayers].sort((a, b) => (b.best_prop?.prob || 0) - (a.best_prop?.prob || 0));
  for (const p of sortedNba) {
    if (legs.length >= 2) break;
    const gKey = p.game_id || `${p.team}-${p.opponent}`;
    if (!usedGames.has(gKey) && p.best_prop) {
      const k = `nba-${p.id}-${p.best_prop.stat}`;
      const leg = { key: k, label: `${p.player} ${p.best_prop.market}`, prob: p.best_prop.prob, meta: { sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player, stat: p.best_prop.stat, side: p.best_prop.side || "O", line: p.best_prop.line } };
      registerPick(k, leg.label, leg.prob, leg.meta);
      legs.push(leg);
      usedGames.add(gKey);
    }
  }
  const sortedNcaa = [...ncaaGames].filter(g => g.has_line && g.verified_d1 !== false && Math.abs(g.home_spread || 0) <= 24.5).sort((a, b) => (b.spread_cover_pct || 0) - (a.spread_cover_pct || 0));
  for (const g of sortedNcaa) {
    if (legs.length >= 3) break;
    const k = `ncaa-${g.id}-ats`;
    const leg = { key: k, label: g.spread_pick, prob: g.spread_cover_pct, meta: { sport: "ncaa", betType: "ats", gameId: g.id, awayShort: g.away_short, homeShort: g.home_short, pickText: g.spread_pick } };
    registerPick(k, leg.label, leg.prob, leg.meta);
    legs.push(leg);
  }
  const topTot = [...ncaaGames].filter(g => g.has_total && g.verified_d1 !== false && (g.total_edge_pts || 0) <= 14.0).sort((a, b) => (b.total_cover_pct || 0) - (a.total_cover_pct || 0))[0];
  if (topTot && legs.length < 4) {
    const k = `ncaa-${topTot.id}-tot`;
    const leg = { key: k, label: `${topTot.away_short}/${topTot.home_short} ${topTot.total_pick}`, prob: topTot.total_cover_pct, meta: { sport: "ncaa", betType: "total", gameId: topTot.id, awayShort: topTot.away_short, homeShort: topTot.home_short, side: (topTot.total_pick || "").startsWith("U") ? "U" : "O", line: topTot.over_under } };
    registerPick(k, leg.label, leg.prob, leg.meta);
    legs.push(leg);
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
          if (state === "pre") { leg.status = "pending"; leg.liveScore = `0 / ${m.line} ${m.stat}`; }
          else {
            if (!nbaBoxCache[gid]) { try { const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${gid}`); if (r.ok) nbaBoxCache[gid] = await r.json(); } catch (e) {} }
            const val = extractNbaPlayerStat(nbaBoxCache[gid], String(m.playerId || ""), m.playerName, m.stat);
            leg.currentVal = val; leg.targetVal = m.line; leg.liveScore = `${val} / ${m.line} ${m.stat}`;
            leg.status = state === "post" ? (val > m.line ? "hit" : "miss") : (val > m.line ? "hit" : "live");
          }
        } else if (m.sport === "ncaa" && gid && ncaaEvents[gid]) {
          const ev = ncaaEvents[gid], state = ev.status?.type?.state || "pre", detail = ev.status?.type?.shortDetail || "";
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
    listEl.innerHTML = `<div class="card" style="grid-column:1/-1; text-align:center; padding:24px 16px;"><div style="font-size:0.95rem; font-weight:800; margin-bottom:4px;">No Tracked Bets Yet</div><div style="font-size:0.76rem; color:var(--sub);">Tap any props or spreads in NBA / NCAA, set your stake in the bottom drawer, and tap <strong>📌 Track Bet</strong> to sweat live stats here.</div></div>`;
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
    return `<article class="bet-card ${bet.status}"><div class="c-head"><div><div class="c-name">${bet.legs.length}-Leg ${bet.legs.length === 1 ? "Straight" : "Parlay"} • $${bet.stake} → $${bet.payout}</div><div class="c-meta">Placed ${escHtml(bet.createdAt)}</div></div><div style="display:flex; align-items:center; gap:6px;">${badgeMap[bet.status] || badgeMap.pending}<button class="btn-sm" style="padding:2px 6px; font-size:0.68rem;" data-id="${escHtml(bet.id)}" onclick="deleteTrackedBet(this.dataset.id)">🗑️</button></div></div>${legsHtml}</article>`;
  }).join("");
}

function render() {
  if (activeSport === "bets") { renderBetsTab(); return; }
  const listEl = document.getElementById("cardsList"), moreBtn = document.getElementById("loadMoreBtn");
  const q = document.getElementById("searchInput").value.toLowerCase().trim(), filter = document.getElementById("filterSelect").value;

  if (activeSport === "nba") {
    const sorted = [...nbaPlayers].sort((a, b) => {
      if (["PTS", "REB", "AST", "PRA"].includes(subFilter)) return (b.all_props?.find(x => x.stat === subFilter)?.prob || 0) - (a.all_props?.find(x => x.stat === subFilter)?.prob || 0);
      return (b.best_prop?.prob || 0) - (a.best_prop?.prob || 0);
    });
    const filtered = sorted.filter(p => {
      if (q && !p.player.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q) && !p.opponent.toLowerCase().includes(q)) return false;
      if (subFilter === "WATCH" && !watchlist.includes(String(p.id))) return false;
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
      const selectedStat = activePropByPlayer[pidStr] || (["PTS", "REB", "AST", "PRA"].includes(subFilter) ? subFilter : null);
      const focusProp = (selectedStat && p.all_props?.find(x => x.stat === selectedStat)) || p.best_prop || {};
      const propsToShow = ["PTS", "REB", "AST", "PRA"].includes(subFilter) ? (p.all_props || []).filter(m => m.stat === subFilter) : (p.all_props || []);
      const tagsHtml = (p.tags || []).map(t => `<span class="s-tag ${t.includes("DEF") || t.includes("B2B") ? "cyan" : ""}">${escHtml(t)}</span>`).join("");

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
        <div class="prop-grid" style="${propsToShow.length === 1 ? "grid-template-columns:1fr;" : ""}">
          ${propsToShow.map(m => {
            const k = `nba-${pidStr}-${m.stat}`;
            registerPick(k, `${p.player} ${m.market}`, m.prob, { sport: "nba", gameId: p.game_id, playerId: p.id, playerName: p.player, stat: m.stat, side: m.side || "O", line: m.line });
            const sel = slip.some(s => s.key === k), hot = m.prob >= 60;
            return `<button class="p-btn ${sel ? "selected" : ""} ${hot ? "hot" : ""}" data-key="${escHtml(k)}" onclick="toggleSlipByKey(this.dataset.key)"><div><span>${escHtml(m.market)}</span><span class="sim-hint">Sim: ${m.proj}</span></div><div class="prob-val"><span>${m.prob}%</span>${m.hit_str ? `<span class="hit-mini">${escHtml(m.hit_str)}</span>` : ""}</div></button>`;
          }).join("")}
        </div>
      </article>`;
    }).join("");
  } else {
    const sorted = [...ncaaGames].sort((a, b) => {
      if (ncaaFilter === "TOTALS") return (b.total_cover_pct || 0) - (a.total_cover_pct || 0);
      if (ncaaFilter === "SPREADS") return (b.spread_cover_pct || 0) - (a.spread_cover_pct || 0);
      if (ncaaFilter === "MOVES") return (Math.abs(b.spread_move || 0) + Math.abs(b.total_move || 0)) - (Math.abs(a.spread_move || 0) + Math.abs(a.total_move || 0));
      return Math.max(b.spread_cover_pct || 0, b.total_cover_pct || 0) - Math.max(a.spread_cover_pct || 0, a.total_cover_pct || 0);
    });
    const filtered = sorted.filter(g => {
      if (q && !g.away_team.toLowerCase().includes(q) && !g.home_team.toLowerCase().includes(q)) return false;
      if (ncaaFilter === "MOVES" && !g.has_move) return false;
      if (ncaaFilter === "TOTALS" && !g.has_total) return false;
      if (ncaaFilter === "SPREADS" && !g.has_line) return false;
      if (filter === "edge" && (g.spread_cover_pct || 0) < 57 && (g.total_cover_pct || 0) < 57) return false;
      if (filter === "slip" && !slip.some(s => s.key.startsWith(`ncaa-${g.id}`))) return false;
      return true;
    });
    const slice = filtered.slice(0, visibleLimit);
    moreBtn.style.display = filtered.length > visibleLimit ? "block" : "none";
    moreBtn.textContent = `Show More (${filtered.length - visibleLimit} remaining)`;
    listEl.innerHTML = slice.map(g => {
      const atsKey = `ncaa-${g.id}-ats`, totKey = `ncaa-${g.id}-tot`, mlKey = `ncaa-${g.id}-ml`;
      if (g.has_line) registerPick(atsKey, g.spread_pick, g.spread_cover_pct, { sport: "ncaa", betType: "ats", gameId: g.id, awayShort: g.away_short, homeShort: g.home_short, pickText: g.spread_pick });
      if (g.has_total) registerPick(totKey, `${g.away_short}/${g.home_short} ${g.total_pick}`, g.total_cover_pct, { sport: "ncaa", betType: "total", gameId: g.id, awayShort: g.away_short, homeShort: g.home_short, side: (g.total_pick || "").startsWith("U") ? "U" : "O", line: g.over_under });
      registerPick(mlKey, `${g.favored_team} ML`, g.favored_prob, { sport: "ncaa", betType: "ml", gameId: g.id, awayShort: g.away_short, homeShort: g.home_short, favoredTeam: g.favored_team });
      const atsSel = slip.some(s => s.key === atsKey), totSel = slip.some(s => s.key === totKey), mlSel = slip.some(s => s.key === mlKey);
      const simTotal = g.total_proj || +(g.away_proj + g.home_proj).toFixed(1);
      const moveTags = (g.move_badges || []).map(b => `<span class="s-tag cyan">${escHtml(b)}</span>`).join("");
      return `<article class="card ${(atsSel || totSel || mlSel) ? "in-slip" : ""}"><div class="c-head"><div><div class="c-name">${escHtml(g.away_short)} @ ${escHtml(g.home_short)}</div><div class="c-meta">${escHtml(g.tipoff || "")} • ${escHtml(g.market_line || "PK")}${g.has_total ? ` • O/U ${g.over_under}` : ""}</div>${moveTags ? `<div class="sharp-tags">${moveTags}</div>` : ""}</div>${g.has_line ? `<span class="edge-tag">+${g.edge_pts} ATS</span>` : ""}</div><div class="ncaa-scores"><span><strong>${escHtml(g.away_short)}</strong> ${g.away_proj} • <strong>${escHtml(g.home_short)}</strong> ${g.home_proj}</span><span style="color:var(--cyan); font-weight:700;">Tot: ${simTotal}</span></div><div class="ncaa-grid">${g.has_line ? `<button class="p-btn ${atsSel ? "selected" : ""} ${g.spread_cover_pct >= 58 ? "hot" : ""}" data-key="${escHtml(atsKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.spread_pick)}</span><span class="prob-val">${g.spread_cover_pct}%</span></button>` : `<button class="p-btn" disabled><span>No Line</span></button>`}${g.has_total ? `<button class="p-btn ${totSel ? "selected" : ""} ${g.total_cover_pct >= 58 ? "hot" : ""}" data-key="${escHtml(totKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.total_pick)}</span><span class="prob-val">${g.total_cover_pct}%</span></button>` : `<button class="p-btn" disabled><span>No O/U</span></button>`}<button class="p-btn ${mlSel ? "selected" : ""} ${g.favored_prob >= 70 ? "hot" : ""}" data-key="${escHtml(mlKey)}" onclick="toggleSlipByKey(this.dataset.key)"><span>${escHtml(g.favored_team)} ML</span><span class="prob-val">${g.favored_prob}%</span></button></div></article>`;
    }).join("");
  }
}

async function loadAllData(force = false) {
  const bust = force ? `?t=${Date.now()}` : `?t=${Math.floor(Date.now() / 60000)}`;
  document.getElementById("syncText").textContent = "Syncing...";
  document.getElementById("betsCount").textContent = trackedBets.length;
  try {
    const [ncaaRes, nbaRes] = await Promise.allSettled([fetch(NCAA_JSON_URL + bust), fetch(NBA_JSON_URL + bust)]);
    if (ncaaRes.status === "fulfilled" && ncaaRes.value.ok) ncaaGames = await ncaaRes.value.json();
    if (nbaRes.status === "fulfilled" && nbaRes.value.ok) nbaPlayers = await nbaRes.value.json();
    document.getElementById("ncaaCount").textContent = ncaaGames.length;
    document.getElementById("nbaCount").textContent = nbaPlayers.length;
    const ts = ncaaGames[0]?.generated_at || nbaPlayers[0]?.generated_at || "Live";
    document.getElementById("syncText").textContent = `Synced • ${ts}`;
    buildTopParlay();
    render();
  } catch (e) {
    document.getElementById("syncText").textContent = "Offline cache";
  }
}

loadAllData();
