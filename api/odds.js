export default async function handler(req, res) {
  const { fixture } = req.query;
  if (!fixture) return res.status(400).json({ error: 'Missing fixture id' });
  const response = await fetch(`https://v3.football.api-sports.io/odds?fixture=${fixture}`, {
    headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY }
  });
  const data = await response.json();
  const oddsMap = {};
  if (data.response && data.response[0]) {
    const bookmakers = data.response[0].bookmakers;
    let bestHome = 0, bestDraw = 0, bestAway = 0;
    for (let bk of bookmakers) {
      for (let bet of bk.bets) {
        if (bet.name === 'Match Winner') {
          for (let val of bet.values) {
            if (val.value === 'Home') bestHome = Math.max(bestHome, parseFloat(val.odd));
            if (val.value === 'Draw') bestDraw = Math.max(bestDraw, parseFloat(val.odd));
            if (val.value === 'Away') bestAway = Math.max(bestAway, parseFloat(val.odd));
          }
        }
      }
    }
    oddsMap.home_win = bestHome || 1.85;
    oddsMap.draw = bestDraw || 3.40;
    oddsMap.away_win = bestAway || 4.20;
    // Ajoute ici over_25 et btts_yes si l’API les fournit
    oddsMap.over_25 = 1.65;
    oddsMap.btts_yes = 1.75;
  }
  res.status(200).json(oddsMap);
}
