// EDGE - API Odds securisee
// Cle via variable Vercel : ODDS_API_KEY

const LEAGUES = [
  "soccer_france_ligue_one",
  "soccer_france_ligue_two",
  "soccer_spain_la_liga",
  "soccer_epl",
  "soccer_england_championship",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_portugal_primeira_liga",
  "soccer_netherlands_eredivisie",
  "soccer_belgium_first_div",
  "soccer_turkey_super_league",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
  "soccer_usa_mls",
  "soccer_brazil_campeonato",
  "soccer_argentina_primera_division",
  "soccer_scotland_premiership",
  "soccer_greece_super_league",
  "soccer_germany_bundesliga2"
];

const LMAP = {
  "soccer_france_ligue_one":"Ligue 1",
  "soccer_france_ligue_two":"Ligue 2",
  "soccer_spain_la_liga":"La Liga",
  "soccer_epl":"Premier League",
  "soccer_england_championship":"Championship",
  "soccer_italy_serie_a":"Serie A",
  "soccer_germany_bundesliga":"Bundesliga",
  "soccer_portugal_primeira_liga":"Liga Portugal",
  "soccer_netherlands_eredivisie":"Eredivisie",
  "soccer_belgium_first_div":"Pro League",
  "soccer_turkey_super_league":"Super Lig",
  "soccer_uefa_champs_league":"Champions League",
  "soccer_uefa_europa_league":"Europa League",
  "soccer_uefa_europa_conference_league":"Conference League",
  "soccer_usa_mls":"MLS",
  "soccer_brazil_campeonato":"Brasileirao",
  "soccer_argentina_primera_division":"Primera Division",
  "soccer_scotland_premiership":"Premiership",
  "soccer_greece_super_league":"Super League GR",
  "soccer_germany_bundesliga2":"Bundesliga 2"
};

module.exports = async (req, res) => {
  const allowed = ["https://predictx-pi.vercel.app", "http://localhost:3000"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) {
    return res.status(500).json({ error: "Cle API manquante", matches: [] });
  }

  try {
    const BK = "betclic,winamax,unibet,pinnacle,bet365,williamhill,bwin,ladbrokes";
    const allMatches = [];

    // Fetch toutes les ligues en parallele - simple et rapide
    const fetches = LEAGUES.map(league =>
      fetch(
        `https://api.the-odds-api.com/v4/sports/${league}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=${BK}`,
        { signal: AbortSignal.timeout(8000) }
      )
      .then(r => r.ok ? r.json() : [])
      .catch(() => [])
    );

    const results = await Promise.all(fetches);

    results.forEach((data, idx) => {
      if (!Array.isArray(data)) return;
      const league = LEAGUES[idx];
      const leagueName = LMAP[league] || league;

      data.forEach(game => {
        const gameTime = new Date(game.commence_time);
        const now = new Date();
        const hours = (gameTime - now) / 3600000;
        // 72h = 3 jours
        if (hours < -2 || hours > 72) return;

        let bestO1 = 0, bestON = 0, bestO2 = 0;
        const bkOdds = [];

        (game.bookmakers || []).forEach(bk => {
          const h2h = (bk.markets || []).find(m => m.key === "h2h");
          if (!h2h) return;
          const outcomes = h2h.outcomes || [];
          const home = outcomes.find(o => o.name === game.home_team);
          const away = outcomes.find(o => o.name === game.away_team);
          const draw = outcomes.find(o => o.name === "Draw");
          if (!home || !away) return;

          const o1 = home.price, o2 = away.price, oN = draw ? draw.price : 0;
          if (o1 > bestO1) bestO1 = o1;
          if (oN > bestON) bestON = oN;
          if (o2 > bestO2) bestO2 = o2;

          bkOdds.push({
            n: bk.title,
            o1: parseFloat(o1.toFixed(2)),
            on: parseFloat(oN.toFixed(2)),
            o2: parseFloat(o2.toFixed(2))
          });
        });

        if (!bestO1 || !bestO2) return;

        allMatches.push({
          id: game.id,
          league,
          leagueName,
          home: game.home_team,
          away: game.away_team,
          time: game.commence_time,
          o1: parseFloat(bestO1.toFixed(2)),
          on: parseFloat(bestON.toFixed(2)),
          o2: parseFloat(bestO2.toFixed(2)),
          bk: bkOdds.slice(0, 8)
        });
      });
    });

    allMatches.sort((a, b) => new Date(a.time) - new Date(b.time));

    return res.status(200).json({
      matches: allMatches,
      count: allMatches.length,
      updated: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur: " + err.message, matches: [] });
  }
};
