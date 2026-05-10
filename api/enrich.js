// EDGE — api/enrich.js
// Enrichit un match avec H2H + stats xG réels depuis l'API Football

async function apiFetch(url, key, ms=6000) {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY    = process.env.FOOTBALL_API_KEY || "";
  const homeId = req.query?.homeId;
  const awayId = req.query?.awayId;
  const season = req.query?.season || new Date().getFullYear();
  const leagueId = req.query?.leagueId;

  if (!KEY || !homeId || !awayId) {
    return res.status(400).json({ error: "homeId + awayId requis" });
  }

  try {
    // Fetch en parallèle: H2H + stats des 2 équipes
    const [h2hData, homeStats, awayStats] = await Promise.all([
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=8`, KEY),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${homeId}`, KEY) : Promise.resolve(null),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${awayId}`, KEY) : Promise.resolve(null),
    ]);

    // H2H
    const h2h = (h2hData || []).map(f => ({
      date:      f.fixture?.date,
      home:      f.teams?.home?.name,
      away:      f.teams?.away?.name,
      homeGoals: f.goals?.home ?? 0,
      awayGoals: f.goals?.away ?? 0,
      winner:    f.goals?.home > f.goals?.away ? "home"
               : f.goals?.away > f.goals?.home ? "away" : "draw"
    }));

    // Stats xG équipe DOM
    const hs = homeStats?.[0];
    const as_ = awayStats?.[0];
    
    function extractStats(s) {
      if (!s) return null;
      const played = s.fixtures?.played?.total || 0;
      return {
        played,
        wins:     s.fixtures?.wins?.total || 0,
        draws:    s.fixtures?.draws?.total || 0,
        loses:    s.fixtures?.loses?.total || 0,
        goalsFor: played > 0 ? +((s.goals?.for?.total?.total || 0) / played).toFixed(2) : null,
        goalsAgainst: played > 0 ? +((s.goals?.against?.total?.total || 0) / played).toFixed(2) : null,
        cleanSheets: s.clean_sheet?.total || 0,
        failedToScore: s.failed_to_score?.total || 0,
        form: s.form || "",
        winRate: played > 0 ? +((s.fixtures?.wins?.total || 0) / played).toFixed(3) : null,
        // xG si disponible
        xgFor:     s.goals?.for?.average?.total ? parseFloat(s.goals.for.average.total) : null,
        xgAgainst: s.goals?.against?.average?.total ? parseFloat(s.goals.against.average.total) : null,
      };
    }

    const homeStatsClean = extractStats(hs);
    const awayStatsClean = extractStats(as_);

    // Calcul xG enrichi
    let hxg = null, axg = null;
    if (homeStatsClean?.goalsFor && awayStatsClean?.goalsAgainst) {
      hxg = +((homeStatsClean.goalsFor + awayStatsClean.goalsAgainst) / 2).toFixed(2);
    }
    if (awayStatsClean?.goalsFor && homeStatsClean?.goalsAgainst) {
      axg = +((awayStatsClean.goalsFor + homeStatsClean.goalsAgainst) / 2).toFixed(2);
    }

    // H2H stats
    const h2hStats = h2h.length ? {
      total:    h2h.length,
      homeWins: h2h.filter(g => g.winner === "home").length,
      awayWins: h2h.filter(g => g.winner === "away").length,
      draws:    h2h.filter(g => g.winner === "draw").length,
      avgGoals: +(h2h.reduce((s,g) => s + g.homeGoals + g.awayGoals, 0) / h2h.length).toFixed(2),
      bttsRate: +(h2h.filter(g => g.homeGoals > 0 && g.awayGoals > 0).length / h2h.length).toFixed(2),
    } : null;

    return res.status(200).json({
      h2h,
      h2hStats,
      homeStats: homeStatsClean,
      awayStats: awayStatsClean,
      enriched: {
        hxg, axg,
        hWinRate: homeStatsClean?.winRate,
        aWinRate: awayStatsClean?.winRate,
        hForm:    homeStatsClean?.form?.slice(-5),
        aForm:    awayStatsClean?.form?.slice(-5),
        hGoalsFor:  homeStatsClean?.goalsFor,
        aGoalsFor:  awayStatsClean?.goalsFor,
      }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

