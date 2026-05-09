// EDGE — api/scan.js
// Récupère les vrais matchs aujourd'hui + demain avec vraies  cotes

const LEAGUES = new Set([61,140,39,135,78,2,3,94,88,144,203,179,848]);
const DONE    = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE    = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);

async function apiFetch(url, key, ms=6000) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) {
    clearTimeout(timer);
    return null;
  }
}

function mapFixture(f, idx) {
  const status = f.fixture?.status?.short || "NS";
  
  // Cotes depuis bookmakers si disponibles
  let o1 = 1.90, on = 3.40, o2 = 3.80;
  if (f.odds?.bookmakers?.length) {
    const bk = f.odds.bookmakers[0];
    const mkt = bk.bets?.find(b => b.name === "Match Winner" || b.id === 1);
    if (mkt?.values?.length >= 3) {
      const vals = mkt.values;
      const home = vals.find(v => v.value === "Home");
      const draw = vals.find(v => v.value === "Draw");
      const away = vals.find(v => v.value === "Away");
      if (home) o1 = parseFloat(home.odd);
      if (draw) on = parseFloat(draw.odd);
      if (away) o2 = parseFloat(away.odd);
    }
  }

  // xG proxy depuis les cotes si pas de stats
  const mg = 1/o1 + 1/on + 1/o2;
  const p1 = (1/o1)/mg, p2 = (1/o2)/mg;
  const hxg = +(1.3 + p1*1.0).toFixed(2);
  const axg = +(1.3 + p2*1.0).toFixed(2);

  return {
    id:         f.fixture?.id,
    leagueName: f.league?.name || "",
    leagueId:   f.league?.id,
    c:          f.league?.name || "",
    f:          f.league?.country || "",
    home:       f.teams?.home?.name || "",
    away:       f.teams?.away?.name || "",
    h:          f.teams?.home?.name || "",
    a:          f.teams?.away?.name || "",
    time:       f.fixture?.date || "",
    status,
    isLive:     LIVE.has(status),
    o1, on, o2,
    hxg, axg,
    hxga: +(axg * 0.85).toFixed(2),
    axga: +(hxg * 0.85).toFixed(2),
    hg:   +(hxg * 0.90).toFixed(2),
    ag:   +(axg * 0.90).toFixed(2),
    hf:   Math.round(p1 * 15),
    af:   Math.round(p2 * 15),
    hsh:  Math.round(hxg * 2.8),
    ash:  Math.round(axg * 2.8),
    hcs:  Math.round(p1 * 35),
    acs:  Math.round(p2 * 35),
    idx
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  if (req.method === "OPTIONS") return res.status(200).end();

  const FKEY = process.env.FOOTBALL_API_KEY || "b0e8adc0dfcca1cc964daa5bfe9a56c1";

  try {
    const now   = new Date();
    const today = now.toISOString().split("T")[0];
    const tom   = new Date(now.getTime() + 86400000).toISOString().split("T")[0];

    // Fetch aujourd'hui + demain en parallèle
    const [fixToday, fixTom] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`, FKEY),
      apiFetch(`/fixtures?date=${tom}`,   FKEY),
    ]);

    const all = [...(fixToday||[]), ...(fixTom||[])];
    
    let idx = 0;
    const matches = all
      .filter(f => LEAGUES.has(f.league?.id))
      .filter(f => !DONE.has(f.fixture?.status?.short || "NS"))
      .map(f => mapFixture(f, idx++))
      .sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return (a.time||"") < (b.time||"") ? -1 : 1;
      });

    return res.status(200).json({
      matches,
      count:    matches.length,
      live:     matches.filter(m => m.isLive).length,
      upcoming: matches.filter(m => !m.isLive).length,
      updated:  now.toISOString(),
      source:   "EDGE Scan v3"
    });

  } catch(e) {
    return res.status(200).json({
      matches: [], count: 0,
      error:   e.message,
      updated: new Date().toISOString()
    });
  }
};
