// EDGE - API Odds sécurisée
// La clé n'est JAMAIS dans le code
// Configure ODDS_API_KEY dans Vercel > Settings > Environment Variables

const LEAGUES = [
  "soccer_france_ligue_one",
  "soccer_spain_la_liga",
  "soccer_epl",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_portugal_primeira_liga",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league"
];

module.exports = async (req, res) => {

  // CORS - seulement ton domaine Vercel
  const allowed = ["https://predictx-pi.vercel.app", "http://localhost:3000"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Cle API depuis variable Vercel - jamais hardcodee
  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) {
    return res.status(500).json({
      error: "Cle API manquante. Va sur vercel.com > ton projet > Settings > Environment Variables > ajoute ODDS_API_KEY",
      matches: []
    });
  }

  try {
    const BK = "betclic,winamax,unibet,pinnacle,bet365,williamhill,bwin,ladbrokes";

    // Fetch toutes les ligues en parallele
    const fetches = LEAGUES.map(league =>
      fetch(
        `https://api.the-odds-api.com/v4/sports/${league}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=${BK}`,
        { headers: { "Accept": "application/json" } }
      )
      .then(r => {
        if (!r.ok) return [];
        return r.json();
      })
      .catch(() => [])
    );

    const results = await Promise.all(fetches);
    const allMatches = [];

    results.forEach((data, idx) => {
      if (!Array.isArray(data)) return;
      const league = LEAGUES[idx];

      data.forEach(game => {
        // Matchs des prochaines 48h seulement
        const gameTime = new Date(game.commence_time);
        const now = new Date();
        const hours = (gameTime - now) / 3600000;
        if (hours < -2 || hours > 48) return;

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

          const o1 = home.price;
          const o2 = away.price;
          const oN = draw ? draw.price : 0;

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
          home: game.home_team,
          away: game.away_team,
          time: game.commence_time,
          o1: parseFloat(bestO1.toFixed(2)),
          on: parseFloat(bestON.toFixed(2)),
          o2: parseFloat(bestO2.toFixed(2)),
          bk: bkOdds.slice(0, 6)
        });
      });
    });

    // Trier par heure
    allMatches.sort((a, b) => new Date(a.time) - new Date(b.time));

    return res.status(200).json({
      matches: allMatches,
      count: allMatches.length,
      updated: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({
      error: "Erreur serveur",
      matches: []
    });
  }
};

