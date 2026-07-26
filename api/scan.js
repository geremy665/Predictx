// EDGE — api/scan.js v13 — Europe · cotes groupées · VALUE = comparaison entre bookmakers
function toNum(val, decimals) {
  if(val === null || val === undefined || isNaN(val)) return 0;
  return parseFloat(parseFloat(val).toFixed(decimals || 3));
}

// Ligues suivies TOUTE L'ANNÉE (Europe + été + international)
const LEAGUES = new Set([
  // Big 5
  61,140,39,135,78,
  // Coupes d'Europe + qualifications (dès juillet)
  2,3,848,
  // Championnats européens
  94,   // Liga Portugal
  88,   // Eredivisie
  144,  // Pro League (Belgique)
  203,  // Süper Lig
  179,  // Premiership (Écosse)
  113,  // Allsvenskan (Suède)
  103,  // Eliteserien (Norvège)
  119,  // Superligaen (Danemark)
  244,  // Veikkausliiga (Finlande)
  357,  // League of Ireland
  207,  // Super League (Suisse)
  218,  // Bundesliga (Autriche)
  197,  // Super League (Grèce)
  106,  // Ekstraklasa (Pologne)
  345,  // Fortuna Liga (Tchéquie)
  283,  // Liga I (Roumanie)
  210,  // HNL (Croatie)
  286,  // Super Liga (Serbie)
  333,  // Premier League (Ukraine)
  62,   // Ligue 2
  40,   // Championship (Angleterre)
  141,  // La Liga 2
  136,  // Serie B
  79,   // 2. Bundesliga
  // International UEFA + amicaux
  4,5,10,667,1,34,
]);

// Priorité d'affichage (plus haut = montré en premier)
const PRIORITY = {
  2:95, 3:92, 848:88,               // UCL, UEL, Conference (qualifs dès juillet)
  61:90,140:90,39:90,135:90,78:90,  // Big 5
  94:74, 88:74, 144:72, 203:72,     // PT, NL, BE, TR
  40:70, 62:64, 141:62, 136:62, 79:62, // D2 majeures
  179:66, 207:64, 218:62, 197:60,   // Écosse, Suisse, Autriche, Grèce
  113:62, 103:62, 119:60, 244:56, 357:54, // Nordiques + Irlande
  106:56, 345:54, 283:52, 210:52, 286:50, 333:50, // Europe centrale/Est
  4:94, 5:75, 1:68, 34:68,          // Euro, Nations League, qualifs
  10:40, 667:18,                    // Amicaux (dernier)
};

const FLAG = {
  61:"FR",62:"FR",140:"ES",141:"ES",39:"ENG",40:"ENG",135:"IT",136:"IT",
  78:"DE",79:"DE",2:"UCL",3:"UEL",848:"UECL",94:"PT",88:"NL",144:"BE",
  203:"TR",179:"SCO",113:"SE",103:"NO",119:"DK",244:"FI",357:"IE",
  207:"CH",218:"AT",197:"GR",106:"PL",345:"CZ",283:"RO",210:"HR",
  286:"RS",333:"UA",10:"INT",667:"AMI",4:"EUR",5:"UNL",1:"WCQ",34:"WCQ"
};

const LEAGUE_NAME = {
  61:"Ligue 1",62:"Ligue 2",140:"La Liga",141:"La Liga 2",
  39:"Premier League",40:"Championship",135:"Serie A",136:"Serie B",
  78:"Bundesliga",79:"2. Bundesliga",
  2:"Champions League",3:"Europa League",848:"Conference League",
  94:"Liga Portugal",88:"Eredivisie",144:"Pro League",203:"Süper Lig",
  179:"Premiership",113:"Allsvenskan",103:"Eliteserien",119:"Superligaen",
  244:"Veikkausliiga",357:"League of Ireland",207:"Super League CH",
  218:"Bundesliga AT",197:"Super League GR",106:"Ekstraklasa",
  345:"Fortuna Liga",283:"Liga I",210:"HNL",286:"Super Liga RS",
  333:"Premier League UA",10:"Amicaux Nations",667:"Amicaux Clubs",
  4:"Euro",5:"UEFA Nations League",1:"Qualif. Mondial",34:"Qualif. Mondial"
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

// Récupère TOUTES les cotes 1X2 d'une journée en 1 à 3 requêtes (au lieu d'une par match)
// → permet de couvrir une semaine entière sans exploser le quota API
async function getOddsBulk(date, key, maxPages) {
  const map = {};
  const limit = maxPages || 3;
  let page = 1, totalPages = 1;
  while (page <= Math.min(limit, totalPages)) {
    let d = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      const r = await fetch(`https://v3.football.api-sports.io/odds?date=${date}&bet=1&page=${page}`, {
        headers: { "x-apisports-key": key, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) break;
      d = await r.json();
    } catch (e) { break; }
    if (!d || !Array.isArray(d.response)) break;
    totalPages = (d.paging && d.paging.total) ? d.paging.total : 1;

    for (const item of d.response) {
      const fid = item.fixture && item.fixture.id;
      if (!fid || map[fid]) continue;
      const bks = item.bookmakers || [];
      bks.sort((a, b) => {
        const ia = SHARP_BK.indexOf(a.id), ib = SHARP_BK.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      // On collecte TOUS les bookmakers pour calculer consensus + meilleure cote
      const all1 = [], allN = [], all2 = [];
      let ref = null, hasPin = false;
      for (const bk of bks) {
        const mw = (bk.bets || []).find(b => b.id === 1 || b.name === "Match Winner");
        if (!mw || !mw.values || mw.values.length < 3) continue;
        const h = mw.values.find(v => v.value === "Home");
        const dr = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (!h || !dr || !a) continue;
        const c1 = parseFloat(h.odd), cn = parseFloat(dr.odd), c2 = parseFloat(a.odd);
        if (!(c1 > 1.01 && cn > 1.01 && c2 > 1.01)) continue;
        all1.push({ o: c1, b: bk.name });
        allN.push({ o: cn, b: bk.name });
        all2.push({ o: c2, b: bk.name });
        if (bk.id === 8) hasPin = true;
        if (!ref) ref = { o1: c1, on: cn, o2: c2, book: bk.name };
      }
      if (!ref || all1.length === 0) continue;

      // Consensus = médiane des probabilités implicites, puis dé-viggé
      const med = arr => {
        const s = arr.map(x => x.o).sort((a, b) => a - b);
        const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
      };
      const m1 = med(all1), mn = med(allN), m2 = med(all2);
      const marg = 1 / m1 + 1 / mn + 1 / m2;
      const cons = { p1: (1 / m1) / marg, pn: (1 / mn) / marg, p2: (1 / m2) / marg };

      // Meilleure cote disponible par issue
      const best = a => a.reduce((x, y) => (y.o > x.o ? y : x), a[0]);
      const b1 = best(all1), bN = best(allN), b2 = best(all2);

      // Value = espérance au meilleur prix, évaluée avec la probabilité consensus
      const cand = [
        { k: "1", edge: cons.p1 * b1.o - 1, odd: b1.o, book: b1.b },
        { k: "N", edge: cons.pn * bN.o - 1, odd: bN.o, book: bN.b },
        { k: "2", edge: cons.p2 * b2.o - 1, odd: b2.o, book: b2.b },
      ].sort((x, y) => y.edge - x.edge);
      const top = cand[0];

      map[fid] = {
        o1: ref.o1, on: ref.on, o2: ref.o2,
        pinnacle: hasPin,
        nBooks: all1.length,
        bestO1: b1.o, bestON: bN.o, bestO2: b2.o,
        bestBook1: b1.b, bestBookN: bN.b, bestBook2: b2.b,
        lineValue: (all1.length >= 3 && top.edge > 0)
          ? { pick: top.k, edge: +top.edge.toFixed(4), odd: top.odd, book: top.book, nBooks: all1.length }
          : null,
      };
    }
    page++;
  }
  return map;
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

    // -1 = hier (règlement du track record), 0..6 = une semaine d'avance
    const days = [-1,0,1,2,3,4,5,6].map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    const results = await Promise.all(
      days.map(d => apiFetch(`/fixtures?date=${d}`, KEY))
    );

    const pool = results.flat().filter(Boolean)
      .filter(f => LEAGUES.has(f.league?.id));

    // Matchs terminés (hier + aujourd'hui) → règlement du track record côté client
    const finished = pool
      .filter(f => DONE.has(f.fixture?.status?.short))
      .map(f => ({
        id: f.fixture?.id,
        gh: f.goals?.home ?? null,
        ga: f.goals?.away ?? null,
      }));

    let all = pool.filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    // TRI PAR PRIORITÉ: live d'abord, puis priorité de ligue, puis heure
    all.sort((a,b) => {
      const aLive = LIVE.has(a.fixture?.status?.short) ? 1 : 0;
      const bLive = LIVE.has(b.fixture?.status?.short) ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      const pa = PRIORITY[a.league?.id] || 30;
      const pb = PRIORITY[b.league?.id] || 30;
      if (pa !== pb) return pb - pa;
      return (a.fixture?.date||"") < (b.fixture?.date||"") ? -1 : 1;
    });

    // Équilibre garanti : max 12 live, le reste = matchs à venir prioritaires
    const liveArr = all.filter(f => LIVE.has(f.fixture?.status?.short));
    const upArr   = all.filter(f => !LIVE.has(f.fixture?.status?.short));
    const fixtures = liveArr.slice(0, 12).concat(upArr.slice(0, 60 - Math.min(liveArr.length, 12)));
    const today = days[1];
    const tomorrow = days[2];

    // ── COTES EN MASSE : 1 à 3 requêtes par jour au lieu d'une par match ──
    const oddDays = days.filter(d => d >= days[1]); // à partir d'aujourd'hui
    const bulkMaps = await Promise.all(oddDays.map(d => getOddsBulk(d, KEY, 3)));
    const oddsByFixture = Object.assign({}, ...bulkMaps);

    // Marchés complets (double chance, over/under, BTTS) pour les 10 matchs prioritaires
    const detailTargets = fixtures
      .filter(f => !LIVE.has(f.fixture?.status?.short) && oddsByFixture[f.fixture?.id])
      .slice(0, 10);
    const detailArr = await Promise.all(detailTargets.map(f => getOdds(f.fixture?.id, KEY)));
    const detailById = {};
    detailTargets.forEach((f, i) => { if (detailArr[i]) detailById[f.fixture.id] = detailArr[i]; });

    const oddsArr = fixtures.map(f => {
      const fid = f.fixture?.id;
      const st = f.fixture?.status?.short || "NS";
      if (LIVE.has(st)) return null;
      const base = oddsByFixture[fid];
      if (!base) return null;
      return Object.assign({}, base, detailById[fid] || {});
    });

    const matches = fixtures.map((f, j) => {
      const st = f.fixture?.status?.short || "NS";
      const odds = oddsArr[j] || {};
      const lgId = f.league?.id;
      const o1 = odds.o1 || 1.90;
      const on = odds.on || 3.40;
      const o2 = odds.o2 || 3.80;
      const mg = 1/o1 + 1/on + 1/o2;
      const mp1 = (1/o1)/mg;
      const mp2 = (1/o2)/mg;
      // Dérivation xG réaliste : écart log de force + total ~2.6 buts
      // PSG@1.45 vs OM@6.50 → ~2.05 vs 0.85 (au lieu de 1.79 vs 1.33)
      const ratio = Math.max(0.2, Math.min(5, mp1/Math.max(mp2,0.02)));
      const diff = Math.max(-1.4, Math.min(1.4, 0.62*Math.log(ratio)));
      const total = 2.60;
      const hxg = toNum(Math.max(0.35, total/2 + diff/2), 2);
      const axg = toNum(Math.max(0.35, total/2 - diff/2), 2);

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
        o1, on, o2,
        hasRealOdds: !!(odds.o1),
        hasPinnacle: !!(odds.pinnacle),
        nBooks: odds.nBooks || 0,
        bestO1: odds.bestO1 || null, bestON: odds.bestON || null, bestO2: odds.bestO2 || null,
        bestBook1: odds.bestBook1 || null, bestBookN: odds.bestBookN || null, bestBook2: odds.bestBook2 || null,
        lineValue: odds.lineValue || null,
        dc1x: odds.dc1x || null, dc12: odds.dc12 || null, dcx2: odds.dcx2 || null,
        over25: odds.over2_5 || null, under25: odds.under2_5 || null,
        over35: odds.over3_5 || null, over15: odds.over1_5 || null,
        bttsY: odds.bttsY || null, bttsN: odds.bttsN || null,
        hxg, axg,
        hxga: toNum(axg*0.85, 2), axga: toNum(hxg*0.85, 2),
        hg: toNum(hxg*0.90, 2), ag: toNum(axg*0.90, 2),
        hsh: Math.round(hxg*2.9), ash: Math.round(axg*2.9),
        hf: Math.round(mp1*15), af: Math.round(mp2*15),
        hcs: Math.round(mp1*30), acs: Math.round(mp2*30),
        hFormScore: toNum(mp1*0.8, 3), aFormScore: toNum(mp2*0.8, 3),
        hWinRate: toNum(mp1*0.9, 3), aWinRate: toNum(mp2*0.9, 3),
        hMatchesPlayed: 10, aMatchesPlayed: 10,
        hForm: "", aForm: "",
        h2h: [], dataQuality: "odds_derived",
      };
    });

    // Live d'abord, puis les matchs réellement cotés (exploitables), puis par heure
    matches.sort((a,b) => {
      if(a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      if(a.hasRealOdds !== b.hasRealOdds) return a.hasRealOdds ? -1 : 1;
      return (a.time||"") < (b.time||"") ? -1 : 1;
    });

    return res.status(200).json({
      matches,
      finished,
      count: matches.length,
      withOdds: matches.filter(m => m.hasRealOdds).length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated: now.toISOString(),
      daysCovered: days.length - 1,
      withValue: matches.filter(m => m.lineValue).length,
      source: "EDGE Scan v13",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
