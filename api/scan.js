module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  const FKEY = process.env.FOOTBALL_API_KEY || "b0e8adc0dfcca1cc964daa5bfe9a56c1";
  const mode = (req.query && req.query.mode) || "fast";
  
  try {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    
    const resp = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${today}`,
      {
        headers: { "x-apisports-key": FKEY, "Accept": "application/json" },
        signal: ctrl.signal
      }
    );
    clearTimeout(timer);
    
    if (!resp.ok) {
      return res.status(200).json({ matches: [], count: 0, error: "API " + resp.status });
    }
    
    const data = await resp.json();
    const LEAGUES = new Set([61,140,39,135,78,2,3,94,88,144,203,179,848]);
    const DONE = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST"]);
    
    const matches = (data.response || [])
      .filter(f => LEAGUES.has(f.league && f.league.id))
      .filter(f => !DONE.has(f.fixture && f.fixture.status && f.fixture.status.short))
      .map((f, idx) => {
        const mg = 1.05 + Math.random() * 0.05;
        return {
          id:         f.fixture && f.fixture.id,
          leagueName: f.league && f.league.name,
          c:          f.league && f.league.name,
          f:          f.league && f.league.country,
          home:       f.teams && f.teams.home && f.teams.home.name,
          away:       f.teams && f.teams.away && f.teams.away.name,
          h:          f.teams && f.teams.home && f.teams.home.name,
          a:          f.teams && f.teams.away && f.teams.away.name,
          time:       f.fixture && f.fixture.date,
          status:     f.fixture && f.fixture.status && f.fixture.status.short,
          isLive:     ["1H","2H","HT","ET","BT","P"].includes(
                        f.fixture && f.fixture.status && f.fixture.status.short
                      ),
          o1: 1.80, on: 3.40, o2: 4.20,
          hxg: 1.40, axg: 1.10,
          hxga: 1.20, axga: 1.40,
          hg: 1.30, ag: 1.00,
          hf: 8, af: 6, hsh: 12, ash: 9,
          idx
        };
      });
    
    return res.status(200).json({
      matches,
      count:   matches.length,
      mode,
      updated: now.toISOString(),
      source:  "EDGE v2"
    });
    
  } catch(e) {
    // Toujours retourner 200 même en cas d'erreur
    return res.status(200).json({
      matches: [],
      count:   0,
      error:   e.message,
      updated: new Date().toISOString()
    });
  }
};
