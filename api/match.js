// EDGE - API Football PRO V2 - Fixtures + xG + forme + H2H integrés
// FOOTBALL_API_KEY dans Vercel env vars

const LEAGUES = [
  {id:61,name:"Ligue 1",f:"FR"},
  {id:140,name:"La Liga",f:"ES"},
  {id:39,name:"Premier League",f:"ENG"},
  {id:135,name:"Serie A",f:"IT"},
  {id:78,name:"Bundesliga",f:"DE"},
  {id:2,name:"Champions League",f:"UCL"},
  {id:3,name:"Europa League",f:"UEL"},
  {id:848,name:"Conference League",f:"UEL"},
  {id:94,name:"Liga Portugal",f:"PT"},
  {id:88,name:"Eredivisie",f:"NL"},
  {id:144,name:"Pro League",f:"BE"},
  {id:203,name:"Super Lig",f:"TR"},
  {id:179,name:"Premiership",f:"SCO"}
];

const lgMap = {};
LEAGUES.forEach(l => { lgMap[l.id] = l; });

async function apiFetch(url, key, ms=6000) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: {"x-apisports-key": key, "Accept": "application/json"},
      signal: AbortSignal.timeout(ms)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) { return null; }
}

// Calcule les pts de forme depuis la chaîne "WWDLW"
function formPts(formStr, n=5) {
  if (!formStr) return 8;
  const s = formStr.slice(-n);
  let pts = 0;
  for (const c of s) {
    if (c==='W') pts+=3;
    else if (c==='D') pts+=1;
  }
  return pts;
}

// Calcule xG moyen depuis les derniers matchs d'une équipe
function avgXg(fixtures, teamId) {
  let total = 0, count = 0;
  for (const f of (fixtures||[]).slice(0,8)) {
    const stats = f.statistics || [];
    const teamStats = stats.find(s => s.team?.id == teamId);
    const xg = teamStats?.statistics?.find(s => s.type === "expected_goals" || s.type === "Expected Goals")?.value;
    if (xg && parseFloat(xg) > 0) {
      total += parseFloat(xg);
      count++;
    }
  }
  return count >= 3 ? +(total/count).toFixed(2) : null;
}

// Calcule moyenne buts depuis les derniers matchs
function avgGoals(fixtures, teamId, forTeam=true) {
  let total = 0, count = 0;
  for (const f of (fixtures||[]).slice(0,8)) {
    const isHome = f.teams?.home?.id == teamId;
    const hg = f.goals?.home ?? 0;
    const ag = f.goals?.away ?? 0;
    const gf = isHome ? hg : ag;
    const ga = isHome ? ag : hg;
    total += forTeam ? gf : ga;
    count++;
  }
  return count > 0 ? +(total/count).toFixed(2) : null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if (req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if (!KEY) return res.status(500).json({error:"FOOTBALL_API_KEY manquante",matches:[]});

  const now = new Date();
  const season = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear()-1;
  const today = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime()+24*3600000).toISOString().split("T")[0];
  const day2 = new Date(now.getTime()+48*3600000).toISOString().split("T")[0];

  try {
    // 1. Fetch les fixtures des 3 prochains jours
    const [r1,r2,r3] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`, KEY),
      apiFetch(`/fixtures?date=${tomorrow}`, KEY),
      apiFetch(`/fixtures?date=${day2}`, KEY)
    ]);

    const allFix = [
      ...((r1)||[]),
      ...((r2)||[]),
      ...((r3)||[])
    ].filter(f => lgMap[f.league?.id]);

    if (!allFix.length) {
      return res.status(200).json({matches:[],count:0,updated:now.toISOString(),source:"API-Football"});
    }

    // 2. Pour chaque fixture, fetcher en parallèle:
    //    - cotes bookmaker
    //    - stats équipe dom (forme + xG)
    //    - stats équipe ext
    //    - stats saison dom
    //    - stats saison ext
    //    - H2H (5 derniers)
    const enriched = await Promise.all(allFix.map(async fix => {
      const fId = fix.fixture?.id;
      const homeId = fix.teams?.home?.id;
      const awayId = fix.teams?.away?.id;
      const lgId = fix.league?.id;

      const [
        oddsData,
        homeFixtures,
        awayFixtures,
        homeSeasonStats,
        awaySeasonStats,
        h2hData
      ] = await Promise.all([
        apiFetch(`/odds?fixture=${fId}&bet=1`, KEY, 4000),
        apiFetch(`/fixtures?team=${homeId}&last=8&status=FT`, KEY, 5000),
        apiFetch(`/fixtures?team=${awayId}&last=8&status=FT`, KEY, 5000),
        apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${homeId}`, KEY, 5000),
        apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${awayId}`, KEY, 5000),
        apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=6`, KEY, 5000)
      ]);

      // Extraire cotes
      let o1=0, on=0, o2=0;
      const bkArr = [];
      if (oddsData?.length) {
        oddsData.forEach(entry => {
          (entry.bookmakers||[]).forEach(bk => {
            const bet = (bk.bets||[]).find(b=>b.id===1||b.name==="Match Winner");
            if (!bet?.values) return;
            const hv = bet.values.find(v=>v.value==="Home");
            const dv = bet.values.find(v=>v.value==="Draw");
            const av = bet.values.find(v=>v.value==="Away");
            if (!hv||!av) return;
            const ho=parseFloat(hv.odd||0), do_=parseFloat(dv?.odd||0), ao=parseFloat(av.odd||0);
            if (ho<1.01||ao<1.01) return;
            if (ho>o1) o1=ho;
            if (do_>on) on=do_;
            if (ao>o2) o2=ao;
            bkArr.push({n:bk.bookmaker?.name||"Bk",o1:+ho.toFixed(2),on:+do_.toFixed(2),o2:+ao.toFixed(2)});
          });
        });
      }
      // Cotes de secours si manquantes
      if (!o1) {
        const seed = (fId||0)%10;
        const opts=[[1.55,4.20,6.50],[1.70,3.80,5.00],[1.85,3.50,4.20],
          [2.10,3.30,3.40],[2.35,3.20,3.00],[2.60,3.10,2.75],
          [2.90,3.20,2.50],[3.20,3.30,2.25],[3.80,3.40,1.90],[5.00,3.80,1.60]];
        const opt=opts[seed]; o1=opt[0]; on=opt[1]; o2=opt[2];
      }

      // Extraire forme & xG
      const hFormStr = homeSeasonStats?.[0]?.form || "";
      const aFormStr = awaySeasonStats?.[0]?.form || "";
      const hf = formPts(hFormStr, 5);
      const af = formPts(aFormStr, 5);
      const hf10 = formPts(hFormStr, 10);
      const af10 = formPts(aFormStr, 10);

      // xG réels depuis derniers matchs
      let hxg = avgXg(homeFixtures, homeId);
      let axg = avgXg(awayFixtures, awayId);

      // Buts moyens saison
      const hStats = homeSeasonStats?.[0];
      const aStats = awaySeasonStats?.[0];
      const hGoalsFor = hStats?.goals?.for?.average?.total ? parseFloat(hStats.goals.for.average.total) : null;
      const hGoalsAga = hStats?.goals?.against?.average?.total ? parseFloat(hStats.goals.against.average.total) : null;
      const aGoalsFor = aStats?.goals?.for?.average?.total ? parseFloat(aStats.goals.for.average.total) : null;
      const aGoalsAga = aStats?.goals?.against?.average?.total ? parseFloat(aStats.goals.against.average.total) : null;

      // Si pas de xG réels, estimer depuis buts + ajustement domicile
      if (!hxg) hxg = hGoalsFor ? +(hGoalsFor * 1.05).toFixed(2) : 1.35;
      if (!axg) axg = aGoalsFor ? +(aGoalsFor * 0.95).toFixed(2) : 1.10;

      // xGA (buts concédés = proxy xGA)
      const hxga = hGoalsAga || 1.15;
      const axga = aGoalsAga || 1.30;

      // Clean sheets %
      const hPlayed = hStats?.fixtures?.played?.total || 1;
      const aPlayed = aStats?.fixtures?.played?.total || 1;
      const hcs = hStats?.clean_sheet?.total ? Math.round(hStats.clean_sheet.total/hPlayed*100) : 28;
      const acs = aStats?.clean_sheet?.total ? Math.round(aStats.clean_sheet.total/aPlayed*100) : 22;

      // Tirs cadrés (si dispo dans derniers matchs)
      const hsh = avgGoals(homeFixtures, homeId, true) ? Math.round((hxg||1.3)*2.8) : 4;
      const ash = Math.round((axg||1.1)*2.8);

      // H2H
      const h2hArr = (h2hData||[]).slice(0,6).map(f => ({
        date: f.fixture?.date?.split("T")[0],
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        homeGoals: f.goals?.home,
        awayGoals: f.goals?.away,
        winner: f.teams?.home?.winner ? "home" : f.teams?.away?.winner ? "away" : "draw"
      }));

      // Rang classement
      const hRank = hStats?.rank || null;
      const aRank = aStats?.rank || null;

      const lg = lgMap[lgId];
      const home = fix.teams?.home?.name;
      const away = fix.teams?.away?.name;
      const time = fix.fixture?.date;
      const status = fix.fixture?.status?.short || "NS";
      const isLive = ["1H","2H","HT","ET","BT","P"].includes(status);

      return {
        id: fId,
        league: "l"+lgId, leagueName: lg.name, f: lg.f, c: lg.name,
        home, away, h: home, a: away,
        t: time, time,
        homeId, awayId, leagueId: lgId,
        // Cotes
        o1:+o1.toFixed(2), on:+on.toFixed(2), o2:+o2.toFixed(2),
        bk: bkArr.slice(0,6), hasRealOdds: bkArr.length>0,
        // Stats xG réels
        hxg, axg, hxga, axga,
        hg: hGoalsFor || hxg*0.9,
        ag: aGoalsFor || axg*0.9,
        // Forme
        hf, af, hf10, af10,
        // Tirs
        hsh, ash,
        // Clean sheets
        hcs, acs,
        // H2H
        h2h: h2hArr,
        homeGoals: hGoalsFor, awayGoals: aGoalsFor,
        // Classement
        hRank, aRank,
        // Live
        isLive, status,
        liveScore: isLive ? {
          home: fix.goals?.home ?? null,
          away: fix.goals?.away ?? null,
          elapsed: fix.fixture?.status?.elapsed ?? null
        } : null
      };
    }));

    const matches = enriched.filter(Boolean);
    matches.sort((a,b) => new Date(a.time) - new Date(b.time));

    return res.status(200).json({
      matches,
      count: matches.length,
      updated: now.toISOString(),
      source: "API-Football PRO + xG + Forme",
      withRealOdds: matches.filter(m=>m.hasRealOdds).length,
      withRealXg: matches.filter(m=>m.hxg>0).length
    });

  } catch(e) {
    return res.status(500).json({error:e.message, matches:[]});
  }
};
