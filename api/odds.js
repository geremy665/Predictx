// ═══════════════════════════════════════════════════════════════
// EDGE — api/odds.js v3
// Fixtures + stats + cotes avec Pinnacle comme référence sharp
// ═══════════════════════════════════════════════════════════════

const LEAGUES = [
  {id:61, name:"Ligue 1",        f:"FR"},
  {id:39, name:"Premier League", f:"ENG"},
  {id:140,name:"La Liga",        f:"ES"},
  {id:135,name:"Serie A",        f:"IT"},
  {id:78, name:"Bundesliga",     f:"DE"},
  {id:2,  name:"Champions League",f:"UCL"},
  {id:3,  name:"Europa League",  f:"UEL"},
  {id:848,name:"Conference League",f:"UECL"},
  {id:94, name:"Liga Portugal",  f:"PT"},
  {id:88, name:"Eredivisie",     f:"NL"},
  {id:144,name:"Pro League",     f:"BE"},
  {id:203,name:"Super Lig",      f:"TR"},
  {id:113,name:"Allsvenskan",    f:"SE"},
  {id:200,name:"Botola Pro",     f:"MA"},
  {id:179,name:"Premiership",    f:"SCO"},
  // Matchs internationaux
  {id:10, name:"Amicaux Nations",f:"INT"},
  {id:667,name:"Amicaux Clubs",  f:"AMI"},
  {id:4,  name:"Euro",           f:"EUR"},
  {id:5,  name:"UEFA Nations League",f:"UNL"},
  {id:6,  name:"Africa Cup",     f:"CAN"},
  {id:7,  name:"Asian Cup",      f:"ASI"},
  {id:9,  name:"Copa America",   f:"CAM"},
];

// Bookmakers sharp — par ordre de priorité
// Pinnacle est la référence mondiale (marge ~1%)
const SHARP_BOOKS = ["pinnacle","pinnacle sports","betfair","betfair exchange","smarkets","matchbook"];
const SOFT_BOOKS  = ["bet365","unibet","winamax","betclic","bwin","william hill","1xbet","betway","ladbrokes","coral","paddy power","netbet","zebet"];

const lgMap = {};
LEAGUES.forEach(l => { lgMap[l.id] = l; });

async function apiFetch(url, key, ms=6000){
  try{
    const r = await fetch(`https://v3.football.api-sports.io${url}`,{
      headers:{"x-apisports-key":key,"Accept":"application/json"},
      signal:AbortSignal.timeout(ms)
    });
    if(!r.ok) return null;
    const d = await r.json();
    return d.response||null;
  }catch(e){ return null; }
}

function formPts(formStr, n=5){
  if(!formStr) return null;
  const s = formStr.slice(-n);
  let pts=0;
  for(const c of s){ if(c==="W")pts+=3; else if(c==="D")pts+=1; }
  return pts;
}

function avgXg(fixtures, teamId){
  let total=0, count=0;
  for(const f of (fixtures||[]).slice(0,8)){
    const stats = f.statistics||[];
    const ts = stats.find(s=>s.team?.id==teamId);
    const xg = ts?.statistics?.find(s=>s.type==="expected_goals"||s.type==="Expected Goals")?.value;
    if(xg&&parseFloat(xg)>0){ total+=parseFloat(xg); count++; }
  }
  return count>=3 ? +(total/count).toFixed(2) : null;
}

// Extraction des cotes avec référence Pinnacle
function extractOdds(oddsData){
  if(!oddsData?.length) return {o1:0, on:0, o2:0, bkArr:[], pinnacle:null, hasSharp:false};

  let pinnacle = null;
  const softOdds = [];
  const allOdds = [];

  oddsData.forEach(entry=>{
    (entry.bookmakers||[]).forEach(bk=>{
      const name = (bk.bookmaker?.name||"").toLowerCase();
      const bet = (bk.bets||[]).find(b=>b.id===1||b.name==="Match Winner");
      if(!bet?.values) return;
      const hv = bet.values.find(v=>v.value==="Home");
      const dv = bet.values.find(v=>v.value==="Draw");
      const av = bet.values.find(v=>v.value==="Away");
      if(!hv||!av) return;
      const ho=parseFloat(hv.odd||0), do_=parseFloat(dv?.odd||0), ao=parseFloat(av.odd||0);
      if(ho<1.01||ao<1.01) return;

      const entry2 = {n:bk.bookmaker?.name||"Bk", o1:+ho.toFixed(2), on:+do_.toFixed(2), o2:+ao.toFixed(2)};

      // Identifier Pinnacle
      if(SHARP_BOOKS.some(s=>name.includes(s))){
        if(!pinnacle) pinnacle = entry2; // Prendre le premier sharp trouvé
      } else {
        softOdds.push(entry2);
      }
      allOdds.push(entry2);
    });
  });

  // Référence = Pinnacle si disponible, sinon moyenne no-vig des softs
  let refO1, refON, refO2;
  if(pinnacle){
    refO1 = pinnacle.o1;
    refON = pinnacle.on;
    refO2 = pinnacle.o2;
  } else if(allOdds.length > 0){
    // Moyenne no-vig des bookmakers disponibles
    // No-vig = enlever la marge du bookmaker pour avoir la proba réelle
    const avgH = allOdds.reduce((s,b)=>s+b.o1,0)/allOdds.length;
    const avgN = allOdds.reduce((s,b)=>s+b.on,0)/allOdds.length;
    const avgA = allOdds.reduce((s,b)=>s+b.o2,0)/allOdds.length;
    // Calcul no-vig
    const margin = 1/avgH + 1/avgN + 1/avgA;
    const pH = (1/avgH)/margin;
    const pN = (1/avgN)/margin;
    const pA = (1/avgA)/margin;
    refO1 = +(1/pH).toFixed(2);
    refON = +(1/pN).toFixed(2);
    refO2 = +(1/pA).toFixed(2);
  } else {
    return {o1:0, on:0, o2:0, bkArr:[], pinnacle:null, hasSharp:false};
  }

  // Détecter les value bets : bookmaker qui offre mieux que la référence
  const valueBks = softOdds.filter(bk=>{
    const edgeH = bk.o1/refO1 - 1;
    const edgeN = bk.on/refON - 1;
    const edgeA = bk.o2/refO2 - 1;
    return Math.max(edgeH, edgeN, edgeA) > 0.03; // +3% vs référence
  }).map(bk=>({
    ...bk,
    edgeH:+(bk.o1/refO1-1).toFixed(3),
    edgeN:+(bk.on/refON-1).toFixed(3),
    edgeA:+(bk.o2/refO2-1).toFixed(3)
  }));

  return {
    o1: refO1,
    on: refON,
    o2: refO2,
    bkArr: allOdds.slice(0,8),
    pinnacle: pinnacle,
    hasSharp: !!pinnacle,
    valueBks: valueBks.slice(0,4),
    hasRealOdds: allOdds.length > 0
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=3600,stale-while-revalidate=7200");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if(!KEY) return res.status(500).json({error:"FOOTBALL_API_KEY manquante",matches:[]});

  const now = new Date();
  const season = now.getMonth()>=6 ? now.getFullYear() : now.getFullYear()-1;
  const today = now.toISOString().split("T")[0];
  const tomorrow = new Date(now.getTime()+24*3600000).toISOString().split("T")[0];
  const day2 = new Date(now.getTime()+48*3600000).toISOString().split("T")[0];
  const day3 = new Date(now.getTime()+72*3600000).toISOString().split("T")[0];
  const day4 = new Date(now.getTime()+96*3600000).toISOString().split("T")[0];
  const day5 = new Date(now.getTime()+120*3600000).toISOString().split("T")[0];
  const day6 = new Date(now.getTime()+144*3600000).toISOString().split("T")[0];

  try{
    // Fetch fixtures 3 jours
    const [r1,r2,r3,r4,r5,r6,r7] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`, KEY),
      apiFetch(`/fixtures?date=${tomorrow}`, KEY),
      apiFetch(`/fixtures?date=${day2}`, KEY),
      apiFetch(`/fixtures?date=${day3}`, KEY),
      apiFetch(`/fixtures?date=${day4}`, KEY),
      apiFetch(`/fixtures?date=${day5}`, KEY),
      apiFetch(`/fixtures?date=${day6}`, KEY)
    ]);

    const allFix = [...(r1||[]),...(r2||[]),...(r3||[]),...(r4||[]),...(r5||[]),...(r6||[]),...(r7||[])]
      .filter(f=>lgMap[f.league?.id]);

    if(!allFix.length){
      return res.status(200).json({matches:[],count:0,updated:now.toISOString(),source:"API-Football"});
    }

    const enriched = await Promise.all(allFix.map(async fix=>{
      const fId = fix.fixture?.id;
      const homeId = fix.teams?.home?.id;
      const awayId = fix.teams?.away?.id;
      const lgId = fix.league?.id;
      const fixDate = fix.fixture?.date?.split("T")[0];

      // Enrichissement complet seulement pour aujourd'hui et demain
      // Pour les matchs plus loin → données de base uniquement (économise les calls API)
      const isCloseMatch = fixDate === today || fixDate === tomorrow;

      const [oddsData, homeFixtures, awayFixtures, homeStats, awayStats, h2hData] = await Promise.all([
        apiFetch(`/odds?fixture=${fId}&bet=1`, KEY, 5000),
        isCloseMatch ? apiFetch(`/fixtures?team=${homeId}&last=8&status=FT`, KEY, 5000) : Promise.resolve(null),
        isCloseMatch ? apiFetch(`/fixtures?team=${awayId}&last=8&status=FT`, KEY, 5000) : Promise.resolve(null),
        isCloseMatch ? apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${homeId}`, KEY, 5000) : Promise.resolve(null),
        isCloseMatch ? apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${awayId}`, KEY, 5000) : Promise.resolve(null),
        isCloseMatch ? apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=6`, KEY, 5000) : Promise.resolve(null)
      ]);

      // Cotes avec référence Pinnacle
      const oddsResult = extractOdds(oddsData);

      // Si pas de cotes réelles → on retourne le match sans cotes
      // On n'invente JAMAIS des cotes
      if(!oddsResult.hasRealOdds){
        oddsResult.o1 = 0;
        oddsResult.on = 0;
        oddsResult.o2 = 0;
      }

      // Stats saison
      const hSt = homeStats?.[0];
      const aSt = awayStats?.[0];

      // Forme
      const hFormStr = hSt?.form||"";
      const aFormStr = aSt?.form||"";
      const hf = formPts(hFormStr,5);
      const af = formPts(aFormStr,5);
      const hf10 = formPts(hFormStr,10);
      const af10 = formPts(aFormStr,10);

      // xG réels
      let hxg = avgXg(homeFixtures, homeId);
      let axg = avgXg(awayFixtures, awayId);

      // Buts moyens saison
      const hGoalsFor  = hSt?.goals?.for?.average?.total  ? parseFloat(hSt.goals.for.average.total)  : null;
      const hGoalsAga  = hSt?.goals?.against?.average?.total ? parseFloat(hSt.goals.against.average.total) : null;
      const aGoalsFor  = aSt?.goals?.for?.average?.total  ? parseFloat(aSt.goals.for.average.total)  : null;
      const aGoalsAga  = aSt?.goals?.against?.average?.total ? parseFloat(aSt.goals.against.average.total) : null;

      // xG estimé seulement si vraiment pas de données
      if(!hxg) hxg = hGoalsFor ? +(hGoalsFor*1.05).toFixed(2) : null;
      if(!axg) axg = aGoalsFor ? +(aGoalsFor*0.95).toFixed(2) : null;

      const hxga = hGoalsAga || null;
      const axga = aGoalsAga || null;

      // Clean sheets
      const hPlayed = hSt?.fixtures?.played?.total||1;
      const aPlayed = aSt?.fixtures?.played?.total||1;
      const hcs = hSt?.clean_sheet?.total ? Math.round(hSt.clean_sheet.total/hPlayed*100) : null;
      const acs = aSt?.clean_sheet?.total ? Math.round(aSt.clean_sheet.total/aPlayed*100) : null;

      // H2H
      const h2hArr = (h2hData||[]).slice(0,6).map(f=>({
        date:f.fixture?.date?.split("T")[0],
        home:f.teams?.home?.name,
        away:f.teams?.away?.name,
        homeGoals:f.goals?.home,
        awayGoals:f.goals?.away,
        winner:f.teams?.home?.winner?"home":f.teams?.away?.winner?"away":"draw"
      }));

      // H2H stats résumées
      const h2hStats = h2hArr.length>=3 ? {
        total:h2hArr.length,
        hWins:h2hArr.filter(g=>g.winner==="home").length,
        aWins:h2hArr.filter(g=>g.winner==="away").length,
        draws:h2hArr.filter(g=>g.winner==="draw").length,
      } : null;

      const lg = lgMap[lgId];
      const status = fix.fixture?.status?.short||"NS";
      const isLive = ["1H","2H","HT","ET","BT","P"].includes(status);

      return {
        id:fId,
        league:"l"+lgId, leagueName:lg.name, f:lg.f, c:lg.name,
        home:fix.teams?.home?.name, away:fix.teams?.away?.name,
        h:fix.teams?.home?.name, a:fix.teams?.away?.name,
        t:fix.fixture?.date, time:fix.fixture?.date,
        homeId, awayId, leagueId:lgId,
        // Cotes — référence Pinnacle ou no-vig
        o1:oddsResult.o1, on:oddsResult.on, o2:oddsResult.o2,
        bk:oddsResult.bkArr,
        pinnacle:oddsResult.pinnacle,
        hasSharp:oddsResult.hasSharp,
        valueBks:oddsResult.valueBks||[],
        hasRealOdds:oddsResult.hasRealOdds,
        // Stats
        hxg, axg, hxga, axga,
        hg:hGoalsFor, ag:aGoalsFor,
        hf, af, hf10, af10,
        hcs, acs,
        hsh:hxg?Math.round(hxg*2.8):null,
        ash:axg?Math.round(axg*2.8):null,
        hMatchesPlayed:hSt?.fixtures?.played?.total||null,
        aMatchesPlayed:aSt?.fixtures?.played?.total||null,
        hRank:hSt?.rank||null, aRank:aSt?.rank||null,
        // H2H
        h2h:h2hArr, h2hStats,
        // Live
        isLive, status,
        liveScore:isLive?{
          home:fix.goals?.home??null,
          away:fix.goals?.away??null,
          elapsed:fix.fixture?.status?.elapsed??null
        }:null
      };
    }));

    const matches = enriched.filter(Boolean);
    matches.sort((a,b)=>new Date(a.time)-new Date(b.time));

    return res.status(200).json({
      matches,
      count:matches.length,
      updated:now.toISOString(),
      source:"API-Football + Pinnacle référence",
      withRealOdds:matches.filter(m=>m.hasRealOdds).length,
      withPinnacle:matches.filter(m=>m.hasSharp).length,
      withXg:matches.filter(m=>m.hxg).length
    });

  }catch(e){
    return res.status(500).json({error:e.message, matches:[]});
  }
};
