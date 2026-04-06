// EDGE - API combinée: The Odds API (cotes) + API-Football (stats, xG, forme)
// Clés via Vercel env vars:
//   ODDS_API_KEY = ea06a842490d88237ac6d7cf4bfbb5e9
//   FOOTBALL_API_KEY = 1b0e438b9c43c15718edc46efc601c28

const LEAGUES_ODDS = [
  "soccer_france_ligue_one","soccer_france_ligue_two",
  "soccer_spain_la_liga","soccer_epl","soccer_england_championship",
  "soccer_italy_serie_a","soccer_germany_bundesliga","soccer_germany_bundesliga2",
  "soccer_portugal_primeira_liga","soccer_netherlands_eredivisie",
  "soccer_belgium_first_div","soccer_turkey_super_league",
  "soccer_scotland_premiership","soccer_greece_super_league",
  "soccer_uefa_champs_league","soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league",
  "soccer_usa_mls","soccer_brazil_campeonato",
  "soccer_argentina_primera_division"
];

// API-Football league IDs (correspondance)
const FOOTBALL_LEAGUES = {
  "soccer_france_ligue_one": 61,
  "soccer_france_ligue_two": 62,
  "soccer_spain_la_liga": 140,
  "soccer_epl": 39,
  "soccer_england_championship": 40,
  "soccer_italy_serie_a": 135,
  "soccer_germany_bundesliga": 78,
  "soccer_germany_bundesliga2": 79,
  "soccer_portugal_primeira_liga": 94,
  "soccer_netherlands_eredivisie": 88,
  "soccer_belgium_first_div": 144,
  "soccer_turkey_super_league": 203,
  "soccer_scotland_premiership": 179,
  "soccer_greece_super_league": 197,
  "soccer_uefa_champs_league": 2,
  "soccer_uefa_europa_league": 3,
  "soccer_uefa_europa_conference_league": 848,
  "soccer_usa_mls": 253,
  "soccer_brazil_campeonato": 71,
  "soccer_argentina_primera_division": 128
};

const LMAP = {
  "soccer_france_ligue_one":"Ligue 1","soccer_france_ligue_two":"Ligue 2",
  "soccer_spain_la_liga":"La Liga","soccer_epl":"Premier League",
  "soccer_england_championship":"Championship","soccer_italy_serie_a":"Serie A",
  "soccer_germany_bundesliga":"Bundesliga","soccer_germany_bundesliga2":"Bundesliga 2",
  "soccer_portugal_primeira_liga":"Liga Portugal","soccer_netherlands_eredivisie":"Eredivisie",
  "soccer_belgium_first_div":"Pro League","soccer_turkey_super_league":"Super Lig",
  "soccer_scotland_premiership":"Premiership","soccer_greece_super_league":"Super League GR",
  "soccer_uefa_champs_league":"Champions League","soccer_uefa_europa_league":"Europa League",
  "soccer_uefa_europa_conference_league":"Conference League",
  "soccer_usa_mls":"MLS","soccer_brazil_campeonato":"Brasileirao",
  "soccer_argentina_primera_division":"Primera Division"
};

const FLAG_MAP = {
  "soccer_france_ligue_one":"FR","soccer_france_ligue_two":"FR",
  "soccer_spain_la_liga":"ES","soccer_epl":"ENG","soccer_england_championship":"ENG",
  "soccer_italy_serie_a":"IT","soccer_germany_bundesliga":"DE","soccer_germany_bundesliga2":"DE",
  "soccer_portugal_primeira_liga":"PT","soccer_netherlands_eredivisie":"NL",
  "soccer_belgium_first_div":"BE","soccer_turkey_super_league":"TR",
  "soccer_scotland_premiership":"SCO","soccer_greece_super_league":"GR",
  "soccer_uefa_champs_league":"UCL","soccer_uefa_europa_league":"UEL",
  "soccer_uefa_europa_conference_league":"UEL",
  "soccer_usa_mls":"USA","soccer_brazil_campeonato":"BRA",
  "soccer_argentina_primera_division":"ARG"
};

module.exports = async (req, res) => {
  const allowed = ["https://predictx-pi.vercel.app","http://localhost:3000"];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="GET") return res.status(405).json({error:"Method not allowed"});

  const ODDS_KEY = process.env.ODDS_API_KEY;
  const FB_KEY = process.env.FOOTBALL_API_KEY;

  if (!ODDS_KEY) return res.status(500).json({error:"ODDS_API_KEY manquante",matches:[]});

  try {
    const BK = "betclic,winamax,unibet,pinnacle,bet365,williamhill,bwin,ladbrokes";
    const season = new Date().getFullYear();

    // === STEP 1: Fetch cotes depuis The Odds API ===
    const oddsResults = await Promise.all(
      LEAGUES_ODDS.map(league =>
        fetch(
          `https://api.the-odds-api.com/v4/sports/${league}/odds/?apiKey=${ODDS_KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=${BK}`,
          { signal: AbortSignal.timeout(8000) }
        )
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
      )
    );

    // Construire la liste des matchs avec cotes
    const allMatches = [];
    oddsResults.forEach((data, idx) => {
      if (!Array.isArray(data)) return;
      const league = LEAGUES_ODDS[idx];
      const leagueName = LMAP[league] || league;
      const flag = FLAG_MAP[league] || "INT";

      data.forEach(game => {
        const gameTime = new Date(game.commence_time);
        const now = new Date();
        const hours = (gameTime - now) / 3600000;
        if (hours < -2 || hours > 72) return;

        let bestO1=0, bestON=0, bestO2=0;
        const bkOdds = [];

        (game.bookmakers||[]).forEach(bk => {
          const h2h = (bk.markets||[]).find(m => m.key==="h2h");
          if (!h2h) return;
          const outcomes = h2h.outcomes||[];
          const home = outcomes.find(o => o.name===game.home_team);
          const away = outcomes.find(o => o.name===game.away_team);
          const draw = outcomes.find(o => o.name==="Draw");
          if (!home||!away) return;
          const o1=home.price, o2=away.price, oN=draw?draw.price:0;
          if (o1>bestO1) bestO1=o1;
          if (oN>bestON) bestON=oN;
          if (o2>bestO2) bestO2=o2;
          bkOdds.push({n:bk.title, o1:parseFloat(o1.toFixed(2)), on:parseFloat(oN.toFixed(2)), o2:parseFloat(o2.toFixed(2))});
        });

        if (!bestO1||!bestO2) return;

        allMatches.push({
          id: game.id,
          league, leagueName, f: flag,
          home: game.home_team, away: game.away_team,
          time: game.commence_time,
          o1: parseFloat(bestO1.toFixed(2)),
          on: parseFloat(bestON.toFixed(2)),
          o2: parseFloat(bestO2.toFixed(2)),
          bk: bkOdds.slice(0,8),
          // Stats API-Football (remplies ci-dessous)
          hxg:null, axg:null, hxga:null, axga:null,
          hf:null, af:null, hf10:null, af10:null,
          hg:null, ag:null
        });
      });
    });

    allMatches.sort((a,b) => new Date(a.time)-new Date(b.time));

    // === STEP 2: Enrichir avec API-Football si clé disponible ===
    if (FB_KEY && allMatches.length > 0) {
      try {
        // Fetch les fixtures a venir pour chaque ligue unique
        const uniqueLeagues = [...new Set(allMatches.map(m => m.league))];
        const fbLeagueIds = uniqueLeagues.map(l => FOOTBALL_LEAGUES[l]).filter(Boolean);

        // Fetch stats d'equipes (forme) pour toutes les ligues en parallel
        const statsPromises = fbLeagueIds.slice(0,8).map(leagueId =>
          fetch(
            `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}&next=10`,
            {
              headers: {
                "x-apisports-key": FB_KEY,
                "Accept": "application/json"
              },
              signal: AbortSignal.timeout(5000)
            }
          )
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
        );

        const fbResults = await Promise.all(statsPromises);

        // Construire une map team -> stats
        const teamStatsMap = {};

        // Fetch team stats pour les equipes des matchs
        const teamFetches = [];
        allMatches.slice(0,10).forEach(m => {
          // On enrichit avec les donnees de forme via standings
          const leagueId = FOOTBALL_LEAGUES[m.league];
          if (leagueId && FB_KEY) {
            teamFetches.push(
              fetch(
                `https://v3.football.api-sports.io/teams/statistics?league=${leagueId}&season=${season}&team=0`,
                { headers:{"x-apisports-key":FB_KEY}, signal:AbortSignal.timeout(3000) }
              ).catch(() => null)
            );
          }
        });

        // Enrichir les matchs avec les fixtures API-Football
        fbResults.forEach(fbData => {
          if (!fbData || !fbData.response) return;
          fbData.response.forEach(fixture => {
            const homeTeam = fixture.teams?.home?.name;
            const awayTeam = fixture.teams?.away?.name;
            const fixtureDate = fixture.fixture?.date;
            if (!homeTeam || !awayTeam || !fixtureDate) return;

            // Trouver le match correspondant dans notre liste
            const match = allMatches.find(m => {
              const mDate = new Date(m.time).toDateString();
              const fDate = new Date(fixtureDate).toDateString();
              return mDate === fDate && (
                m.home.toLowerCase().includes(homeTeam.toLowerCase().split(' ')[0]) ||
                homeTeam.toLowerCase().includes(m.home.toLowerCase().split(' ')[0])
              );
            });

            if (match && fixture.teams) {
              // Ajouter l'ID de fixture pour enrichissement futur
              match.fixtureId = fixture.fixture?.id;
              match.homeId = fixture.teams.home?.id;
              match.awayId = fixture.teams.away?.id;
              match.leagueId = fixture.league?.id;

              // Status du match
              if (fixture.fixture?.status?.short === "LIVE" ||
                  fixture.fixture?.status?.short === "1H" ||
                  fixture.fixture?.status?.short === "2H") {
                match.isLive = true;
                match.liveScore = {
                  home: fixture.goals?.home,
                  away: fixture.goals?.away,
                  elapsed: fixture.fixture?.status?.elapsed
                };
              }
            }
          });
        });

        // Fetch stats individuelles pour enrichir xG, forme
        if (allMatches.length > 0 && FB_KEY) {
          const statFetches = allMatches.slice(0,5).map(m => {
            if (!m.homeId || !m.leagueId) return Promise.resolve(null);
            return fetch(
              `https://v3.football.api-sports.io/teams/statistics?league=${m.leagueId}&season=${season}&team=${m.homeId}`,
              { headers:{"x-apisports-key":FB_KEY}, signal:AbortSignal.timeout(4000) }
            )
            .then(r => r.ok ? r.json() : null)
            .then(data => ({matchId:m.id, side:"home", data}))
            .catch(() => null);
          });

          const statResults = await Promise.all(statFetches);
          statResults.forEach(result => {
            if (!result || !result.data || !result.data.response) return;
            const stats = result.data.response;
            const match = allMatches.find(m => m.id === result.matchId);
            if (!match || !stats) return;

            // Extraire les stats importantes
            const goals = stats.goals;
            const fixtures = stats.fixtures;
            if (goals && fixtures && fixtures.played) {
              const played = fixtures.played.home + fixtures.played.away;
              if (played > 0) {
                const goalsFor = goals.for?.total?.total || 0;
                const goalsAga = goals.against?.total?.total || 0;
                if (result.side === "home") {
                  match.hg = parseFloat((goalsFor/played).toFixed(2));
                  match.hxg = match.hg; // Approximation
                  match.hxga = parseFloat((goalsAga/played).toFixed(2));
                  match.hf = Math.min(15, Math.round(fixtures.wins?.total * 3 + fixtures.draws?.total));
                  match.hf10 = Math.round(match.hf * 2);
                }
              }
            }
          });
        }
      } catch(fbErr) {
        // API-Football a echoue - on continue avec juste les cotes
        console.error("API-Football error:", fbErr.message);
      }
    }

    return res.status(200).json({
      matches: allMatches,
      count: allMatches.length,
      updated: new Date().toISOString(),
      sources: {
        odds: "The Odds API",
        stats: FB_KEY ? "API-Football" : "cotes uniquement"
      }
    });

  } catch(err) {
    return res.status(500).json({error:"Erreur serveur: "+err.message, matches:[]});
  }
};
