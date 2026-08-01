// EDGE — api/standings.js v1 — classement d'une ligue
// Entrée : ?league=<id>
// Sortie : { standings:[{rank,team:{id,name,logo},all:{played,win,draw,lose},points,goalsDiff,form,description}], season }

async function apiFetch(url, key, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 8000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ standings: [], error: "no_key" });

  const q = req.query || {};
  const leagueId = parseInt(q.league, 10);
  if (!leagueId) return res.status(200).json({ standings: [], error: "missing_league" });

  try {
    const now = new Date();
    let season = now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear();

    let resp = await apiFetch(`/standings?league=${leagueId}&season=${season}`, KEY);

    // Certaines compétitions (coupes UEFA en phase de groupes, saison qui vient
    // de démarrer) n'ont pas encore de classement pour la saison en cours.
    if (!resp || !resp.length) {
      season = season - 1;
      resp = await apiFetch(`/standings?league=${leagueId}&season=${season}`, KEY);
    }
    if (!resp || !resp.length) {
      return res.status(200).json({ standings: [], error: "no_data", leagueId, season });
    }

    // La forme peut être standings[0].league.standings[0] (groupe unique)
    // ou standings[0].league.standings (plusieurs groupes/poules)
    const lg = resp[0] && resp[0].league;
    let raw = [];
    if (lg && Array.isArray(lg.standings) && lg.standings.length) {
      raw = lg.standings[0] || [];
    }
    if (!raw.length) return res.status(200).json({ standings: [], error: "empty", leagueId, season });

    const standings = raw.map((r) => ({
      rank: r.rank,
      team: {
        id: r.team && r.team.id,
        name: r.team && r.team.name,
        logo: r.team && r.team.logo,
      },
      all: {
        played: r.all && r.all.played,
        win: r.all && r.all.win,
        draw: r.all && r.all.draw,
        lose: r.all && r.all.lose,
      },
      points: r.points,
      goalsDiff: r.goalsDiff,
      form: r.form,
      description: r.description,
    }));

    return res.status(200).json({
      standings,
      leagueId,
      season,
      leagueName: lg && lg.name,
      source: "EDGE Standings v1",
    });
  } catch (e) {
    return res.status(200).json({ standings: [], error: e.message });
  }
};
