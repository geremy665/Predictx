// EDGE — api/enrich.js v4 Pro
// H2H + stats + forme + classement + compositions + blessés + stats match live

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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY       = process.env.FOOTBALL_API_KEY || "";
  const homeId    = req.query?.homeId;
  const awayId    = req.query?.awayId;
  const leagueId  = req.query?.leagueId;
  const fixtureId = req.query?.fixtureId;

  const now = new Date();
  const season = req.query?.season ||
    String(now.getMonth() < 7 ? now.getFullYear()-1 : now.getFullYear());

  if (!KEY || !homeId || !awayId) {
    return res.status(400).json({ error: "homeId + awayId requis" });
  }

  try {
    // Tout en parallèle pour minimiser la latence
    const [
      h2hData,
      homeStats,
      awayStats,
      homeFixtures,
      awayFixtures,
      standings,
      lineups,
      injuries,
      fixtureStats,
    ] = await Promise.all([
      // H2H — 10 dernières confrontations
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, KEY),
      // Stats saison équipes
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${homeId}`, KEY) : null,
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${awayId}`, KEY) : null,
      // Forme récente — 5 derniers matchs
      apiFetch(`/fixtures?team=${homeId}&last=5&status=FT`, KEY),
      apiFetch(`/fixtures?team=${awayId}&last=5&status=FT`, KEY),
      // Classement
      leagueId ? apiFetch(`/standings?league=${leagueId}&season=${season}`, KEY) : null,
      // Compositions (disponibles ~1h avant)
      fixtureId ? apiFetch(`/fixtures/lineups?fixture=${fixtureId}`, KEY) : null,
      // Blessés/Suspendus
      fixtureId ? apiFetch(`/injuries?fixture=${fixtureId}`, KEY) : null,
      // Stats du match en live
      fixtureId ? apiFetch(`/fixtures/statistics?fixture=${fixtureId}`, KEY) : null,
    ]);

    /* ── H2H ── */
    const h2h = (h2hData || []).map(f => ({
      date: f.fixture?.date?.split("T")[0],
      home: f.teams?.home?.name,
      away: f.teams?.away?.name,
      hG:   f.goals?.home ?? 0,
      aG:   f.goals?.away ?? 0,
      res:  f.goals?.home > f.goals?.away ? "H"
          : f.goals?.away > f.goals?.home ? "A" : "D",
    }));

    const h2hStats = h2h.length >= 2 ? {
      total:    h2h.length,
      hWins:    h2h.filter(g => g.res==="H").length,
      aWins:    h2h.filter(g => g.res==="A").length,
      draws:    h2h.filter(g => g.res==="D").length,
      avgGoals: +(h2h.reduce((s,g)=>s+g.hG+g.aG,0)/h2h.length).toFixed(2),
      bttsRate: +(h2h.filter(g=>g.hG>0&&g.aG>0).length/h2h.length).toFixed(2),
      over25:   +(h2h.filter(g=>g.hG+g.aG>2).length/h2h.length).toFixed(2),
    } : null;

    /* ── Stats équipe ── */
    function parseStats(raw) {
      if (!raw?.[0]) return null;
      const d = raw[0];
      const played = d.fixtures?.played?.total || 1;
      const wins   = d.fixtures?.wins?.total   || 0;
      const draws  = d.fixtures?.draws?.total  || 0;
      const gf     = d.goals?.for?.total?.total    || 0;
      const ga     = d.goals?.against?.total?.total || 0;
      const form   = (d.form || "").slice(-5);
      const formW  = (form.match(/W/g)||[]).length;
      const formD  = (form.match(/D/g)||[]).length;
      const formScore = (formW*3+formD)/Math.max(1,form.length*3);

      // Forme domicile/extérieur séparée — clé Pro
      const homePlayed = d.fixtures?.played?.home || 0;
      const homeWins   = d.fixtures?.wins?.home   || 0;
      const awayPlayed = d.fixtures?.played?.away || 0;
      const awayWins   = d.fixtures?.wins?.away   || 0;

      // xG si disponible
      const xgFor  = d.goals?.for?.total?.xg    || null;
      const xgAgst = d.goals?.against?.total?.xg || null;

      // Tirs cadrés moyens
      const shotsOn  = d.shots?.on?.total  || null;
      const shotsOff = d.shots?.off?.total || null;

      return {
        played, wins, draws,
        gf:  +(gf/played).toFixed(2),
        ga:  +(ga/played).toFixed(2),
        xgF: xgFor  ? +(xgFor/played).toFixed(2)  : null,
        xgA: xgAgst ? +(xgAgst/played).toFixed(2) : null,
        shotsOn:  shotsOn  ? +(shotsOn/played).toFixed(1)  : null,
        shotsOff: shotsOff ? +(shotsOff/played).toFixed(1) : null,
        winRate:   +(wins/played).toFixed(3),
        drawRate:  +(draws/played).toFixed(3),
        homeWinRate: homePlayed ? +(homeWins/homePlayed).toFixed(3) : null,
        awayWinRate: awayPlayed ? +(awayWins/awayPlayed).toFixed(3) : null,
        form, formW, formD,
        formScore:   +formScore.toFixed(3),
        cleanSheets: d.clean_sheet?.total || 0,
        failedScore: d.failed_to_score?.total || 0,
      };
    }

    const hStats = parseStats(homeStats);
    const aStats = parseStats(awayStats);

    /* ── Forme récente ── */
    function parseRecent(fixtures, teamId) {
      if (!fixtures?.length) return null;
      return fixtures.slice(0,5).map(f => {
        const isHome = f.teams?.home?.id === +teamId;
        const gf = isHome ? f.goals?.home : f.goals?.away;
        const ga = isHome ? f.goals?.away : f.goals?.home;
        const res = gf > ga ? "W" : ga > gf ? "L" : "D";
        return {
          date: f.fixture?.date?.split("T")[0],
          opp:  isHome ? f.teams?.away?.name : f.teams?.home?.name,
          gf, ga, res,
          xgF: null, // Pas disponible dans cet endpoint
        };
      });
    }

    const hRecent = parseRecent(homeFixtures, homeId);
    const aRecent = parseRecent(awayFixtures, awayId);

    /* ── Classement ── */
    let hRank=null, aRank=null, hPoints=null, aPoints=null;
    let hHomeWins=null, aAwayWins=null; // Forme dom/ext depuis classement
    if (standings?.[0]?.[0]?.league?.standings) {
      const table = standings[0][0].league.standings[0] || [];
      table.forEach(row => {
        if (row.team?.id === +homeId) {
          hRank   = row.rank;
          hPoints = row.points;
          hHomeWins = row.home?.win || null;
        }
        if (row.team?.id === +awayId) {
          aRank   = row.rank;
          aPoints = row.points;
          aAwayWins = row.away?.win || null;
        }
      });
    }

    /* ── Compositions ── */
    let hLineup=null, aLineup=null;
    if (lineups?.length) {
      const hL = lineups.find(l => l.team?.id === +homeId);
      const aL = lineups.find(l => l.team?.id === +awayId);
      if (hL) hLineup = {
        formation: hL.formation,
        coach:     hL.coach?.name,
        startXI:  (hL.startXI||[]).map(p => ({
          name:   p.player?.name,
          pos:    p.player?.pos,
          number: p.player?.number,
          grid:   p.player?.grid,
        })),
        substitutes: (hL.substitutes||[]).map(p => ({
          name: p.player?.name,
          pos:  p.player?.pos,
        })),
      };
      if (aL) aLineup = {
        formation: aL.formation,
        coach:     aL.coach?.name,
        startXI:  (aL.startXI||[]).map(p => ({
          name:   p.player?.name,
          pos:    p.player?.pos,
          number: p.player?.number,
        })),
        substitutes: (aL.substitutes||[]).map(p => ({
          name: p.player?.name,
          pos:  p.player?.pos,
        })),
      };
    }

    /* ── Blessés/Suspendus ── */
    let hInjuries=[], aInjuries=[];
    if (injuries?.length) {
      injuries.forEach(inj => {
        const entry = {
          name:   inj.player?.name,
          pos:    inj.player?.type,
          reason: inj.player?.reason,
        };
        if (inj.team?.id === +homeId) hInjuries.push(entry);
        if (inj.team?.id === +awayId) aInjuries.push(entry);
      });
    }

    /* ── Stats match live ── */
    let liveStats = null;
    if (fixtureStats?.length) {
      const hLive = fixtureStats.find(s => s.team?.id === +homeId);
      const aLive = fixtureStats.find(s => s.team?.id === +awayId);
      if (hLive || aLive) {
        const getStat = (team, name) => {
          const s = team?.statistics?.find(s => s.type === name);
          return s?.value || null;
        };
        liveStats = {
          hPossession: getStat(hLive, "Ball Possession"),
          aPossession: getStat(aLive, "Ball Possession"),
          hShots:      getStat(hLive, "Total Shots"),
          aShots:      getStat(aLive, "Total Shots"),
          hShotsOn:    getStat(hLive, "Shots on Goal"),
          aShotsOn:    getStat(aLive, "Shots on Goal"),
          hCorners:    getStat(hLive, "Corner Kicks"),
          aCorners:    getStat(aLive, "Corner Kicks"),
          hXG:         getStat(hLive, "expected_goals"),
          aXG:         getStat(aLive, "expected_goals"),
        };
      }
    }

    /* ── xG enrichis ── */
    // Priorité: xG réel > stats moyennes > dérivé des cotes
    const hxg = hStats?.xgF || hStats?.gf || null;
    const axg = aStats?.xgF || aStats?.gf || null;

    // Impact des blessés sur le xG
    let hxgAdj = hxg, axgAdj = axg;
    if (hxg && hInjuries.length) {
      const hAtt = hInjuries.filter(p => p.pos==="Attacker"||p.pos==="Midfielder").length;
      if (hAtt > 0) hxgAdj = +(hxg * (1-hAtt*0.035)).toFixed(2);
    }
    if (axg && aInjuries.length) {
      const aAtt = aInjuries.filter(p => p.pos==="Attacker"||p.pos==="Midfielder").length;
      if (aAtt > 0) axgAdj = +(axg * (1-aAtt*0.035)).toFixed(2);
    }

    return res.status(200).json({
      h2h,
      h2hStats,
      homeStats:   hStats,
      awayStats:   aStats,
      hRecent,
      aRecent,
      hLineup,
      aLineup,
      hInjuries,
      aInjuries,
      liveStats,
      hRank,  aRank,
      hPoints, aPoints,
      hHomeWins, aAwayWins,
      enriched: {
        hxg:   hxgAdj, axg: axgAdj,
        hxga:  aStats?.xgA || null,
        axga:  hStats?.xgA || null,
        hg:    hStats?.gf  || null,
        ag:    aStats?.gf  || null,
        hf:    hStats ? Math.round(hStats.winRate*15) : null,
        af:    aStats ? Math.round(aStats.winRate*15) : null,
        hsh:   hStats?.shotsOn ? Math.round(hStats.shotsOn) : null,
        ash:   aStats?.shotsOn ? Math.round(aStats.shotsOn) : null,
        hcs:   hStats?.cleanSheets || null,
        acs:   aStats?.cleanSheets || null,
        hForm: hStats?.form?.slice(-5) || null,
        aForm: aStats?.form?.slice(-5) || null,
        hWinRate:    hStats?.winRate  || null,
        aWinRate:    aStats?.winRate  || null,
        hHomeWinRate: hStats?.homeWinRate || null,
        aAwayWinRate: aStats?.awayWinRate || null,
        hFormScore:  hStats?.formScore || 0.5,
        aFormScore:  aStats?.formScore || 0.5,
        hasLineups:  !!(hLineup && aLineup),
        hasInjuries: !!(hInjuries.length || aInjuries.length),
        hasLiveStats: !!liveStats,
        hxgInjAdj:  hxg !== hxgAdj,
        axgInjAdj:  axg !== axgAdj,
      }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
