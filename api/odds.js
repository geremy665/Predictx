// EDGE - API Odds securisee - 50 ligues - 72h
// Cle via variable Vercel : ODDS_API_KEY

const LEAGUES = [
  // France
  "soccer_france_ligue_one",
  "soccer_france_ligue_two",
  // Espagne
  "soccer_spain_la_liga",
  "soccer_spain_segunda_division",
  // Angleterre
  "soccer_epl",
  "soccer_england_championship",
  "soccer_england_league1",
  "soccer_england_league2",
  // Italie
  "soccer_italy_serie_a",
  "soccer_italy_serie_b",
  // Allemagne
  "soccer_germany_bundesliga",
  "soccer_germany_bundesliga2",
  // Portugal
  "soccer_portugal_primeira_liga",
  // Pays-Bas
  "soccer_netherlands_eredivisie",
  // Belgique
  "soccer_belgium_first_div",
  // Turquie
  "soccer_turkey_super_league",
  // Russie
  "soccer_russia_premier_league",
  // Ecosse
  "soccer_scotland_premiership",
  // Grece
  "soccer_greece_super_league",
  // Autriche
  "soccer_austria_bundesliga",
  // Tcheque
  "soccer_czech_republic_first_league",
  // Danemark
  "soccer_denmark_superliga",
  // Norvege
  "soccer_norway_eliteserien",
  // Suede
  "soccer_sweden_allsvenskan",
  // Suisse
  "soccer_switzerland_superleague",
  // Pologne
  "soccer_poland_ekstraklasa",
  // Roumanie
  "soccer_romania_liga1",
  // Croatie
  "soccer_croatia_hnl",
  // Serbie
  "soccer_serbia_superliga",
  // Ukraine
  "soccer_ukraine_premier_league",
  // Coupes UEFA
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
  "soccer_uefa_nations_league",
  // Amerique
  "soccer_usa_mls",
  "soccer_brazil_campeonato",
  "soccer_argentina_primera_division",
  "soccer_mexico_ligamx",
  "soccer_chile_primera_division",
  "soccer_colombia_primera_a",
  "soccer_ecuador_liga_pro",
  "soccer_peru_primera_division",
  // Asie / Reste
  "soccer_australia_aleague",
  "soccer_japan_j_league",
  "soccer_south_korea_kleague1",
  "soccer_china_superleague",
  "soccer_saudi_arabia_professional_league",
  "soccer_egypt_premier_league",
  "soccer_south_africa_premier_soccer_league"
];

const LMAP = {
  "soccer_france_ligue_one":"Ligue 1",
  "soccer_france_ligue_two":"Ligue 2",
  "soccer_spain_la_liga":"La Liga",
  "soccer_spain_segunda_division":"Segunda",
  "soccer_epl":"Premier League",
  "soccer_england_championship":"Championship",
  "soccer_england_league1":"League One",
  "soccer_england_league2":"League Two",
  "soccer_italy_serie_a":"Serie A",
  "soccer_italy_serie_b":"Serie B",
  "soccer_germany_bundesliga":"Bundesliga",
  "soccer_germany_bundesliga2":"Bundesliga 2",
  "soccer_portugal_primeira_liga":"Liga Portugal",
  "soccer_netherlands_eredivisie":"Eredivisie",
  "soccer_belgium_first_div":"Pro League",
  "soccer_turkey_super_league":"Super Lig",
  "soccer_russia_premier_league":"RPL",
  "soccer_scotland_premiership":"Premiership",
  "soccer_greece_super_league":"Super League",
  "soccer_austria_bundesliga":"Bundesliga AT",
  "soccer_czech_republic_first_league":"1. Liga CZ",
  "soccer_denmark_superliga":"Superliga DK",
  "soccer_norway_eliteserien":"Eliteserien",
  "soccer_sweden_allsvenskan":"Allsvenskan",
  "soccer_switzerland_superleague":"Super League CH",
  "soccer_poland_ekstraklasa":"Ekstraklasa",
  "soccer_romania_liga1":"Liga 1 RO",
  "soccer_croatia_hnl":"HNL",
  "soccer_serbia_superliga":"Superliga RS",
  "soccer_ukraine_premier_league":"UPL",
  "soccer_uefa_champs_league":"Champions League",
  "soccer_uefa_europa_league":"Europa League",
  "soccer_uefa_europa_conference_league":"Conference League",
  "soccer_uefa_nations_league":"Nations League",
  "soccer_usa_mls":"MLS",
  "soccer_brazil_campeonato":"Brasileirao",
  "soccer_argentina_primera_division":"Primera Div.",
  "soccer_mexico_ligamx":"Liga MX",
  "soccer_chile_primera_division":"Primera CL",
  "soccer_colombia_primera_a":"Liga BetPlay",
  "soccer_ecuador_liga_pro":"Liga Pro EC",
  "soccer_peru_primera_division":"Liga 1 PE",
  "soccer_australia_aleague":"A-League",
  "soccer_japan_j_league":"J-League",
  "soccer_south_korea_kleague1":"K League 1",
  "soccer_china_superleague":"Super League CN",
  "soccer_saudi_arabia_professional_league":"Saudi Pro League",
  "soccer_egypt_premier_league":"Egyptian PL",
  "soccer_south_africa_premier_soccer_league":"PSL"
};

module.exports = async (req, res) => {
  const allowed = ["https://predictx-pi.vercel.app", "http://localhost:3000"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const ODDS_KEY = process.env.ODDS_API_KEY;
  if (!ODDS_KEY) {
    return res.status(500).json({
      error: "Cle API manquante. Ajoute ODDS_API_KEY dans Vercel > Settings > Environment Variables.",
      matches: []
    });
  }

  try {
    const BK = "betclic,winamax,unibet,pinnacle,bet365,williamhill,bwin,ladbrokes,betfair,marathonbet";

    // Fetch toutes les ligues en parallele - par batch de 10 pour eviter timeout
    const batches = [];
    for (let i = 0; i < LEAGUES.length; i += 10) {
      batches.push(LEAGUES.slice(i, i + 10));
    }

    const allMatches = [];

    for (const batch of batches) {
      const fetches = batch.map(league =>
        fetch(
          `https://api.the-odds-api.com/v4/sports/${league}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=${BK}`,
          { headers: { "Accept": "application/json" } }
        )
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
      );

      const results = await Promise.all(fetches);

      results.forEach((data, idx) => {
        if (!Array.isArray(data)) return;
        const league = batch[idx];
        const leagueName = LMAP[league] || league;

        data.forEach(game => {
          const gameTime = new Date(game.commence_time);
          const now = new Date();
          const hours = (gameTime - now) / 3600000;
          // 72h = 3 jours a l'avance
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
    }

    allMatches.sort((a, b) => new Date(a.time) - new Date(b.time));

    return res.status(200).json({
      matches: allMatches,
      count: allMatches.length,
      updated: new Date().toISOString()
    });

  } catch (err) {
    return res.status(500).json({ error: "Erreur serveur", matches: [] });
  }
};
