// EDGE - API Odds simple et rapide
// ODDS_API_KEY requis dans Vercel env vars

const LEAGUES = [
  "soccer_france_ligue_one",
  "soccer_france_ligue_two", 
  "soccer_spain_la_liga",
  "soccer_epl",
  "soccer_italy_serie_a",
  "soccer_germany_bundesliga",
  "soccer_portugal_primeira_liga",
  "soccer_netherlands_eredivisie",
  "soccer_uefa_champs_league",
  "soccer_uefa_europa_league",
  "soccer_brazil_campeonato",
  "soccer_usa_mls"
];

const LMAP = {
  "soccer_france_ligue_one":"Ligue 1",
  "soccer_france_ligue_two":"Ligue 2",
  "soccer_spain_la_liga":"La Liga",
  "soccer_epl":"Premier League",
  "soccer_italy_serie_a":"Serie A",
  "soccer_germany_bundesliga":"Bundesliga",
  "soccer_portugal_primeira_liga":"Liga Portugal",
  "soccer_netherlands_eredivisie":"Eredivisie",
  "soccer_uefa_champs_league":"Champions League",
  "soccer_uefa_europa_league":"Europa League",
  "soccer_brazil_campeonato":"Brasileirao",
  "soccer_usa_mls":"MLS"
};

const FLAGS = {
  "soccer_france_ligue_one":"FR","soccer_france_ligue_two":"FR",
  "soccer_spain_la_liga":"ES","soccer_epl":"ENG",
  "soccer_italy_serie_a":"IT","soccer_germany_bundesliga":"DE",
  "soccer_portugal_primeira_liga":"PT","soccer_netherlands_eredivisie":"NL",
  "soccer_uefa_champs_league":"UCL","soccer_uefa_europa_league":"UEL",
  "soccer_brazil_campeonato":"BRA","soccer_usa_mls":"USA"
};

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=300,stale-while-revalidate=600");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY = process.env.ODDS_API_KEY;
  if(!KEY) return res.status(500).json({error:"ODDS_API_KEY manquante",matches:[]});

  try {
    const results = await Promise.all(
      LEAGUES.map(league =>
        fetch(
          `https://api.the-odds-api.com/v4/sports/${league}/odds/?apiKey=${KEY}&regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=betclic,winamax,unibet,pinnacle,bet365`,
          {signal: AbortSignal.timeout(7000)}
        )
        .then(r => r.ok ? r.json() : [])
        .catch(() => [])
      )
    );

    const matches = [];
    const now = new Date();

    results.forEach((data, i) => {
      if(!Array.isArray(data)) return;
      const league = LEAGUES[i];
      data.forEach(g => {
        const t = new Date(g.commence_time);
        const h = (t - now) / 3600000;
        if(h < -2 || h > 72) return;

        let o1=0,on=0,o2=0;
        const bk = [];
        (g.bookmakers||[]).forEach(b => {
          const m = (b.markets||[]).find(x=>x.key==="h2h");
          if(!m) return;
          const home = m.outcomes.find(x=>x.name===g.home_team);
          const away = m.outcomes.find(x=>x.name===g.away_team);
          const draw = m.outcomes.find(x=>x.name==="Draw");
          if(!home||!away) return;
          if(home.price>o1) o1=home.price;
          if(draw&&draw.price>on) on=draw.price;
          if(away.price>o2) o2=away.price;
          bk.push({n:b.title,o1:+home.price.toFixed(2),on:draw?+draw.price.toFixed(2):0,o2:+away.price.toFixed(2)});
        });
        if(!o1||!o2) return;

        matches.push({
          id:g.id, league,
          leagueName:LMAP[league]||league,
          f:FLAGS[league]||"INT",
          home:g.home_team, away:g.away_team,
          time:g.commence_time,
          o1:+o1.toFixed(2), on:+on.toFixed(2), o2:+o2.toFixed(2),
          bk:bk.slice(0,6)
        });
      });
    });

    matches.sort((a,b)=>new Date(a.time)-new Date(b.time));

    res.status(200).json({matches, count:matches.length, updated:new Date().toISOString()});
  } catch(e) {
    res.status(500).json({error:e.message, matches:[]});
  }
};
