// EDGE — api/enrich.js v3 — statistiques RÉELLES + infos qui font bouger les cotes (blessures, compos)
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
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
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

    // Coupes et sélections : les statistiques dans la compétition elle-même sont
    // inexploitables (1 à 2 matchs joués). On bascule sur le championnat national.
    const CUPS = new Set([2, 3, 848, 4, 5, 1, 34, 10, 667, 6, 7, 9, 15]);
    const isCup = CUPS.has(leagueId);

    async function domesticLeagueOf(teamId) {
      const d = await apiFetch(`/leagues?team=${teamId}&season=${season}&type=league`, KEY);
      if (!Array.isArray(d) || !d.length) return null;
      // On prend le championnat national (le plus souvent unique pour ces clubs)
      const dom = d.find(x => x.league && x.league.type === "League");
      return dom && dom.league ? dom.league.id : null;
    }

    let hLeague = leagueId, aLeague = leagueId;
    if (isCup || !leagueId) {
      const [hd, ad] = await Promise.all([domesticLeagueOf(homeId), domesticLeagueOf(awayId)]);
      hLeague = hd || leagueId;
      aLeague = ad || leagueId;
    }

    const tasks = [
      apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10`, KEY),
      hLeague ? apiFetch(`/teams/statistics?team=${homeId}&league=${hLeague}&season=${season}`, KEY) : Promise.resolve(null),
      aLeague ? apiFetch(`/teams/statistics?team=${awayId}&league=${aLeague}&season=${season}`, KEY) : Promise.resolve(null),
    ];

    let [h2hRaw, hRaw, aRaw] = await Promise.all(tasks);

    let homeStats = mapStats(hRaw, "home");
    let awayStats = mapStats(aRaw, "away");

    // Début de saison : peu ou pas de matchs joués → on prend la saison précédente
    if ((hLeague || aLeague) && (!homeStats || homeStats.played < 4 || !awayStats || awayStats.played < 4)) {
      const prev = season - 1;
      const [hPrev, aPrev] = await Promise.all([
        hLeague ? apiFetch(`/teams/statistics?team=${homeId}&league=${hLeague}&season=${prev}`, KEY) : Promise.resolve(null),
        aLeague ? apiFetch(`/teams/statistics?team=${awayId}&league=${aLeague}&season=${prev}`, KEY) : Promise.resolve(null),
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

    // ── Infos décisionnelles : absents et compositions ──
    // C'est ce qui déplace réellement une cote — bien plus qu'une actualité générale.
    let injuries = [], lineups = null;
    const fixtureId = parseInt(q.fixtureId, 10);
    if (fixtureId) {
      const [injRaw, lupRaw] = await Promise.all([
        apiFetch(`/injuries?fixture=${fixtureId}`, KEY),
        apiFetch(`/fixtures/lineups?fixture=${fixtureId}`, KEY),
      ]);
      if (Array.isArray(injRaw)) {
        injuries = injRaw.map(x => ({
          team: x.team && x.team.id === homeId ? "home" : "away",
          name: x.player && x.player.name ? x.player.name : null,
          reason: x.player && x.player.reason ? x.player.reason : null,
          type: x.player && x.player.type ? x.player.type : null,
        })).filter(x => x.name).slice(0, 12);
      }
      if (Array.isArray(lupRaw) && lupRaw.length) {
        lineups = lupRaw.map(l => ({
          team: l.team && l.team.id === homeId ? "home" : "away",
          formation: l.formation || null,
          coach: l.coach && l.coach.name ? l.coach.name : null,
          starters: (l.startXI || []).map(p => p.player && p.player.name).filter(Boolean),
        }));
      }
    }

    const hasReal = !!(homeStats || awayStats || h2h.length >= 3 || injuries.length || lineups);
    if (!hasReal) return res.status(200).json({ error: "no_data" });

    return res.status(200).json({
      homeStats: homeStats || undefined,
      awayStats: awayStats || undefined,
      h2h: h2h.slice(0, 10),
      injuries: injuries,
      lineups: lineups,
      season,
      leaguesUsed: { home: hLeague, away: aLeague },
      source: "EDGE Enrich v2",
    });

  } catch (e) {
    return res.status(200).json({ error: e.message });
  }
};
