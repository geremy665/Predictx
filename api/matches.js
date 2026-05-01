// EDGE Scanner — api/matches.js

const LEAGUES = [
  {id:61,  name:"Ligue 1",           f:"FR"},
  {id:140, name:"La Liga",           f:"ES"},
  {id:39,  name:"Premier League",    f:"ENG"},
  {id:135, name:"Serie A",           f:"IT"},
  {id:78,  name:"Bundesliga",        f:"DE"},
  {id:2,   name:"Champions League",  f:"UCL"},
  {id:3,   name:"Europa League",     f:"UEL"},
  {id:848, name:"Conference League", f:"UEL"},
  {id:94,  name:"Liga Portugal",     f:"PT"},
  {id:88,  name:"Eredivisie",        f:"NL"},
  {id:144, name:"Pro League",        f:"BE"},
  {id:203, name:"Super Lig",         f:"TR"},
  {id:179, name:"Premiership",       f:"SCO"}
];

const lgMap = {};
LEAGUES.forEach(l => { lgMap[l.id] = l; });
const lgIds = new Set(LEAGUES.map(l => l.id));

const FINISHED = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","INT","PST"]);
const LIVE_ST  = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);

const DEFAULT_ODDS = [
  [1.55,4.20,6.50],[1.70,3.80,5.00],[1.85,3.50,4.20],
  [2.10,3.30,3.40],[2.35,3.20,3.00],[2.60,3.10,2.75],
  [2.90,3.20,2.50],[3.20,3.30,2.25],[3.80,3.40,1.90],[5.00,3.80,1.60]
];

async function apiFetch(url, key, ms = 8000) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: AbortSignal.timeout(ms)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) { return null; }
}

function formatMatch(f, idx, liveData) {
  const fId    = f.fixture?.id;
  const lgId   = f.league?.id;
  const lg     = lgMap[lgId];
  if (!lg) return null;

  const status = f.fixture?.status?.short || "NS";
  const isLive = LIVE_ST.has(status);
  const home   = f.teams?.home?.name || "";
  const away   = f.teams?.away?.name || "";
  const homeId = f.teams?.home?.id;
  const awayId = f.teams?.away?.id;
  const time   = f.fixture?.date || "";

  const [o1def, ondef, o2def] = DEFAULT_ODDS[(fId || idx) % 10];
  const o1 = f.odds?.o1 || o1def;
  const on = f.odds?.on || ondef;
  const o2 = f.odds?.o2 || o2def;

  const prob1 = 1/o1, prob2 = 1/o2;
  const total = prob1 + (1/on) + prob2;
  const p1 = prob1/total, p2 = prob2/total;
  const hxg = +(1.4 + p1*0.9).toFixed(2);
  const axg = +(1.4 + p2*0.9).toFixed(2);

  const live = liveData?.[fId];
  const goals = [], cards = [];
  if (live?.events) {
    live.events.forEach(ev => {
      if (ev.type === "Goal" && ev.detail !== "Missed Penalty")
        goals.push({ time: ev.time?.elapsed, team: ev.team?.name, player: ev.player?.name });
      if (ev.type === "Card")
        cards.push({ time: ev.time?.elapsed, team: ev.team?.name, player: ev.player?.name, card: ev.detail });
    });
  }

  return {
    id: fId, leagueId: lgId, leagueName: lg.name,
    c: lg.name, f: lg.f, home, away, h: home, a: away,
    homeId, awayId, t: time, time, status, isLive,
    o1: +o1.toFixed(2), on: +on.toFixed(2), o2: +o2.toFixed(2),
    hasRealOdds: !!f.odds, hxg, axg,
    hxga: +(axg*0.85).toFixed(2), axga: +(hxg*0.85).toFixed(2),
    hg: +(hxg*0.92).toFixed(2), ag: +(axg*0.92).toFixed(2),
    hf: Math.round(p1*15), af: Math.round(p2*15),
    hf10: Math.round(p1*25), af10: Math.round(p2*25),
    hsh: Math.round(hxg*2.8), ash: Math.round(axg*2.8),
    hcs: Math.round(p1*35), acs: Math.round(p2*35),
    h2h: [],
    liveScore: isLive ? {
      home:    live?.goals?.home ?? f.goals?.home ?? null,
      away:    live?.goals?.away ?? f.goals?.away ?? null,
      elapsed: live?.elapsed ?? f.fixture?.status?.elapsed ?? null,
      goals, cards
    } : null
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=90, stale-while-revalidate=180");

  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "b0e8adc0dfcca1cc964daa5bfe9a56c1";
  if (!KEY) return res.status(500).json({ error: "Cle API manquante", matches: [] });

  const now      = new Date();
  const today    = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime() + 24*3600000).toISOString().split("T")[0];
  const day2     = new Date(now.getTime() + 48*3600000).toISOString().split("T")[0];

  try {
    const [r1, r2, r3, liveAll] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`,    KEY),
      apiFetch(`/fixtures?date=${tomorrow}`, KEY),
      apiFetch(`/fixtures?date=${day2}`,     KEY),
      apiFetch(`/fixtures?live=all`,         KEY)
    ]);

    const liveMap = {};
    (liveAll || []).forEach(f => {
      if (lgIds.has(f.league?.id)) {
        liveMap[f.fixture?.id] = {
          goals: f.goals,
          elapsed: f.fixture?.status?.elapsed,
          events: []
        };
      }
    });

    const allFix = [...(r1||[]), ...(r2||[]), ...(r3||[])]
      .filter(f => {
        const lgOk   = lgIds.has(f.league?.id);
        const status = f.fixture?.status?.short || "NS";
        return lgOk && !FINISHED.has(status);
      });

    allFix.forEach(f => {
      const fId = f.fixture?.id;
      if (liveMap[fId]) f.goals = liveMap[fId].goals || f.goals;
    });

    if (!allFix.length) {
      return res.status(200).json({
        matches: [], count: 0, live: 0, upcoming: 0,
        updated: now.toISOString(),
        note: "Aucun match en cours ou a venir"
      });
    }

    const matches = allFix
      .map((f, idx) => formatMatch(f, idx, liveMap))
      .filter(Boolean)
      .sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(a.time) - new Date(b.time);
      });

    return res.status(200).json({
      matches,
      count:    matches.length,
      live:     matches.filter(m => m.isLive).length,
      upcoming: matches.filter(m => !m.isLive).length,
      updated:  now.toISOString(),
      source:   "API-Football V3"
    });

  } catch(e) {
    return res.status(500).json({ error: e.message, matches: [] });
  }
};
