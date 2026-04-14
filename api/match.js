// EDGE - Match details: lineups, H2H, injuries, standings, weather
// FOOTBALL_API_KEY dans Vercel env vars

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if(!KEY) return res.status(500).json({error:"FOOTBALL_API_KEY manquante"});

  const H = {"x-apisports-key":KEY,"Accept":"application/json"};
  const {fixtureId, homeId, awayId, leagueId} = req.query;

  if(!fixtureId) return res.status(400).json({error:"fixtureId requis"});

  try {
    const season = new Date().getFullYear();

    // Fetch tout en parallele
    const [
      lineups, injuries, h2h,
      homeStats, awayStats,
      standings, predictions
    ] = await Promise.all([
      // Compositions
      fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${fixtureId}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null),

      // Blessés et suspendus
      fetch(`https://v3.football.api-sports.io/injuries?fixture=${fixtureId}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null),

      // Face à face (10 derniers)
      homeId&&awayId ? fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null),

      // Stats équipe domicile
      homeId&&leagueId ? fetch(`https://v3.football.api-sports.io/teams/statistics?league=${leagueId}&season=${season}&team=${homeId}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null),

      // Stats équipe extérieur
      awayId&&leagueId ? fetch(`https://v3.football.api-sports.io/teams/statistics?league=${leagueId}&season=${season}&team=${awayId}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null),

      // Classement
      leagueId ? fetch(`https://v3.football.api-sports.io/standings?league=${leagueId}&season=${season}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null) : Promise.resolve(null),

      // Prédictions API-Football
      fetch(`https://v3.football.api-sports.io/predictions?fixture=${fixtureId}`,
        {headers:H,signal:AbortSignal.timeout(5000)}).then(r=>r.ok?r.json():null).catch(()=>null)
    ]);

    // Parser compositions
    const parseLineups = (data) => {
      if(!data||!data.response) return null;
      return data.response.map(team => ({
        team: team.team?.name,
        formation: team.formation,
        coach: team.coach?.name,
        startXI: (team.startXI||[]).map(p => ({
          name: p.player?.name,
          number: p.player?.number,
          pos: p.player?.pos,
          grid: p.player?.grid
        })),
        substitutes: (team.substitutes||[]).map(p => ({
          name: p.player?.name,
          number: p.player?.number,
          pos: p.player?.pos
        }))
      }));
    };

    // Parser blessés
    const parseInjuries = (data) => {
      if(!data||!data.response) return [];
      return data.response.map(i => ({
        player: i.player?.name,
        team: i.team?.name,
        type: i.player?.type,
        reason: i.player?.reason
      }));
    };

    // Parser H2H
    const parseH2H = (data) => {
      if(!data||!data.response) return [];
      return data.response.slice(0,8).map(f => ({
        date: f.fixture?.date?.split('T')[0],
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        homeGoals: f.goals?.home,
        awayGoals: f.goals?.away,
        winner: f.teams?.home?.winner ? 'home' : f.teams?.away?.winner ? 'away' : 'draw'
      }));
    };

    // Parser stats équipe
    const parseTeamStats = (data) => {
      if(!data||!data.response) return null;
      const s = data.response;
      const played = s.fixtures?.played?.total||0;
      const wins = s.fixtures?.wins?.total||0;
      const draws = s.fixtures?.draws?.total||0;
      const losses = s.fixtures?.loses?.total||0;
      const goalsFor = s.goals?.for?.total?.total||0;
      const goalsAga = s.goals?.against?.total?.total||0;
      const cleanSheets = s.clean_sheet?.total||0;

      // Forme récente (5 derniers)
      const form = s.form||'';
      const last5 = form.slice(-5).split('');

      return {
        played, wins, draws, losses,
        goalsFor, goalsAga,
        avgGoalsFor: played ? +(goalsFor/played).toFixed(2) : 0,
        avgGoalsAga: played ? +(goalsAga/played).toFixed(2) : 0,
        cleanSheets,
        form: last5,
        winRate: played ? +((wins/played)*100).toFixed(0) : 0,
        biggestWin: s.biggest?.wins?.home||'--',
        biggestLoss: s.biggest?.loses?.away||'--',
        streak: s.biggest?.streak?.wins||0
      };
    };

    // Parser classement
    const parseStandings = (data, teamId) => {
      if(!data||!data.response) return null;
      const groups = data.response[0]?.league?.standings||[];
      for(const group of groups) {
        const entry = group.find(t => t.team?.id === parseInt(teamId));
        if(entry) return {
          rank: entry.rank,
          points: entry.points,
          played: entry.all?.played,
          wins: entry.all?.win,
          draws: entry.all?.draw,
          losses: entry.all?.lose,
          goalsFor: entry.all?.goals?.for,
          goalsAga: entry.all?.goals?.against,
          form: entry.form
        };
      }
      return null;
    };

    // Parser prédictions
    const parsePredictions = (data) => {
      if(!data||!data.response||!data.response[0]) return null;
      const p = data.response[0];
      return {
        winner: p.predictions?.winner?.name,
        winnerComment: p.predictions?.winner?.comment,
        winPercent: p.predictions?.percent,
        advice: p.predictions?.advice,
        goals: p.predictions?.goals,
        homeForm: p.teams?.home?.league?.form,
        awayForm: p.teams?.away?.league?.form,
        comparison: p.comparison
      };
    };

    return res.status(200).json({
      fixtureId,
      lineups: parseLineups(lineups),
      injuries: parseInjuries(injuries),
      h2h: parseH2H(h2h),
      homeStats: parseTeamStats(homeStats),
      awayStats: parseTeamStats(awayStats),
      homeStanding: parseStandings(standings, homeId),
      awayStanding: parseStandings(standings, awayId),
      predictions: parsePredictions(predictions),
      updated: new Date().toISOString()
    });

  } catch(e) {
    return res.status(500).json({error:e.message});
  }
};
