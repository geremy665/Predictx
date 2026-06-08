// EDGE — api/scan.js v7
// Ligues + matchs internationaux + amicaux

// Force dot as decimal separator regardless of server locale
function toNum(val, decimals) {
  if(val === null || val === undefined || isNaN(val)) return 0;
  return parseFloat(parseFloat(val).toFixed(decimals || 3));
}

const LEAGUES = new Set([
  // Ligues européennes
  61,140,39,135,78,2,3,94,88,144,203,179,848,113,200,
  // Matchs internationaux
  10,   // Amicaux Nations
  667,  // Amicaux Clubs
  4,    // Euro
  5,    // UEFA Nations League
  6,    // Africa Cup
  7,    // Asian Cup
  9,    // Copa America
  15,   // FIFA World Cup
  1,    // World Cup Qualification
  34,   // World Cup Qualification Europe
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
  10:"Amicaux Nations",667:"Amicaux Clubs",4:"Euro 2024",
  5:"UEFA Nations League",6:"Africa Cup",7:"Asian Cup",
  9:"Copa America",15:"Coupe du Monde",1:"Qualif. Mondial",34:"Qualif. Mondial"
};

const DONE = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);
const SHARP_BK = [8, 6, 1, 2, 3];

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

async function getTeamStats(teamId, leagueId, season, key) {
  try {
    const data = await apiFetch(
      `/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`,
      key
    );
    if (!data?.[0]) return null;
    const d = data[0];
    const played = d.fixtures?.played?.total || 1;
    const wins   = d.fixtures?.wins?.total   || 0;
    const draws  = d.fixtures?.draws?.total  || 0;
    const gf     = d.goals?.for?.total?.total    || 0;
    const ga     = d.goals?.against?.total?.total || 0;
    const form   = (d.form || "").slice(-5);
    const formW  = (form.match(/W/g)||[]).length;
    const formD  = (form.match(/D/g)||[]).length;
    const formScore = (formW*3+formD)/Math.max(1,form.length*3);
    const xgFor  = d.goals?.for?.total?.xg  || null;
    const xgAgst = d.goals?.against?.total?.xg || null;

    return {
      played, wins, draws,
      gf:   toNum(gf/played, 2),
      ga:   toNum(ga/played, 2),
      xgF:  xgFor  ? toNum(xgFor/played, 2)  : null,
      xgA:  xgAgst ? toNum(xgAgst/played, 2) : null,
      winRate:   toNum(wins/played, 3),
      drawRate:  toNum(draws/played, 3),
      form, formScore: toNum(formScore, 3),
      cleanSheets: d.clean_sheet?.total || 0,
    };
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  try {
    const now    = new Date();
    const season = now.getMonth() < 7 ? now.getFullYear()-1 : now.getFullYear();

    // 7 jours au lieu de 4
    const days = [0,1,2,3,4,5,6].map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    const results = await Promise.all(
      days.map(d => apiFetch(`/fixtures?date=${d}`, KEY))
    );

    const all = results.flat().filter(Boolean)
      .filter(f => LEAGUES.has(f.league?.id))
      .filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    // Enrichissement complet seulement pour aujourd'hui + demain
    const today    = days[0];
    const tomorrow = days[1];

    const fixtures = all.slice(0, 25);
    const BATCH = 3;
    const matches = [];

    for (let i = 0; i < fixtures.length; i += BATCH) {
      const batch = fixtures.slice(i, i+BATCH);
      const isClose = batch.map(f => {
        const d = f.fixture?.date?.split("T")[0];
        return d === today || d === tomorrow;
      });

      const [oddsArr, statsArr] = await Promise.all([
        Promise.all(batch.map((f, j) => {
          const st = f.fixture?.status?.short || "NS";
          return (LIVE.has(st) || !isClose[j]) ? null : getOdds(f.fixture?.id, KEY);
        })),
        Promise.all(batch.map(async (f, j) => {
          if (!isClose[j]) return { hStats: null, aStats: null };
          const lgId = f.league?.id;
          const [hStats, aStats] = await Promise.all([
            getTeamStats(f.teams?.home?.id, lgId, season, KEY),
            getTeamStats(f.teams?.away?.id, lgId, season, KEY),
          ]);
          return { hStats, aStats };
        }))
      ]);

      batch.forEach((f, j) => {
        const st    = f.fixture?.status?.short || "NS";
        const odds  = oddsArr[j] || {};
        const hSt   = statsArr[j]?.hStats;
        const aSt   = statsArr[j]?.aStats;
        const lgId  = f.league?.id;

        const o1 = odds.o1 || 1.90;
        const on = odds.on || 3.40;
        const o2 = odds.o2 || 3.80;
        const mg = 1/o1 + 1/on + 1/o2;
        const mp1 = (1/o1)/mg;
        const mp2 = (1/o2)/mg;

        const hxg = hSt?.xgF || hSt?.gf || toNum(1.20 + mp1*0.90, 2);
        const axg = aSt?.xgF || aSt?.gf || toNum(1.20 + mp2*0.90, 2);

        matches.push({
          id:         f.fixture?.id,
          leagueName: LEAGUE_NAME[lgId] || f.league?.name || "",
          leagueId:   lgId,
          c:          LEAGUE_NAME[lgId] || f.league?.name || "",
          f:          FLAG[lgId] || "INT",
          league:     "l"+lgId,
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
          goalsH:     f.goals?.home ?? null,
          goalsA:     f.goals?.away ?? null,

          o1, on, o2,
          hasRealOdds: !!(odds.o1),
          hasPinnacle:  !!(odds.pinnacle),
          dc1x: odds.dc1x || null, dc12: odds.dc12 || null, dcx2: odds.dcx2 || null,
          over15: odds.over1_5 || null, under15: odds.under1_5 || null,
          over25: odds.over2_5 || null, under25: odds.under2_5 || null,
          over35: odds.over3_5 || null,
          bttsY: odds.bttsY || null, bttsN: odds.bttsN || null,

          hxg: toNum(hxg, 2), axg: toNum(axg, 2),
          hxga: aSt?.xgA ? toNum(aSt.xgA, 2) : toNum(axg*0.85, 2),
          axga: hSt?.xgA ? toNum(hSt.xgA, 2) : toNum(hxg*0.85, 2),
          hg:  hSt?.gf ? toNum(hSt.gf, 2) : toNum(hxg*0.90, 2),
          ag:  aSt?.gf ? toNum(aSt.gf, 2) : toNum(axg*0.90, 2),
          hsh: Math.round(hxg*2.9), ash: Math.round(axg*2.9),
          hf:  hSt ? Math.round(hSt.winRate*15) : Math.round(mp1*15),
          af:  aSt ? Math.round(aSt.winRate*15) : Math.round(mp2*15),
          hcs: hSt?.cleanSheets || Math.round(mp1*30),
          acs: aSt?.cleanSheets || Math.round(mp2*30),
          hForm: hSt?.form || "", aForm: aSt?.form || "",
          hFormScore: toNum(hSt?.formScore || mp1*0.8, 3),
          aFormScore: toNum(aSt?.formScore || mp2*0.8, 3),
          hWinRate: toNum(hSt?.winRate || mp1*0.9, 3),
          aWinRate: toNum(aSt?.winRate || mp2*0.9, 3),
          hMatchesPlayed: hSt?.played || 10,
          aMatchesPlayed: aSt?.played || 10,
          h2h: [],
          dataQuality: hSt && aSt ? "real_stats" : "odds_derived",
        });
      });
    }

    matches.sort((a,b) => {
      if(a.isLive && !b.isLive) return -1;
      if(!a.isLive && b.isLive) return  1;
      return (a.time||"") < (b.time||"") ? -1 : 1;
    });

    return res.status(200).json({
      matches,
      count:        matches.length,
      withOdds:     matches.filter(m => m.hasRealOdds).length,
      withStats:    matches.filter(m => m.dataQuality==="real_stats").length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated:      now.toISOString(),
      source:       "EDGE Scan v7 — Intl",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
