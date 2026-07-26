// EDGE — api/enrich.js v1 — statistiques RÉELLES des équipes
// Remplace les stats dérivées des cotes par des données indépendantes du marché.
// Entrée : ?homeId=&awayId=&leagueId=&fixtureId=
// Sortie : { homeStats, awayStats, h2h, source }

function num(v, fb) {
  if (v === null || v === undefined || v === "") return fb;
  const n = parseFloat(v);
  return isNaN(n) ? fb : n;
}

async function apiFetch(url, key, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 7000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response !== undefined ? d.response : null;
  } catch (e) { return null; }
}

// Transforme la réponse /teams/statistics en stats exploitables par le moteur
// side = "home" | "away" → on utilise les moyennes SPÉCIFIQUES au terrain
function mapStats(resp, side) {
  if (!resp || !resp.fixtures) return null;
  const g = resp.goals || {};
  const gf = (g.for && g.for.average) || {};
  const ga = (g.against && g.against.average) || {};
  const fx = resp.fixtures || {};
  const played = num(fx.played && fx.played[side], 0) || num(fx.played && fx.played.total, 0);
  if (!played) return null;

  const wins = num(fx.wins && fx.wins[side], null);
  const winsTot = num(fx.wins && fx.wins.total, 0);
  const playedTot = num(fx.played && fx.played.total, 0);

  // Moyenne du terrain concerné, repli sur la moyenne totale
  const avgFor = num(gf[side], num(gf.total, 1.3));
  const avgAga = num(ga[side], num(ga.total, 1.3));

  const cs = resp.clean_sheet || {};
  const cleanSheets = num(cs[side], num(cs.total, 0));

  // Forme : 5 derniers résultats
  let form = "";
  if (typeof resp.form === "string" && resp.form.length) {
    form = resp.form.slice(-5);
  }

  const winRate = (wins !== null && played)
    ? wins / played
    : (playedTot ? winsTot / playedTot : null);

  return {
    avgGoalsFor: Math.round(avgFor * 100) / 100,
    avgGoalsAga: Math.round(avgAga * 100) / 100,
    form: form,
    cleanSheets: cleanSheets,
    played: played,
    winRate: winRate !== null ? Math.round(winRate * 1000) / 1000 : undefined,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cache Vercel : les stats d'équipe bougent au plus une fois par jour
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ error: "no_key" });

  const q = req.query || {};
  const homeId = parseInt(q.homeId, 10);
  const awayId = parseInt(q.awayId, 10);
  const leagueId = parseInt(q.leagueId, 10);
  if (!homeId || !awayId) return res.status(200).json({ error: "missing_ids" });

  try {
    const now = new Date();
    // Saison européenne : août → juillet
    const season = now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear();

    const tasks = [
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, KEY),
    ];
    if (leagueId) {
      tasks.push(apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${season}`, KEY));
      tasks.push(apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${season}`, KEY));
    }

    let [h2hRaw, hRaw, aRaw] = await Promise.all(tasks);

    let homeStats = mapStats(hRaw, "home");
    let awayStats = mapStats(aRaw, "away");

    // Début de saison : peu ou pas de matchs joués → on prend la saison précédente
    if (leagueId && (!homeStats || homeStats.played < 4 || !awayStats || awayStats.played < 4)) {
      const prev = season - 1;
      const [hPrev, aPrev] = await Promise.all([
        apiFetch(`/teams/statistics?team=${homeId}&league=${leagueId}&season=${prev}`, KEY),
        apiFetch(`/teams/statistics?team=${awayId}&league=${leagueId}&season=${prev}`, KEY),
      ]);
      const hp = mapStats(hPrev, "home");
      const ap = mapStats(aPrev, "away");
      if ((!homeStats || homeStats.played < 4) && hp) homeStats = hp;
      if ((!awayStats || awayStats.played < 4) && ap) awayStats = ap;
    }

    // Confrontations directes
    const h2h = [];
    if (Array.isArray(h2hRaw)) {
      for (const f of h2hRaw) {
        const gh = f.goals && f.goals.home;
        const ga = f.goals && f.goals.away;
        if (gh === null || gh === undefined || ga === null || ga === undefined) continue;
        const hostIsHome = f.teams && f.teams.home && f.teams.home.id === homeId;
        // On normalise dans le sens du match courant
        h2h.push({
          gh: hostIsHome ? gh : ga,
          ga: hostIsHome ? ga : gh,
          date: (f.fixture && f.fixture.date) ? f.fixture.date.split("T")[0] : null,
        });
      }
    }

    const hasReal = !!(homeStats || awayStats || h2h.length >= 3);
    if (!hasReal) return res.status(200).json({ error: "no_data" });

    return res.status(200).json({
      homeStats: homeStats || undefined,
      awayStats: awayStats || undefined,
      h2h: h2h.slice(0, 10),
      season,
      source: "EDGE Enrich v1",
    });

  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
};
