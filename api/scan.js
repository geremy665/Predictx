// EDGE — api/scan.js v10 — 100% Europe
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

    // -1 = hier (pour régler les signaux), 0..2 = affichage
    const days = [-1,0,1,2].map(i =>
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
    const fixtures = liveArr.slice(0, 12).concat(upArr.slice(0, 30 - Math.min(liveArr.length, 12)));
    const today = days[1];
    const tomorrow = days[2];

    const oddsArr = await Promise.all(fixtures.map(f => {
      const d = f.fixture?.date?.split("T")[0];
      const st = f.fixture?.status?.short || "NS";
      if (LIVE.has(st) || !(d === today || d === tomorrow)) return Promise.resolve(null);
      return getOdds(f.fixture?.id, KEY);
    }));

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

    return res.status(200).json({
      matches,
      finished,
      count: matches.length,
      withOdds: matches.filter(m => m.hasRealOdds).length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated: now.toISOString(),
      source: "EDGE Scan v9",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
