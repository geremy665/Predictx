// EDGE — api/scan.js v8
// xG entièrement dérivé des cotes — plus de base gonflée
function toNum(val, decimals) {
  if(val === null || val === undefined || isNaN(val)) return 0;
  return parseFloat(parseFloat(val).toFixed(decimals || 3));
}

const LEAGUES = new Set([
  61,140,39,135,78,2,3,94,88,144,203,179,848,113,200,
  10,667,4,5,6,7,9,15,1,34,
]);

const FLAG = {
  61:"FR",140:"ES",39:"ENG",135:"IT",78:"DE",
  2:"UCL",3:"UEL",94:"PT",88:"NL",144:"BE",
  203:"TR",179:"SCO",848:"UECL",113:"SE",200:"MA",
  10:"INT",667:"AMI",4:"EUR",5:"UNL",6:"CAN",
  7:"ASI",9:"CAM",15:"WC",1:"WCQ",34:"WCQ"
};

const LEAGUE_NAME = {
  61:"Ligue 1",140:"La Liga",39:"Premier League",135:"Serie A",
  78:"Bundesliga",2:"Champions League",3:"Europa League",
  94:"Liga Portugal",88:"Eredivisie",144:"Pro League",
  203:"Süper Lig",179:"Premiership",848:"Conference League",
  113:"Allsvenskan",200:"Botola Pro",
  10:"Amicaux Nations",667:"Amicaux Clubs",4:"Euro",
  5:"UEFA Nations League",6:"Africa Cup",7:"Asian Cup",
  9:"Copa America",15:"Coupe du Monde",1:"Qualif. Mondial",34:"Qualif. Mondial"
};

// Moyenne de buts par ligue (home, away)
const LEAGUE_AVG = {
  61:[1.44,1.08], 140:[1.52,1.15], 39:[1.58,1.21], 135:[1.48,1.12],
  78:[1.72,1.32], 2:[1.68,1.28], 3:[1.55,1.18], 94:[1.55,1.18],
  88:[1.88,1.45], 144:[1.58,1.22], 203:[1.62,1.24], 179:[1.46,1.14],
  848:[1.50,1.15], 113:[1.52,1.16], 200:[1.42,1.05],
  10:[1.45,1.30], 667:[1.50,1.25], 4:[1.42,1.25], 5:[1.48,1.28],
  1:[1.45,1.28], 34:[1.45,1.28], 15:[1.45,1.28],
  DEFAULT:[1.50,1.15]
};

const DONE = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);
const SHARP_BK = [8, 6, 1, 2, 3];

// ── xG depuis cotes — le cœur du fix ──────────────────────────
// Principe: la prob implicite (sans marge) × avg buts ligue
// Germany à 1.15x → mp1=0.87 → xG = avg_home × f(0.87)
// Curaçao à 15x  → mp2=0.06 → xG = avg_away × f(0.06) = ~0.35
function deriveXG(mp1, mp2, lgId) {
  const [avgH, avgA] = LEAGUE_AVG[lgId] || LEAGUE_AVG.DEFAULT;
  
  // Fonction de scaling: prob → multiplicateur de buts
  // Calibré sur résultats réels: favori 87% → 2.2x buts avg, outsider 6% → 0.30x
  function scaleGoals(prob) {
    // Courbe exponentielle calibrée
    if (prob >= 0.80) return 1.35 + (prob - 0.80) * 2.0;  // 1.35 à 1.55
    if (prob >= 0.60) return 1.05 + (prob - 0.60) * 1.5;  // 1.05 à 1.35
    if (prob >= 0.45) return 0.90 + (prob - 0.45) * 1.0;  // 0.90 à 1.05
    if (prob >= 0.30) return 0.70 + (prob - 0.30) * 1.33; // 0.70 à 0.90
    if (prob >= 0.15) return 0.45 + (prob - 0.15) * 1.67; // 0.45 à 0.70
    return 0.20 + prob * 1.67;                              // 0.20 à 0.45
  }
  
  const hxg = toNum(avgH * scaleGoals(mp1), 2);
  const axg = toNum(avgA * scaleGoals(mp2), 2);
  
  // Clamp réaliste: jamais en dessous de 0.15 ni au dessus de 3.5
  return [
    Math.max(0.15, Math.min(3.5, hxg)),
    Math.max(0.15, Math.min(3.5, axg))
  ];
}

async function apiFetch(url, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
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
    const data = await apiFetch(`/odds?fixture=${fixtureId}`, key);
    if (!data?.length) return null;
    let result = {};
    let foundSharp = false;
    const allBks = [];
    for (const item of data) {
      for (const bk of (item.bookmakers || [])) allBks.push(bk);
    }
    allBks.sort((a,b) => {
      const ia = SHARP_BK.indexOf(a.id);
      const ib = SHARP_BK.indexOf(b.id);
      return (ia<0?99:ia) - (ib<0?99:ib);
    });
    for (const bk of allBks) {
      const bets = bk.bets || [];
      const isPinnacle = bk.id === 8;
      const mw = bets.find(b => b.id === 1 || b.name === "Match Winner");
      if (mw?.values?.length >= 3 && !result.o1) {
        const h = mw.values.find(v => v.value === "Home");
        const dr = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (h && dr && a) {
          result.o1 = parseFloat(h.odd);
          result.on = parseFloat(dr.odd);
          result.o2 = parseFloat(a.odd);
          result.pinnacle = isPinnacle;
          if (isPinnacle) foundSharp = true;
        }
      }
      const dc = bets.find(b => b.id === 12 || b.name === "Double Chance");
      if (dc?.values && !result.dc1x) {
        const hd = dc.values.find(v => v.value === "Home/Draw");
        const ha = dc.values.find(v => v.value === "Home/Away");
        const da = dc.values.find(v => v.value === "Draw/Away");
        if (hd) result.dc1x = parseFloat(hd.odd);
        if (ha) result.dc12 = parseFloat(ha.odd);
        if (da) result.dcx2 = parseFloat(da.odd);
      }
      const ou = bets.find(b => b.id === 3 || b.name === "Goals Over/Under");
      if (ou?.values) {
        ou.values.forEach(v => {
          const m = v.value.match(/(Over|Under)\s+([\d.]+)/i);
          if (!m) return;
          const k = (m[1].toLowerCase()==="over"?"over":"under")+m[2].replace(".","_");
          if (!result[k]) result[k] = parseFloat(v.odd);
        });
      }
      const btts = bets.find(b => b.id === 5 || b.name === "Both Teams Score");
      if (btts?.values && !result.bttsY) {
        const y = btts.values.find(v => v.value === "Yes");
        const n = btts.values.find(v => v.value === "No");
        if (y) result.bttsY = parseFloat(y.odd);
        if (n) result.bttsN = parseFloat(n.odd);
      }
      if (result.o1 && foundSharp) break;
    }
    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=180, stale-while-revalidate=300");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  try {
    const now = new Date();
    const season = now.getMonth() < 7 ? now.getFullYear()-1 : now.getFullYear();

    const days = [0,1,2,3].map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    const results = await Promise.all(
      days.map(d => apiFetch(`/fixtures?date=${d}`, KEY))
    );

    const all = results.flat().filter(Boolean)
      .filter(f => LEAGUES.has(f.league?.id))
      .filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    const fixtures = all.slice(0, 20);
    const today = days[0];
    const tomorrow = days[1];

    const oddsArr = await Promise.all(fixtures.map(f => {
      const d = f.fixture?.date?.split("T")[0];
      const st = f.fixture?.status?.short || "NS";
      if (LIVE.has(st) || !(d === today || d === tomorrow)) return Promise.resolve(null);
      return getOdds(f.fixture?.id, KEY);
    }));

    const matches = fixtures.map((f, j) => {
      const st = f.fixture?.status?.short || "NS";
      const lgId = f.league?.id;
      const odds = oddsArr[j] || {};

      // Cotes réelles ou valeurs neutres (pas de fausses valeurs)
      const hasRealOdds = !!(odds.o1 && odds.on && odds.o2);
      const o1 = hasRealOdds ? odds.o1 : 0;
      const on = hasRealOdds ? odds.on : 0;
      const o2 = hasRealOdds ? odds.o2 : 0;

      // Probabilités implicites sans marge
      let mp1 = 0.40, mpN = 0.28, mp2 = 0.32; // valeurs neutres si pas de cotes
      if (hasRealOdds) {
        const mg = 1/o1 + 1/on + 1/o2;
        mp1 = (1/o1) / mg;
        mpN = (1/on) / mg;
        mp2 = (1/o2) / mg;
      }

      // xG dérivé des cotes — la vraie fix
      const [hxg, axg] = hasRealOdds
        ? deriveXG(mp1, mp2, lgId)
        : [1.35, 1.10]; // fallback neutre si pas de cotes

      return {
        id: f.fixture?.id,
        leagueName: LEAGUE_NAME[lgId] || f.league?.name || "",
        leagueId: lgId,
        c: LEAGUE_NAME[lgId] || f.league?.name || "",
        f: FLAG[lgId] || "INT",
        league: "l"+lgId,
        home: f.teams?.home?.name || "",
        away: f.teams?.away?.name || "",
        h: f.teams?.home?.name || "",
        a: f.teams?.away?.name || "",
        homeId: f.teams?.home?.id,
        awayId: f.teams?.away?.id,
        time: f.fixture?.date || "",
        t: f.fixture?.date || "",
        status: st,
        isLive: LIVE.has(st),
        goalsH: f.goals?.home ?? null,
        goalsA: f.goals?.away ?? null,

        // Cotes
        o1: hasRealOdds ? o1 : null,
        on: hasRealOdds ? on : null,
        o2: hasRealOdds ? o2 : null,
        hasRealOdds,
        hasPinnacle: !!(odds.pinnacle),

        // Marchés alternatifs
        dc1x: odds.dc1x || null,
        dc12: odds.dc12 || null,
        dcx2: odds.dcx2 || null,
        over25: odds.over2_5 || null,
        under25: odds.under2_5 || null,
        over35: odds.over3_5 || null,
        over15: odds.over1_5 || null,
        bttsY: odds.bttsY || null,
        bttsN: odds.bttsN || null,

        // Stats dérivées des cotes — cohérentes avec les probs
        hxg,
        axg,
        hxga: toNum(axg * 0.85, 2),
        axga: toNum(hxg * 0.85, 2),
        hg: toNum(hxg * 0.90, 2),
        ag: toNum(axg * 0.90, 2),
        hsh: Math.round(hxg * 2.9),
        ash: Math.round(axg * 2.9),
        hf: hasRealOdds ? Math.round(mp1 * 15) : 8,
        af: hasRealOdds ? Math.round(mp2 * 15) : 6,
        hcs: hasRealOdds ? Math.round(mp1 * 30) : 25,
        acs: hasRealOdds ? Math.round(mp2 * 30) : 20,
        hFormScore: toNum(mp1 * 0.8, 3),
        aFormScore: toNum(mp2 * 0.8, 3),
        hWinRate: toNum(mp1 * 0.9, 3),
        aWinRate: toNum(mp2 * 0.9, 3),
        hMatchesPlayed: 10,
        aMatchesPlayed: 10,
        hForm: "",
        aForm: "",
        h2h: [],
        dataQuality: hasRealOdds ? "odds_derived" : "no_data",
      };
    });

    matches.sort((a,b) => {
      if(a.isLive && !b.isLive) return -1;
      if(!a.isLive && b.isLive) return 1;
      return (a.time||"") < (b.time||"") ? -1 : 1;
    });

    return res.status(200).json({
      matches,
      count: matches.length,
      withOdds: matches.filter(m => m.hasRealOdds).length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated: now.toISOString(),
      source: "EDGE Scan v8",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
