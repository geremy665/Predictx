// EDGE Scanner — api/matches.js
// Récupère les matchs du jour + cotes + analyses
// Variable Vercel: FOOTBALL_API_KEY

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=120,stale-while-revalidate=300");
  if (req.method === "OPTIONS") return res.status(200).end();

  const KEY = process.env.FOOTBALL_API_KEY;
  if (!KEY) return res.status(500).json({ error: "FOOTBALL_API_KEY manquante dans Vercel" });

  const H = { "x-apisports-key": KEY, "Accept": "application/json" };

  // Ligues couvertes
  const LEAGUES = [61,39,140,135,78,2,3,88,94,40,103,144,179];
  const season = new Date().getFullYear();

  // Date du jour (UTC)
  const now = new Date();
  const today = now.toISOString().split("T")[0];

  try {
    // Récupérer tous les matchs du jour en parallèle
    const results = await Promise.allSettled(
      LEAGUES.map(lid =>
        fetch(
          `https://v3.football.api-sports.io/fixtures?league=${lid}&season=${season}&date=${today}&timezone=Europe/Paris`,
          { headers: H, signal: AbortSignal.timeout(8000) }
        )
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
      )
    );

    let fixtures = [];
    results.forEach(r => {
      if (r.status === "fulfilled" && r.value?.response) {
        fixtures = fixtures.concat(r.value.response);
      }
    });

    // Récupérer les cotes pour les matchs à venir
    const upcomingIds = fixtures
      .filter(f => {
        const s = f.fixture?.status?.short;
        return s === "NS" || s === "TBD";
      })
      .map(f => f.fixture?.id)
      .filter(Boolean)
      .slice(0, 20); // max 20 pour limiter les appels

    let oddsMap = {};
    if (upcomingIds.length > 0) {
      const oddsResults = await Promise.allSettled(
        upcomingIds.map(id =>
          fetch(
            `https://v3.football.api-sports.io/odds?fixture=${id}&bookmaker=8`,
            { headers: H, signal: AbortSignal.timeout(6000) }
          )
          .then(r => r.ok ? r.json() : null)
          .catch(() => null)
        )
      );
      oddsResults.forEach(r => {
        if (r.status !== "fulfilled" || !r.value?.response?.[0]) return;
        const item = r.value.response[0];
        const fixId = item.fixture?.id;
        if (!fixId) return;
        const bets = item.bookmakers?.[0]?.bets || [];
        const match1x2 = bets.find(b => b.name === "Match Winner");
        if (match1x2?.values) {
          const vals = match1x2.values;
          oddsMap[fixId] = {
            o1: parseFloat(vals.find(v => v.value === "Home")?.odd || 0),
            on: parseFloat(vals.find(v => v.value === "Draw")?.odd || 0),
            o2: parseFloat(vals.find(v => v.value === "Away")?.odd || 0),
          };
        }
      });
    }

    // Formatter les matchs
    const FLAG_MAP = {61:"FR",39:"ENG",140:"ES",135:"IT",78:"DE",2:"UCL",3:"UEL",
      88:"NL",94:"PT",40:"ENG",103:"NO",144:"BE",179:"SC"};

    const matches = fixtures.map((f, idx) => {
      const fix = f.fixture || {};
      const teams = f.teams || {};
      const goals = f.goals || {};
      const league = f.league || {};
      const status = fix.status?.short || "NS";
      const isLive = ["1H","HT","2H","ET","BT","P"].includes(status);
      const isDone = ["FT","AET","PEN"].includes(status);
      const odds = oddsMap[fix.id] || {};

      return {
        id: fix.id || idx,
        fixtureId: fix.id,
        leagueId: league.id,
        leagueName: league.name || "",
        c: league.name || "",
        f: FLAG_MAP[league.id] || "INT",
        h: teams.home?.name || "",
        a: teams.away?.name || "",
        home: teams.home?.name || "",
        away: teams.away?.name || "",
        homeId: teams.home?.id,
        awayId: teams.away?.id,
        time: fix.date || "",
        t: fix.date || "",
        status: status,
        isLive: isLive,
        isDone: isDone,
        elapsed: fix.status?.elapsed || null,
        goalsH: goals.home ?? null,
        goalsA: goals.away ?? null,
        o1: odds.o1 || 0,
        on: odds.on || 0,
        o2: odds.o2 || 0,
        // Stats de forme (à enrichir côté client)
        hxg: 0, axg: 0,
        hg: 0, ag: 0,
        hf: 0, af: 0,
      };
    });

    // Trier: live d'abord, puis par heure
    matches.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return (a.time || "").localeCompare(b.time || "");
    });

    return res.status(200).json({
      success: true,
      date: today,
      count: matches.length,
      matches
    });

  } catch (err) {
    console.error("matches.js error:", err.message);
    return res.status(500).json({ error: err.message, matches: [] });
  }
};
