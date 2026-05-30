// EDGE — api/scan.js v6 Pro
// Plan Pro: stats réelles + cotes + compositions + blessés

const LEAGUES = new Set([61,140,39,135,78,2,3,94,88,144,203,179,848]);
const DONE    = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE    = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);
const FLAG    = {61:"FR",140:"ES",39:"ENG",135:"IT",78:"DE",2:"UCL",3:"UEL",94:"PT",88:"NL",144:"BE",203:"TR",179:"SCO",848:"UEL"};

// Pinnnacle = bookmaker le plus sharp (id: 8)
// Bet365 = volume (id: 6)
// On priorise Pinnacle pour les cotes, Bet365 comme fallback
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

// Récupérer les cotes — priorise Pinnacle (sharp money)
async function getOdds(fixtureId, key) {
  try {
    const data = await apiFetch(`/odds?fixture=${fixtureId}`, key);
    if (!data?.length) return null;

    let result = {};
    let foundSharp = false;

    // Trier bookmakers: Pinnacle d'abord
    const allBks = [];
    for (const item of data) {
      for (const bk of (item.bookmakers || [])) {
        allBks.push(bk);
      }
    }
    allBks.sort((a,b) => {
      const ia = SHARP_BK.indexOf(a.id);
      const ib = SHARP_BK.indexOf(b.id);
      return (ia<0?99:ia) - (ib<0?99:ib);
    });

    for (const bk of allBks) {
      const bets = bk.bets || [];
      const isPinnacle = bk.id === 8;

      // 1X2
      const mw = bets.find(b => b.id === 1 || b.name === "Match Winner");
      if (mw?.values?.length >= 3) {
        const h = mw.values.find(v => v.value === "Home");
        const d = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (h && d && a && !result.o1) {
          result.o1 = parseFloat(h.odd);
          result.on = parseFloat(d.odd);
          result.o2 = parseFloat(a.odd);
          result.pinnacle = isPinnacle;
          if (isPinnacle) foundSharp = true;
        }
      }

      // Double Chance
      const dc = bets.find(b => b.id === 12 || b.name === "Double Chance");
      if (dc?.values && !result.dc1x) {
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
          const k = (m[1].toLowerCase()==="over"?"over":"under")+m[2].replace(".","_");
          if (!result[k]) result[k] = parseFloat(v.odd);
        });
      }

      // BTTS
      const btts = bets.find(b => b.id === 5 || b.name === "Both Teams Score");
      if (btts?.values && !result.bttsY) {
        const y = btts.values.find(v => v.value === "Yes");
        const n = btts.values.find(v => v.value === "No");
        if (y) result.bttsY = parseFloat(y.odd);
        if (n) result.bttsN = parseFloat(n.odd);
      }

      // Mi-temps
      const ht = bets.find(b => b.id === 8 || b.name === "HT Result");
      if (ht?.values && !result.ht1) {
        const h = ht.values.find(v => v.value === "Home");
        const d = ht.values.find(v => v.value === "Draw");
        const a = ht.values.find(v => v.value === "Away");
        if (h) result.ht1 = parseFloat(h.odd);
        if (d) result.htN = parseFloat(d.odd);
        if (a) result.ht2 = parseFloat(a.odd);
      }

      if (result.o1 && foundSharp) break;
    }

    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

// Récupérer les stats saison d'une équipe
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

    // xG si disponible (plan Pro)
    const xgFor  = d.goals?.for?.total?.xg     || null;
    const xgAgst = d.goals?.against?.total?.xg  || null;

    return {
      played, wins, draws,
      gf:   +(gf/played).toFixed(2),
      ga:   +(ga/played).toFixed(2),
      xgF:  xgFor  ? +(xgFor/played).toFixed(2)  : null,
      xgA:  xgAgst ? +(xgAgst/played).toFixed(2) : null,
      winRate:   +(wins/played).toFixed(3),
      drawRate:  +(draws/played).toFixed(3),
      form, formW, formD,
      formScore: +formScore.toFixed(3),
      cleanSheets: d.clean_sheet?.total || 0,
    };
  } catch(e) { return null; }
}

// Récupérer blessés/suspendus
async function getInjuries(fixtureId, key) {
  try {
    const data = await apiFetch(`/injuries?fixture=${fixtureId}`, key);
    if (!data?.length) return {};
    const home = [], away = [];
    data.forEach(p => {
      const entry = {
        name: p.player?.name,
        pos:  p.player?.type, // Goalkeeper, Defender, Midfielder, Attacker
        reason: p.player?.reason
      };
      if (p.team?.id) {
        // On trie par équipe après
      }
    });
    return data;
  } catch(e) { return []; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  try {
    const now    = new Date();
    const season = now.getMonth() < 7
      ? now.getFullYear()-1
      : now.getFullYear();

    // Récupérer matchs sur 4 jours
    const days = [0,1,2,3].map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    const results = await Promise.all(
      days.map(d => apiFetch(`/fixtures?date=${d}`, KEY))
    );

    const all = results.flat().filter(Boolean)
      .filter(f => LEAGUES.has(f.league?.id))
      .filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    // Limiter à 20 matchs pour rester dans les quotas API
    const fixtures = all.slice(0, 20);

    // Fetch en parallèle par batch de 3
    const BATCH = 3;
    const matches = [];

    for (let i = 0; i < fixtures.length; i += BATCH) {
      const batch = fixtures.slice(i, i+BATCH);

      const [oddsArr, statsArr] = await Promise.all([
        // Cotes
        Promise.all(batch.map(f => {
          const st = f.fixture?.status?.short || "NS";
          return LIVE.has(st) ? null : getOdds(f.fixture?.id, KEY);
        })),
        // Stats équipes (home + away en parallèle)
        Promise.all(batch.map(async f => {
          const lgId = f.league?.id;
          const [hStats, aStats] = await Promise.all([
            getTeamStats(f.teams?.home?.id, lgId, season, KEY),
            getTeamStats(f.teams?.away?.id, lgId, season, KEY),
          ]);
          return { hStats, aStats };
        }))
      ]);

      batch.forEach((f, j) => {
        const st     = f.fixture?.status?.short || "NS";
        const odds   = oddsArr[j] || {};
        const stats  = statsArr[j] || {};
        const hSt    = stats.hStats;
        const aSt    = stats.aStats;

        // Cotes avec fallback
        const o1 = odds.o1 || 1.90;
        const on = odds.on || 3.40;
        const o2 = odds.o2 || 3.80;
        const mg = 1/o1 + 1/on + 1/o2;
        const mp1 = (1/o1)/mg;
        const mp2 = (1/o2)/mg;

        // xG — utiliser stats réelles si disponibles, sinon dériver des cotes
        const hxg = hSt?.xgF || hSt?.gf || +(1.20 + mp1*0.90).toFixed(2);
        const axg = aSt?.xgF || aSt?.gf || +(1.20 + mp2*0.90).toFixed(2);

        // Tirs cadrés — dériver du xG (ratio moyen: ~2.8 tirs par xG)
        const hsh = hSt ? Math.round(hxg*2.9) : Math.round(hxg*2.8);
        const ash = aSt ? Math.round(axg*2.9) : Math.round(axg*2.8);

        // Forme et win rate depuis les stats réelles
        const hFormScore = hSt?.formScore || mp1*0.8;
        const aFormScore = aSt?.formScore || mp2*0.8;
        const hWinRate   = hSt?.winRate   || mp1*0.9;
        const aWinRate   = aSt?.winRate   || mp2*0.9;

        // Nombre de matchs joués (pour pondération Bayesian)
        const hPlayed = hSt?.played || 10;
        const aPlayed = aSt?.played || 10;

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
          goalsH:     f.goals?.home ?? null,
          goalsA:     f.goals?.away ?? null,

          // Cotes
          o1, on, o2,
          hasRealOdds: !!(odds.o1),
          hasPinnacle:  !!(odds.pinnacle),
          dc1x:  odds.dc1x  || null,
          dc12:  odds.dc12  || null,
          dcx2:  odds.dcx2  || null,
          over15:  odds.over1_5  || null,
          under15: odds.under1_5 || null,
          over25:  odds.over2_5  || null,
          under25: odds.under2_5 || null,
          over35:  odds.over3_5  || null,
          bttsY:  odds.bttsY || null,
          bttsN:  odds.bttsN || null,
          ht1:    odds.ht1   || null,
          htN:    odds.htN   || null,
          ht2:    odds.ht2   || null,

          // Stats réelles
          hxg:  +hxg.toFixed(2),
          axg:  +axg.toFixed(2),
          hxga: aSt?.xgA ? +aSt.xgA.toFixed(2) : +(axg*0.85).toFixed(2),
          axga: hSt?.xgA ? +hSt.xgA.toFixed(2) : +(hxg*0.85).toFixed(2),
          hg:   hSt?.gf  ? +hSt.gf.toFixed(2)  : +(hxg*0.90).toFixed(2),
          ag:   aSt?.gf  ? +aSt.gf.toFixed(2)  : +(axg*0.90).toFixed(2),
          hsh, ash,
          hf:   hSt ? Math.round(hWinRate*15) : Math.round(mp1*15),
          af:   aSt ? Math.round(aWinRate*15) : Math.round(mp2*15),
          hcs:  hSt?.cleanSheets || Math.round(mp1*30),
          acs:  aSt?.cleanSheets || Math.round(mp2*30),

          // Forme et win rate
          hForm:        hSt?.form || "",
          aForm:        aSt?.form || "",
          hFormScore:   +hFormScore.toFixed(3),
          aFormScore:   +aFormScore.toFixed(3),
          hWinRate:     +hWinRate.toFixed(3),
          aWinRate:     +aWinRate.toFixed(3),
          hMatchesPlayed: hPlayed,
          aMatchesPlayed: aPlayed,

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
      count:      matches.length,
      withOdds:   matches.filter(m => m.hasRealOdds).length,
      withStats:  matches.filter(m => m.dataQuality==="real_stats").length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated:    now.toISOString(),
      source:     "EDGE Scan v6 Pro",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
