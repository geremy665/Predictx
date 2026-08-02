// EDGE — api/backtest.js v4 — resserré sur les mêmes championnats que scan.js (Winamax/Betclic)
// Le moteur les analyse sans connaître le score, puis on compare.
// Entrée : ?days=7&leagueId=61
// Sortie : { matches:[{...cotes..., realResult, goalsH, goalsA}], count }

// Resserré sur les pays des championnats réellement affichés par scan.js —
// les mêmes que ceux proposés par Winamax/Betclic.
const EU = new Set(["France","Spain","England","Italy","Germany","Portugal","Netherlands","Belgium","Scotland","Turkey","World"]);
const UEFA = new Set([2,3,848,4,5,1,10,667,531,525]);
const EXCLURE = /\b(U1[5-9]|U2[0-3]|Youths?|Juniors?|Junioren|Jugend|Women'?s?|Feminine|Femenin|Reserves?|Amateur|Futsal|Beach)\w*\b/i;
function ligueRetenue(l){
  if(!l) return false;
  if(l.name && EXCLURE.test(l.name)) return false;
  if(UEFA.has(l.id)) return true;
  // Filet de sécurité : si le fournisseur n'envoie pas le pays, on retombe
  // sur la liste des ligues connues plutôt que de tout rejeter.
  if(l.country === undefined || l.country === null || l.country === "") {
    return LEAGUES.has(l.id);
  }
  if(l.country === "World") return UEFA.has(l.id);
  return EU.has(l.country);
}
const LEAGUE_NAME = {61:"Ligue 1",62:"Ligue 2",140:"La Liga",39:"Premier League",135:"Serie A",78:"Bundesliga",2:"Champions League",3:"Europa League",848:"Conference League",94:"Liga Portugal",88:"Eredivisie",144:"Pro League",203:"Süper Lig",179:"Premiership",10:"Amicaux Nations",667:"Amicaux Clubs",4:"Euro",5:"UEFA Nations League",1:"Qualif. Mondial",34:"Qualif. Mondial"};
const DONE = new Set(["FT","AET","PEN"]);
const SHARP_BK = [8,6,1,2,3];

async function api(url, key, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 9000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return d;
  } catch (e) { return null; }
}

// Cotes groupées d'une journée, avec consensus + meilleur prix (comme scan v13)
async function oddsForDate(date, key, maxPages) {
  const map = {};
  let page = 1, total = 1;
  while (page <= Math.min(maxPages || 3, total)) {
    const d = await api(`/odds?date=${date}&bet=1&page=${page}`, key);
    if (!d || !Array.isArray(d.response)) break;
    total = (d.paging && d.paging.total) ? d.paging.total : 1;
    for (const item of d.response) {
      const fid = item.fixture && item.fixture.id;
      if (!fid || map[fid]) continue;
      const all1 = [], allN = [], all2 = [];
      let ref = null;
      for (const bk of (item.bookmakers || [])) {
        const mw = (bk.bets || []).find(b => b.id === 1 || b.name === "Match Winner");
        if (!mw || !mw.values || mw.values.length < 3) continue;
        const h = mw.values.find(v => v.value === "Home");
        const dr = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (!h || !dr || !a) continue;
        const c1 = parseFloat(h.odd), cn = parseFloat(dr.odd), c2 = parseFloat(a.odd);
        if (!(c1 > 1.01 && cn > 1.01 && c2 > 1.01)) continue;
        all1.push(c1); allN.push(cn); all2.push(c2);
        if (!ref) ref = { o1: c1, on: cn, o2: c2 };
      }
      if (!ref) continue;
      const med = a => { const s = a.slice().sort((x, y) => x - y); const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
      const m1 = med(all1), mn = med(allN), m2 = med(all2);
      const marg = 1 / m1 + 1 / mn + 1 / m2;
      const best1 = Math.max(...all1), bestN = Math.max(...allN), best2 = Math.max(...all2);
      const cons = { p1: (1 / m1) / marg, pn: (1 / mn) / marg, p2: (1 / m2) / marg };
      const cand = [
        { k: "1", edge: cons.p1 * best1 - 1, odd: best1 },
        { k: "N", edge: cons.pn * bestN - 1, odd: bestN },
        { k: "2", edge: cons.p2 * best2 - 1, odd: best2 },
      ].sort((x, y) => y.edge - x.edge);
      map[fid] = { o1: ref.o1, on: ref.on, o2: ref.o2, nBooks: all1.length,
        bestO1: best1, bestON: bestN, bestO2: best2,
        lineValue: (all1.length >= 3 && cand[0].edge > 0)
          ? { pick: cand[0].k, edge: +cand[0].edge.toFixed(4), odd: cand[0].odd, nBooks: all1.length } : null };
    }
    page++;
  }
  return map;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  const q = req.query || {};
  let days = parseInt(q.days, 10); if (!days || days < 1) days = 7; if (days > 14) days = 14;
  const leagueId = parseInt(q.leagueId, 10) || null;

  try {
    const now = new Date();
    const dates = [];
    for (let i = 1; i <= days; i++) dates.push(new Date(now.getTime() - i * 86400000).toISOString().split("T")[0]);

    const fixRes = await Promise.all(dates.map(d => api(`/fixtures?date=${d}`, KEY)));
    let fixtures = [];
    fixRes.forEach(d => { if (d && Array.isArray(d.response)) fixtures = fixtures.concat(d.response); });

    fixtures = fixtures
      .filter(f => DONE.has(f.fixture && f.fixture.status && f.fixture.status.short))
      .filter(f => f.goals && f.goals.home !== null && f.goals.away !== null)
      .filter(f => ligueRetenue(f.league))
      .filter(f => {
        const hn = (f.teams && f.teams.home && f.teams.home.name) || "";
        const an = (f.teams && f.teams.away && f.teams.away.name) || "";
        return !EXCLURE.test(hn) && !EXCLURE.test(an);
      })
      .filter(f => !leagueId || (f.league && f.league.id === leagueId));

    // Cotes : une requête groupée par date
    const oddMaps = await Promise.all(dates.map(d => oddsForDate(d, KEY, 3)));
    const odds = Object.assign({}, ...oddMaps);

    const matches = [];
    for (const f of fixtures) {
      const fid = f.fixture.id;
      const o = odds[fid];
      if (!o) continue;                       // sans cotes réelles, le test n'a aucun sens
      const gh = f.goals.home, ga = f.goals.away;
      const lgId = f.league.id;
      const mg = 1 / o.o1 + 1 / o.on + 1 / o.o2;
      const mp1 = (1 / o.o1) / mg, mp2 = (1 / o.o2) / mg;
      const ratio = Math.max(0.2, Math.min(5, mp1 / Math.max(mp2, 0.02)));
      const diff = Math.max(-1.4, Math.min(1.4, 0.62 * Math.log(ratio)));
      const hxg = Math.max(0.35, 1.30 + diff / 2), axg = Math.max(0.35, 1.30 - diff / 2);
      matches.push({
        id: fid,
        c: LEAGUE_NAME[lgId] || f.league.name || "", leagueName: LEAGUE_NAME[lgId] || f.league.name || "", leagueId: lgId,
        h: f.teams.home.name, a: f.teams.away.name, home: f.teams.home.name, away: f.teams.away.name,
        homeId: f.teams.home.id, awayId: f.teams.away.id,
        time: f.fixture.date, t: f.fixture.date, status: "NS",   // le moteur doit croire que le match est à venir
        o1: o.o1, on: o.on, o2: o.o2, hasRealOdds: true, nBooks: o.nBooks,
        bestO1: o.bestO1, bestON: o.bestON, bestO2: o.bestO2, lineValue: o.lineValue,
        hxg: +hxg.toFixed(2), axg: +axg.toFixed(2), hxga: +(axg * 0.85).toFixed(2), axga: +(hxg * 0.85).toFixed(2),
        hg: +(hxg * 0.9).toFixed(2), ag: +(axg * 0.9).toFixed(2),
        hf: Math.round(mp1 * 15), af: Math.round(mp2 * 15),
        hcs: Math.round(mp1 * 30), acs: Math.round(mp2 * 30),
        hFormScore: +(mp1 * 0.8).toFixed(3), aFormScore: +(mp2 * 0.8).toFixed(3),
        hWinRate: +(mp1 * 0.9).toFixed(3), aWinRate: +(mp2 * 0.9).toFixed(3),
        hMatchesPlayed: 10, aMatchesPlayed: 10, h2h: [], dataQuality: "odds_derived",
        // La vérité — le frontend ne s'en sert QU'APRÈS avoir calculé sa prédiction
        realResult: gh > ga ? "1" : (gh < ga ? "2" : "N"),
        goalsH: gh, goalsA: ga, totalGoals: gh + ga, btts: (gh > 0 && ga > 0),
        realDate: f.fixture.date.split("T")[0],
      });
    }

    matches.sort((a, b) => (a.time < b.time ? 1 : -1));
    return res.status(200).json({
      matches: matches.slice(0, 300),
      count: matches.length,
      daysAnalysed: days,
      source: "EDGE Backtest v4",
    });
  } catch (e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
