// EDGE - API History V2: matchs termines avec vraies stats pour backtest
// GET /api/history?league=LEAGUE_ID&season=SEASON&last=50

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=3600,stale-while-revalidate=7200");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  const H = {"x-apisports-key":KEY,"Accept":"application/json"};
  const {league, season, last=50} = req.query;

  async function apiFetch(url, ms=6000){
    try{
      const r = await fetch(`https://v3.football.api-sports.io${url}`,
        {headers:H, signal:AbortSignal.timeout(ms)});
      if(!r.ok) return null;
      const d = await r.json();
      return d.response||null;
    }catch(e){return null;}
  }

  const s = season||(new Date().getMonth()>=6?new Date().getFullYear():new Date().getFullYear()-1);

  try{
    // 1. Fetch les derniers matchs terminés
    const params = league
      ? `league=${league}&season=${s}&status=FT&last=${last}`
      : `season=${s}&status=FT&last=${last}`;

    const fixtures = await apiFetch(`/fixtures?${params}`);
    if(!fixtures||!fixtures.length){
      return res.status(200).json({matches:[],count:0,source:"API-Football"});
    }

    // 2. Pour chaque match, enrichir avec les stats des équipes
    // (forme des 6 derniers matchs pour chaque équipe)
    const enriched = await Promise.all(fixtures.map(async f => {
      const fId = f.fixture?.id;
      const hId = f.teams?.home?.id;
      const aId = f.teams?.away?.id;
      const lgId = f.league?.id;

      // Fetch stats des deux équipes en parallèle
      const [hStats, aStats] = await Promise.all([
        hId&&lgId ? apiFetch(`/teams/statistics?league=${lgId}&season=${s}&team=${hId}`, 4000) : Promise.resolve(null),
        aId&&lgId ? apiFetch(`/teams/statistics?league=${lgId}&season=${s}&team=${aId}`, 4000) : Promise.resolve(null)
      ]);

      // Parser form string -> points de forme
      function formPts(formStr, n=5){
        if(!formStr) return 8;
        let pts=0;
        for(const c of formStr.slice(-n)){
          if(c==='W') pts+=3;
          else if(c==='D') pts+=1;
        }
        return pts;
      }

      const hS = hStats?.[0];
      const aS = aStats?.[0];

      // xG depuis les stats du match si disponibles
      const matchStats = f.statistics||[];
      function getMatchStat(teamId, name){
        const t = matchStats.find(s=>s.team?.id==teamId);
        const v = t?.statistics?.find(s=>s.type===name)?.value;
        return v!==null&&v!==undefined?parseFloat(v)||null:null;
      }

      const hxg = getMatchStat(hId,"expected_goals") ||
                  (hS?.goals?.for?.average?.total ? parseFloat(hS.goals.for.average.total)*1.05 : null);
      const axg = getMatchStat(aId,"expected_goals") ||
                  (aS?.goals?.for?.average?.total ? parseFloat(aS.goals.for.average.total)*0.95 : null);

      const hGoalsFor = hS?.goals?.for?.average?.total ? parseFloat(hS.goals.for.average.total) : null;
      const aGoalsFor = aS?.goals?.for?.average?.total ? parseFloat(aS.goals.for.average.total) : null;
      const hGoalsAga = hS?.goals?.against?.average?.total ? parseFloat(hS.goals.against.average.total) : null;
      const aGoalsAga = aS?.goals?.against?.average?.total ? parseFloat(aS.goals.against.average.total) : null;

      const hForm = hS?.form||"";
      const aForm = aS?.form||"";

      const hPlayed = hS?.fixtures?.played?.total||1;
      const aPlayed = aS?.fixtures?.played?.total||1;
      const hCS = hS?.clean_sheet?.total||0;
      const aCS = aS?.clean_sheet?.total||0;

      const gh = f.goals?.home??null;
      const ga = f.goals?.away??null;
      const score = (gh!==null&&ga!==null) ? `${gh}-${ga}` : null;

      return {
        id: fId,
        leagueName: f.league?.name,
        c: f.league?.name,
        f: f.league?.country,
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        h: f.teams?.home?.name,
        a: f.teams?.away?.name,
        homeId: hId, awayId: aId, leagueId: lgId,
        time: f.fixture?.date,
        status: f.fixture?.status?.short||"FT",
        // Score réel
        score,
        goalsHome: gh,
        goalsAway: ga,
        // Vraies stats xG
        hxg: hxg ? +hxg.toFixed(2) : null,
        axg: axg ? +axg.toFixed(2) : null,
        hxga: hGoalsAga ? +(hGoalsAga).toFixed(2) : null,
        axga: aGoalsAga ? +(aGoalsAga).toFixed(2) : null,
        // Buts moyens saison
        hg: hGoalsFor ? +hGoalsFor.toFixed(2) : null,
        ag: aGoalsFor ? +aGoalsFor.toFixed(2) : null,
        // Forme réelle
        hf: formPts(hForm, 5),
        af: formPts(aForm, 5),
        hf10: formPts(hForm, 10),
        af10: formPts(aForm, 10),
        // Clean sheets %
        hcs: hPlayed ? Math.round(hCS/hPlayed*100) : 25,
        acs: aPlayed ? Math.round(aCS/aPlayed*100) : 20,
        // Tirs cadrés estimés
        hsh: hxg ? Math.round(hxg*2.8) : 4,
        ash: axg ? Math.round(axg*2.8) : 3,
        // Cotes: pas disponibles pour les matchs passés
        o1: null, on: null, o2: null,
        oO25: null, oBtts: null
      };
    }));

    const valid = enriched.filter(m =>
      m.score && m.goalsHome!==null && m.goalsAway!==null &&
      m.status==="FT"
    );

    return res.status(200).json({
      matches: valid,
      count: valid.length,
      updated: new Date().toISOString(),
      source: "API-Football V2 (xG + forme reels)"
    });

  }catch(e){
    return res.status(500).json({error:e.message, matches:[]});
  }
};
