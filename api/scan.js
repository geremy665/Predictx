// EDGE — api/scan.js v4
// Vrais matchs + vraies cotes bookmakers

const LEAGUES = new Set([61,140,39,135,78,2,3,94,88,144,203,179,848]);
const DONE    = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE    = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);
const FLAG    = {61:"FR",140:"ES",39:"ENG",135:"IT",78:"DE",2:"UCL",3:"UEL",94:"PT",88:"NL",144:"BE",203:"TR",179:"SCO",848:"UEL"};

async function apiFetch(url, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) { return null; }
}

async function getOdds(fixtureId, key) {
  try {
    const data = await apiFetch(`/odds?fixture=${fixtureId}&bookmaker=6`, key);
    if (!data || !data.length) return null;
    const bets = data[0]?.bookmakers?.[0]?.bets || [];
    
    const result = {};
    
    // 1X2
    const mw = bets.find(b => b.id === 1 || b.name === "Match Winner");
    if (mw?.values) {
      const h = mw.values.find(v => v.value === "Home");
      const d = mw.values.find(v => v.value === "Draw");
      const a = mw.values.find(v => v.value === "Away");
      if (h) result.o1 = parseFloat(h.odd);
      if (d) result.on = parseFloat(d.odd);
      if (a) result.o2 = parseFloat(a.odd);
    }

    // Double chance
    const dc = bets.find(b => b.id === 12 || b.name === "Double Chance");
    if (dc?.values) {
      const hd = dc.values.find(v => v.value === "Home/Draw");
      const ha = dc.values.find(v => v.value === "Home/Away");
      const da = dc.values.find(v => v.value === "Draw/Away");
      if (hd) result.dc1x = parseFloat(hd.odd);
      if (ha) result.dc12 = parseFloat(ha.odd);
      if (da) result.dcx2 = parseFloat(da.odd);
    }

    // Over/Under
    const ou = bets.find(b => b.id === 3 || b.name === "Goals Over/Under");
    if (ou?.values) {
      ou.values.forEach(v => {
        const m = v.value.match(/(Over|Under)\s+([\d.]+)/i);
        if (!m) return;
        const key2 = (m[1].toLowerCase() === "over" ? "over" : "under") + 
                     m[2].replace(".", "_");
        result[key2] = parseFloat(v.odd);
      });
    }

    // BTTS
    const btts = bets.find(b => b.id === 5 || b.name === "Both Teams Score");
    if (btts?.values) {
      const y = btts.values.find(v => v.value === "Yes");
      const n = btts.values.find(v => v.value === "No");
      if (y) result.bttsY = parseFloat(y.odd);
      if (n) result.bttsN = parseFloat(n.odd);
    }

    // HT
    const ht = bets.find(b => b.id === 8 || b.name === "HT Result");
    if (ht?.values) {
      const h = ht.values.find(v => v.value === "Home");
      const d = ht.values.find(v => v.value === "Draw");
      const a = ht.values.find(v => v.value === "Away");
      if (h) result.ht1 = parseFloat(h.odd);
      if (d) result.htN = parseFloat(d.odd);
      if (a) result.ht2 = parseFloat(a.odd);
    }

    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=360");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  try {
    const now  = new Date();
    const days = [0,1,2,3].map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    // Fetch fixtures 4 jours
    const results = await Promise.all(days.map(d => apiFetch(`/fixtures?date=${d}`, KEY)));
    const all = results.flat().filter(Boolean)
      .filter(f => LEAGUES.has(f.league?.id))
      .filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    // Fetch cotes pour chaque match (par batch de 5)
    const BATCH = 5;
    const matches = [];
    
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      const oddsArr = await Promise.all(
        batch.map(f => {
          const st = f.fixture?.status?.short || "NS";
          // Pas de cotes pour les matchs live
          if (LIVE.has(st)) return Promise.resolve(null);
          return getOdds(f.fixture?.id, KEY);
        })
      );

      batch.forEach((f, j) => {
        const st   = f.fixture?.status?.short || "NS";
        const odds = oddsArr[j] || {};
        const o1   = odds.o1 || 1.90;
        const on   = odds.on || 3.40;
        const o2   = odds.o2 || 3.80;

        // xG depuis cotes
        const mg  = 1/o1 + 1/on + 1/o2;
        const p1  = (1/o1)/mg, p2 = (1/o2)/mg;
        const hxg = +(1.3 + p1*1.0).toFixed(2);
        const axg = +(1.3 + p2*1.0).toFixed(2);

        matches.push({
          id:         f.fixture?.id,
          leagueName: f.league?.name || "",
          leagueId:   f.league?.id,
          c:          f.league?.name || "",
          f:          FLAG[f.league?.id] || "INT",
          home:       f.teams?.home?.name || "",
          away:       f.teams?.away?.name || "",
          h:          f.teams?.home?.name || "",
          a:          f.teams?.away?.name || "",
          homeId:     f.teams?.home?.id,
          awayId:     f.teams?.away?.id,
          time:       f.fixture?.date || "",
          t:          f.fixture?.date || "",
          status:     st,
          isLive:     LIVE.has(st),
          // Cotes 1X2
          o1, on, o2,
          hasRealOdds: !!(odds.o1),
          // Double chance
          dc1x: odds.dc1x || null,
          dc12: odds.dc12 || null,
          dcx2: odds.dcx2 || null,
          // Over/Under
          over15:  odds.over1_5  || null,
          under15: odds.under1_5 || null,
          over25:  odds.over2_5  || null,
          under25: odds.under2_5 || null,
          over35:  odds.over3_5  || null,
          under35: odds.under3_5 || null,
          // BTTS
          bttsY: odds.bttsY || null,
          bttsN: odds.bttsN || null,
          // HT
          ht1: odds.ht1 || null,
          htN: odds.htN || null,
          ht2: odds.ht2 || null,
          // Stats
          hxg, axg,
          hxga: +(axg*0.85).toFixed(2),
          axga: +(hxg*0.85).toFixed(2),
          hg:   +(hxg*0.90).toFixed(2),
          ag:   +(axg*0.90).toFixed(2),
          hf:   Math.round(p1*15),
          af:   Math.round(p2*15),
          hsh:  Math.round(hxg*2.8),
          ash:  Math.round(axg*2.8),
          hcs:  Math.round(p1*35),
          acs:  Math.round(p2*35),
          h2h:  []
        });
      });
    }

    matches.sort((a,b) => {
      if(a.isLive && !b.isLive) return -1;
      if(!a.isLive && b.isLive) return 1;
      return (a.time||"") < (b.time||"") ? -1 : 1;
    });

    return res.status(200).json({
      matches,
      count:       matches.length,
      withOdds:    matches.filter(m => m.hasRealOdds).length,
      updated:     now.toISOString(),
      source:      "EDGE Scan v4"
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
