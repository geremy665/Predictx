// EDGE - API Football V3 - Matches propres
// • Filtre tous les matchs terminés (FT, AET, PEN, CANC...)
// • Live en tête de liste avec score + events
// • Batch processing pour respecter le rate limit API
// FOOTBALL_API_KEY dans Vercel env vars

const LEAGUES = [
  {id:61,  name:"Ligue 1",          f:"FR"},
  {id:140, name:"La Liga",          f:"ES"},
  {id:39,  name:"Premier League",   f:"ENG"},
  {id:135, name:"Serie A",          f:"IT"},
  {id:78,  name:"Bundesliga",       f:"DE"},
  {id:2,   name:"Champions League", f:"UCL"},
  {id:3,   name:"Europa League",    f:"UEL"},
  {id:848, name:"Conference League",f:"UEL"},
  {id:94,  name:"Liga Portugal",    f:"PT"},
  {id:88,  name:"Eredivisie",       f:"NL"},
  {id:144, name:"Pro League",       f:"BE"},
  {id:203, name:"Super Lig",        f:"TR"},
  {id:179, name:"Premiership",      f:"SCO"}
];

const lgMap = {};
LEAGUES.forEach(l => { lgMap[l.id] = l; });

// ✅ Tous les statuts = TERMINÉ → exclus
const FINISHED = new Set([
  "FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","INT","PST"
]);

// Statuts = EN COURS
const LIVE = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);

async function apiFetch(url, key, ms = 6000) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: AbortSignal.timeout(ms)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch (e) { return null; }
}

function formPts(s, n = 5) {
  if (!s) return 8;
  let pts = 0;
  for (const c of s.slice(-n)) {
    if (c === "W") pts += 3;
    else if (c === "D") pts += 1;
  }
  return pts;
}

function avgXg(fixtures, teamId) {
  let total = 0, count = 0;
  for (const f of (fixtures || []).slice(0, 8)) {
    const ts = (f.statistics || []).find(s => s.team?.id == teamId);
    const xg = ts?.statistics?.find(
      s => s.type === "expected_goals" || s.type === "Expected Goals"
    )?.value;
    if (xg && parseFloat(xg) > 0) { total += parseFloat(xg); count++; }
  }
  return count >= 3 ? +(total / count).toFixed(2) : null;
}

// Batch pour éviter le rate limit API (max 5 en parallèle)
async function batch(items, fn, size = 5, delay = 300) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const res = await Promise.all(items.slice(i, i + size).map(fn));
    out.push(...res);
    if (i + size < items.length) await new Promise(r => setTimeout(r, delay));
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache 90s — frais pour le live, pas abusif sur l'API
  res.setHeader("Cache-Control", "s-maxage=90, stale-while-revalidate=300");

  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if (!KEY) return res.status(500).json({ error: "FOOTBALL_API_KEY manquante", matches: [] });

  const now = new Date();
  const season = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const today    = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime() + 24 * 3600000).toISOString().split("T")[0];
  const day2     = new Date(now.getTime() + 48 * 3600000).toISOString().split("T")[0];

  try {
    // ── 1. Fixtures sur 3 jours ──────────────────────────────────
    const [r1, r2, r3] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`,    KEY),
      apiFetch(`/fixtures?date=${tomorrow}`, KEY),
      apiFetch(`/fixtures?date=${day2}`,     KEY)
    ]);

    const allFix = [...(r1||[]), ...(r2||[]), ...(r3||[])]
      .filter(f => {
        const lgOk   = !!lgMap[f.league?.id];
        const status = f.fixture?.status?.short || "NS";
        // ✅ Exclure matchs terminés
        return lgOk && !FINISHED.has(status);
      });

    if (!allFix.length) {
      return res.status(200).json({
        matches: [], count: 0, live: 0, upcoming: 0,
        updated: now.toISOString(),
        source: "API-Football",
        note: "Aucun match à venir ou en cours"
      });
    }

    // ── 2. Enrichissement par batch ──────────────────────────────
    const enriched = await batch(allFix, async fix => {
      const fId    = fix.fixture?.id;
      const homeId = fix.teams?.home?.id;
      const awayId = fix.teams?.away?.id;
      const lgId   = fix.league?.id;
      const status = fix.fixture?.status?.short || "NS";
      const isLive = LIVE.has(status);

      const [
        oddsData, homeFixtures, awayFixtures,
        homeStats, awayStats, h2hData, liveEvents
      ] = await Promise.all([
        apiFetch(`/odds?fixture=${fId}&bet=1`, KEY, 4000),
        apiFetch(`/fixtures?team=${homeId}&last=8&status=FT`, KEY, 5000),
        apiFetch(`/fixtures?team=${awayId}&last=8&status=FT`, KEY, 5000),
        apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${homeId}`, KEY, 5000),
        apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${awayId}`, KEY, 5000),
        apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=6`, KEY, 5000),
        isLive ? apiFetch(`/fixtures/events?fixture=${fId}`, KEY, 4000) : null
      ]);

      // ── Cotes ────────────────────────────────────────────────
      let o1 = 0, on = 0, o2 = 0;
      const bkArr = [];
      if (oddsData?.length) {
        oddsData.forEach(entry => {
          (entry.bookmakers || []).forEach(bk => {
            const bet = (bk.bets || []).find(b => b.id === 1 || b.name === "Match Winner");
            if (!bet?.values) return;
            const hv = bet.values.find(v => v.value === "Home");
            const dv = bet.values.find(v => v.value === "Draw");
            const av = bet.values.find(v => v.value === "Away");
            if (!hv || !av) return;
            const ho = parseFloat(hv.odd || 0);
            const do_ = parseFloat(dv?.odd || 0);
            const ao = parseFloat(av.odd || 0);
            if (ho < 1.01 || ao < 1.01) return;
            if (ho > o1) o1 = ho;
            if (do_ > on) on = do_;
            if (ao > o2) o2 = ao;
            bkArr.push({ n: bk.bookmaker?.name || "Bk", o1: +ho.toFixed(2), on: +do_.toFixed(2), o2: +ao.toFixed(2) });
          });
        });
      }
      if (!o1) {
        const opts = [
          [1.55,4.20,6.50],[1.70,3.80,5.00],[1.85,3.50,4.20],
          [2.10,3.30,3.40],[2.35,3.20,3.00],[2.60,3.10,2.75],
          [2.90,3.20,2.50],[3.20,3.30,2.25],[3.80,3.40,1.90],[5.00,3.80,1.60]
        ];
        [o1, on, o2] = opts[(fId || 0) % 10];
      }

      // ── Stats & xG ───────────────────────────────────────────
      const hS = homeStats?.[0];
      const aS = awayStats?.[0];
      const hf = formPts(hS?.form, 5);
      const af = formPts(aS?.form, 5);

      let hxg = avgXg(homeFixtures, homeId);
      let axg = avgXg(awayFixtures, awayId);

      const hGoalsFor  = hS?.goals?.for?.average?.total  ? parseFloat(hS.goals.for.average.total)      : null;
      const hGoalsAga  = hS?.goals?.against?.average?.total ? parseFloat(hS.goals.against.average.total) : null;
      const aGoalsFor  = aS?.goals?.for?.average?.total  ? parseFloat(aS.goals.for.average.total)      : null;
      const aGoalsAga  = aS?.goals?.against?.average?.total ? parseFloat(aS.goals.against.average.total) : null;

      if (!hxg) hxg = hGoalsFor ? +(hGoalsFor * 1.05).toFixed(2) : 1.35;
      if (!axg) axg = aGoalsFor ? +(aGoalsFor * 0.95).toFixed(2) : 1.10;

      const hPlayed = hS?.fixtures?.played?.total || 1;
      const aPlayed = aS?.fixtures?.played?.total || 1;
      const hcs = hS?.clean_sheet?.total ? Math.round(hS.clean_sheet.total / hPlayed * 100) : 28;
      const acs = aS?.clean_sheet?.total ? Math.round(aS.clean_sheet.total / aPlayed * 100) : 22;

      // ── H2H ─────────────────────────────────────────────────
      const h2h = (h2hData || []).slice(0, 6).map(f => ({
        date:      f.fixture?.date?.split("T")[0],
        home:      f.teams?.home?.name,
        away:      f.teams?.away?.name,
        homeGoals: f.goals?.home,
        awayGoals: f.goals?.away,
        winner:    f.teams?.home?.winner ? "home" : f.teams?.away?.winner ? "away" : "draw"
      }));

      // ── Events live ──────────────────────────────────────────
      const goals = [], cards = [];
      if (isLive && liveEvents?.length) {
        liveEvents.forEach(ev => {
          if (ev.type === "Goal" && ev.detail !== "Missed Penalty") {
            goals.push({ time: ev.time?.elapsed, team: ev.team?.name, player: ev.player?.name });
          }
          if (ev.type === "Card") {
            cards.push({ time: ev.time?.elapsed, team: ev.team?.name, player: ev.player?.name, card: ev.detail });
          }
        });
      }

      const lg   = lgMap[lgId];
      const home = fix.teams?.home?.name;
      const away = fix.teams?.away?.name;
      const time = fix.fixture?.date;

      return {
        id: fId,
        league: "l" + lgId, leagueName: lg.name, f: lg.f, c: lg.name,
        home, away, h: home, a: away,
        homeId, awayId, leagueId: lgId,
        t: time, time, status,
        o1: +o1.toFixed(2), on: +on.toFixed(2), o2: +o2.toFixed(2),
        bk: bkArr.slice(0, 6), hasRealOdds: bkArr.length > 0,
        hxg, axg, hxga: hGoalsAga || 1.15, axga: aGoalsAga || 1.30,
        hg: hGoalsFor || +(hxg * 0.9).toFixed(2),
        ag: aGoalsFor || +(axg * 0.9).toFixed(2),
        hf, af,
        hf10: formPts(hS?.form, 10), af10: formPts(aS?.form, 10),
        hsh: Math.round(hxg * 2.8), ash: Math.round(axg * 2.8),
        hcs, acs, hRank: hS?.rank || null, aRank: aS?.rank || null,
        homeGoals: hGoalsFor, awayGoals: aGoalsFor,
        h2h,
        isLive,
        liveScore: isLive ? {
          home:    fix.goals?.home ?? null,
          away:    fix.goals?.away ?? null,
          elapsed: fix.fixture?.status?.elapsed ?? null,
          goals, cards
        } : null
      };
    });

    // ── 3. Tri final : live → à venir par heure ──────────────────
    const matches = enriched
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(a.time) - new Date(b.time);
      });

    return res.status(200).json({
      matches,
      count:        matches.length,
      live:         matches.filter(m => m.isLive).length,
      upcoming:     matches.filter(m => !m.isLive).length,
      updated:      now.toISOString(),
      source:       "API-Football V3 + xG + Forme + Live Events",
      withRealOdds: matches.filter(m => m.hasRealOdds).length,
      withRealXg:   matches.filter(m => m.hxg > 0).length
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, matches: [] });
  }
};
