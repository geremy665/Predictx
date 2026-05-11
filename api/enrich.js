// EDGE — api/enrich.js v2
// H2H + stats équipes + forme + xG réel

async function apiFetch(url, key) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
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
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY      = process.env.FOOTBALL_API_KEY || "";
  const homeId   = req.query?.homeId;
  const awayId   = req.query?.awayId;
  const leagueId = req.query?.leagueId;
  const season   = req.query?.season || "2025";

  if (!KEY || !homeId || !awayId) {
    return res.status(400).json({ error: "homeId + awayId requis" });
  }

  try {
    // Fetch en parallèle — H2H + stats home + stats away
    const [h2hData, homeData, awayData] = await Promise.all([
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, KEY),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${homeId}`, KEY) : Promise.resolve(null),
      leagueId ? apiFetch(`/teams/statistics?league=${leagueId}&season=${season}&team=${awayId}`, KEY) : Promise.resolve(null),
    ]);

    // ── H2H
    const h2h = (h2hData || []).map(f => ({
      date:  f.fixture?.date,
      home:  f.teams?.home?.name,
      away:  f.teams?.away?.name,
      hG:    f.goals?.home ?? 0,
      aG:    f.goals?.away ?? 0,
      res:   f.goals?.home > f.goals?.away ? "H" : f.goals?.away > f.goals?.home ? "A" : "D"
    }));

    const h2hStats = h2h.length ? {
      total:   h2h.length,
      hWins:   h2h.filter(g => g.res === "H").length,
      aWins:   h2h.filter(g => g.res === "A").length,
      draws:   h2h.filter(g => g.res === "D").length,
      avgGoals:+(h2h.reduce((s,g) => s+g.hG+g.aG, 0)/h2h.length).toFixed(2),
      bttsRate:+(h2h.filter(g => g.hG>0&&g.aG>0).length/h2h.length).toFixed(2),
      over25:  +(h2h.filter(g => g.hG+g.aG>2).length/h2h.length).toFixed(2),
    } : null;

    // ── Stats équipe
    function parseStats(s) {
      if (!s?.[0]) return null;
      const d = s[0];
      const played = d.fixtures?.played?.total || 1;
      const wins   = d.fixtures?.wins?.total   || 0;
      const draws  = d.fixtures?.draws?.total  || 0;
      const gf     = d.goals?.for?.total?.total   || 0;
      const ga     = d.goals?.against?.total?.total || 0;

      // Forme récente (5 derniers matchs)
      const form = (d.form || "").slice(-5);
      const formW = (form.match(/W/g)||[]).length;
      const formD = (form.match(/D/g)||[]).length;
      const formL = (form.match(/L/g)||[]).length;
      const formScore = (formW*3+formD)/Math.max(1,form.length*3);

      // Puissance d'attaque/défense vs moyenne ligue
      const lgAvgGF = d.goals?.for?.average?.total  ? parseFloat(d.goals.for.average.total)  : null;
      const lgAvgGA = d.goals?.against?.average?.total ? parseFloat(d.goals.against.average.total) : null;

      return {
        played, wins, draws,
        gf: +(gf/played).toFixed(2),
        ga: +(ga/played).toFixed(2),
        winRate:   +(wins/played).toFixed(3),
        drawRate:  +(draws/played).toFixed(3),
        form, formW, formD, formL,
        formScore: +formScore.toFixed(3),
        cleanSheets: d.clean_sheet?.total || 0,
        failedScore: d.failed_to_score?.total || 0,
        xgFor:  lgAvgGF,
        xgAga:  lgAvgGA,
      };
    }

    const hStats = parseStats(homeData);
    const aStats = parseStats(awayData);

    // ── xG enrichi
    let hxg = null, axg = null;
    if (hStats && aStats) {
      // Modèle Dixon-Coles simplifié: attaque × défense adverse
      const hAtk = hStats.gf || 1.35;
      const aAtk = aStats.gf || 1.10;
      const hDef = hStats.ga || 1.20;
      const aDef = aStats.ga || 1.00;
      hxg = +((hAtk + aDef) / 2 * 1.05).toFixed(2); // avantage domicile
      axg = +((aAtk + hDef) / 2 * 0.95).toFixed(2);
    }

    // ── Force relative
    let hFormScore = hStats?.formScore || 0.5;
    let aFormScore = aStats?.formScore || 0.5;

    return res.status(200).json({
      h2h,
      h2hStats,
      homeStats: hStats,
      awayStats: aStats,
      enriched: {
        hxg, axg,
        hg:   hStats?.gf    || null,
        ag:   aStats?.gf    || null,
        hf:   hStats ? Math.round(hStats.winRate * 15) : null,
        af:   aStats ? Math.round(aStats.winRate * 15) : null,
        hForm: hStats?.form?.slice(-5) || null,
        aForm: aStats?.form?.slice(-5) || null,
        hWinRate:  hStats?.winRate  || null,
        aWinRate:  aStats?.winRate  || null,
        hFormScore, aFormScore,
        hCleanSheets: hStats?.cleanSheets || null,
        aCleanSheets: aStats?.cleanSheets || null,
      }
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
