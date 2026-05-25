// EDGE — api/enrich.js v3
// H2H + stats + forme + classement + compositions

async function apiFetch(url, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY       = process.env.FOOTBALL_API_KEY || "";
  const homeId    = req.query?.homeId;
  const awayId    = req.query?.awayId;
  const leagueId  = req.query?.leagueId;
  const fixtureId = req.query?.fixtureId;

  const _now = new Date();
  const season = req.query?.season ||
    String(_now.getMonth() < 7 ? _now.getFullYear()-1 : _now.getFullYear());

  if (!KEY || !homeId || !awayId) {
    return res.status(400).json({ error: "homeId + awayId requis" });
  }

  try {
    const [
      h2hData,
      homeStats,
      awayStats,
      homeFixtures,
      awayFixtures,
      standings,
      lineups,
      injuries,
    ] = await Promise.all([
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, KEY),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${homeId}`, KEY) : Promise.resolve(null),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${awayId}`, KEY) : Promise.resolve(null),
      apiFetch(`/fixtures?team=${homeId}&last=5&status=FT`, KEY),
      apiFetch(`/fixtures?team=${awayId}&last=5&status=FT`, KEY),
      leagueId ? apiFetch(`/standings?league=${leagueId}&season=${season}`, KEY) : Promise.resolve(null),
      fixtureId ? apiFetch(`/fixtures/lineups?fixture=${fixtureId}`, KEY) : Promise.resolve(null),
      fixtureId ? apiFetch(`/injuries?fixture=${fixtureId}`, KEY) : Promise.resolve(null),
    ]);

    /* ── H2H ── */
    const h2h = (h2hData || []).map(f => ({
      date:  f.fixture?.date?.split("T")[0],
      home:  f.teams?.home?.name,
      away:  f.teams?.away?.name,
      hG:    f.goals?.home ?? 0,
      aG:    f.goals?.away ?? 0,
      res:   f.goals?.home > f.goals?.away ? "H" : f.goals?.away > f.goals?.home ? "A" : "D",
    }));

    const h2hStats = h2h.length ? {
      total:    h2h.length,
      hWins:    h2h.filter(g => g.res==="H").length,
      aWins:    h2h.filter(g => g.res==="A").length,
      draws:    h2h.filter(g => g.res==="D").length,
      avgGoals: +(h2h.reduce((s,g)=>s+g.hG+g.aG,0)/h2h.length).toFixed(2),
      bttsRate: +(h2h.filter(g=>g.hG>0&&g.aG>0).length/h2h.length).toFixed(2),
      over25:   +(h2h.filter(g=>g.hG+g.aG>2).length/h2h.length).toFixed(2),
    } : null;

    /* ── Parser stats équipe ── */
    function parseStats(raw) {
      if (!raw?.[0]) return null;
      const d = raw[0];
      const played = d.fixtures?.played?.total || 1;
      const wins   = d.fixtures?.wins?.total   || 0;
      const draws  = d.fixtures?.draws?.total  || 0;
      const gf     = d.goals?.for?.total?.total   || 0;
      const ga     = d.goals?.against?.total?.total || 0;
      const form   = (d.form || "").slice(-5);
      const formW  = (form.match(/W/g)||[]).length;
      const formD  = (form.match(/D/g)||[]).length;
      const formScore = (formW*3+formD)/Math.max(1,form.length*3);
      return {
        played, wins, draws,
        gf: +(gf/played).toFixed(2),
        ga: +(ga/played).toFixed(2),
        winRate:    +(wins/played).toFixed(3),
        drawRate:   +(draws/played).toFixed(3),
        form, formW, formD,
        formScore:  +formScore.toFixed(3),
        cleanSheets: d.clean_sheet?.total || 0,
        failedScore: d.failed_to_score?.total || 0,
      };
    }

    const hStats = parseStats(homeStats);
    const aStats = parseStats(awayStats);

    /* ── Forme récente (5 derniers matchs) ── */
    function parseRecent(fixtures, teamId) {
      if (!fixtures?.length) return null;
      return fixtures.slice(0,5).map(f => {
        const isHome = f.teams?.home?.id === +teamId;
        const gf = isHome ? f.goals?.home : f.goals?.away;
        const ga = isHome ? f.goals?.away : f.goals?.home;
        const res = gf > ga ? "W" : ga > gf ? "L" : "D";
        return { date: f.fixture?.date?.split("T")[0], opp: isHome ? f.teams?.away?.name : f.teams?.home?.name, gf, ga, res };
      });
    }

    const hRecent = parseRecent(homeFixtures, homeId);
    const aRecent = parseRecent(awayFixtures, awayId);

    /* ── Classement ── */
    let hRank = null, aRank = null, hPoints = null, aPoints = null;
    if (standings?.[0]?.[0]?.league?.standings) {
      const table = standings[0][0].league.standings[0] || [];
      table.forEach(row => {
        if (row.team?.id === +homeId) { hRank = row.rank; hPoints = row.points; }
        if (row.team?.id === +awayId) { aRank = row.rank; aPoints = row.points; }
      });
    }

    /* ── Compositions ── */
    let hLineup = null, aLineup = null;
    if (lineups?.length) {
      const hL = lineups.find(l => l.team?.id === +homeId);
      const aL = lineups.find(l => l.team?.id === +awayId);
      if (hL) hLineup = {
        formation: hL.formation,
        coach: hL.coach?.name,
        startXI: (hL.startXI||[]).map(p => ({ name: p.player?.name, pos: p.player?.pos, number: p.player?.number })),
      };
      if (aL) aLineup = {
        formation: aL.formation,
        coach: aL.coach?.name,
        startXI: (aL.startXI||[]).map(p => ({ name: p.player?.name, pos: p.player?.pos, number: p.player?.number })),
      };
    }

    /* ── Blessés/Suspendus ── */
    let hInjuries = [], aInjuries = [];
    if (injuries?.length) {
      injuries.forEach(inj => {
        const entry = { name: inj.player?.name, type: inj.player?.reason, pos: inj.player?.type };
        if (inj.team?.id === +homeId) hInjuries.push(entry);
        if (inj.team?.id === +awayId) aInjuries.push(entry);
      });
    }

    /* ── xG enrichi ── */
    let hxg = null, axg = null;
    if (hStats && aStats) {
      hxg = +((hStats.gf + aStats.ga) / 2 * 1.05).toFixed(2);
      axg = +((aStats.gf + hStats.ga) / 2 * 0.95).toFixed(2);
    }

    return res.status(200).json({
      h2h,
      h2hStats,
      homeStats:  hStats,
      awayStats:  aStats,
      hRecent,
      aRecent,
      hLineup,
      aLineup,
      hInjuries,
      aInjuries,
      hRank, aRank,
      hPoints, aPoints,
      enriched: {
        hxg, axg,
        hg:           hStats?.gf    || null,
        ag:           aStats?.gf    || null,
        hf:           hStats ? Math.round(hStats.winRate * 15) : null,
        af:           aStats ? Math.round(aStats.winRate * 15) : null,
        hForm:        hStats?.form?.slice(-5) || null,
        aForm:        aStats?.form?.slice(-5) || null,
        hWinRate:     hStats?.winRate  || null,
        aWinRate:     aStats?.winRate  || null,
        hFormScore:   hStats?.formScore || 0.5,
        aFormScore:   aStats?.formScore || 0.5,
        hCleanSheets: hStats?.cleanSheets || null,
        aCleanSheets: aStats?.cleanSheets || null,
        hasLineups:   !!(hLineup && aLineup),
        hasInjuries:  !!(hInjuries.length || aInjuries.length),
      }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
