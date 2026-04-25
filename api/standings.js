// EDGE - API Football V3 - Classements toutes ligues
// FOOTBALL_API_KEY dans Vercel env vars

const LEAGUES = [
  {id:61,  name:"Ligue 1",          f:"FR", flag:"🇫🇷"},
  {id:140, name:"La Liga",          f:"ES", flag:"🇪🇸"},
  {id:39,  name:"Premier League",   f:"ENG",flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿"},
  {id:135, name:"Serie A",          f:"IT", flag:"🇮🇹"},
  {id:78,  name:"Bundesliga",       f:"DE", flag:"🇩🇪"},
  {id:2,   name:"Champions League", f:"UCL",flag:"⭐"},
  {id:3,   name:"Europa League",    f:"UEL",flag:"🟠"},
  {id:848, name:"Conference League",f:"UEL",flag:"🟤"},
  {id:94,  name:"Liga Portugal",    f:"PT", flag:"🇵🇹"},
  {id:88,  name:"Eredivisie",       f:"NL", flag:"🇳🇱"},
  {id:144, name:"Pro League",       f:"BE", flag:"🇧🇪"},
  {id:203, name:"Super Lig",        f:"TR", flag:"🇹🇷"},
  {id:179, name:"Premiership",      f:"SCO",flag:"🏴󠁧󠁢󠁳󠁣󠁴󠁿"}
];

async function apiFetch(url, key, ms = 8000) {
  try {
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: AbortSignal.timeout(ms)
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch (e) { return null; }
}

// Batch : max 5 requêtes en parallèle avec pause entre batches
async function batch(items, fn, size = 5, delay = 300) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    const res = await Promise.all(items.slice(i, i + size).map(fn));
    out.push(...res);
    if (i + size < items.length) await new Promise(r => setTimeout(r, delay));
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Cache 1h — les classements ne changent pas toutes les minutes
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=7200");

  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if (!KEY) return res.status(500).json({ error: "FOOTBALL_API_KEY manquante", standings: [] });

  const now    = new Date();
  const season = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;

  try {
    // Fetch tous les classements en batch
    const results = await batch(LEAGUES, async lg => {
      const data = await apiFetch(`/standings?league=${lg.id}&season=${season}`, KEY);
      if (!data?.length) return null;

      // L'API retourne un tableau de groupes (ex: Champions League a plusieurs groupes)
      const groups = data[0]?.league?.standings || [];

      const parsedGroups = groups.map((group, gIdx) => {
        const rows = (Array.isArray(group) ? group : [group]).map(team => ({
          rank:        team.rank,
          team:        team.team?.name,
          teamId:      team.team?.id,
          logo:        team.team?.logo,
          played:      team.all?.played || 0,
          win:         team.all?.win    || 0,
          draw:        team.all?.draw   || 0,
          lose:        team.all?.lose   || 0,
          goalsFor:    team.all?.goals?.for    || 0,
          goalsAgainst:team.all?.goals?.against|| 0,
          goalDiff:    team.goalsDiff || 0,
          points:      team.points    || 0,
          form:        team.form      || "",
          // Statut (Champions, Europa, Relegation...)
          status:      team.description || "",
          // Derniers résultats
          last5:       (team.form || "").slice(-5).split(""),
          // Home & away séparés
          home: {
            played: team.home?.played || 0,
            win:    team.home?.win    || 0,
            draw:   team.home?.draw   || 0,
            lose:   team.home?.lose   || 0,
            gf:     team.home?.goals?.for     || 0,
            ga:     team.home?.goals?.against || 0
          },
          away: {
            played: team.away?.played || 0,
            win:    team.away?.win    || 0,
            draw:   team.away?.draw   || 0,
            lose:   team.away?.lose   || 0,
            gf:     team.away?.goals?.for     || 0,
            ga:     team.away?.goals?.against || 0
          }
        }));

        return {
          groupName: rows.length > 0 && groups.length > 1 ? `Groupe ${gIdx + 1}` : null,
          rows
        };
      });

      return {
        leagueId:   lg.id,
        leagueName: lg.name,
        f:          lg.f,
        flag:       lg.flag,
        season,
        groups:     parsedGroups,
        // Flat pour accès rapide (premier groupe = classement principal)
        standings:  parsedGroups[0]?.rows || []
      };
    });

    const standings = results.filter(Boolean);

    return res.status(200).json({
      standings,
      count:   standings.length,
      season,
      updated: now.toISOString(),
      source:  "API-Football V3 Standings"
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, standings: [] });
  }
};

