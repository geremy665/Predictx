// EDGE — api/debug.js — DIAGNOSTIC TEMPORAIRE
// À supprimer une fois le problème identifié.
// Ouvre : https://predictx-pi.vercel.app/api/debug

async function call(url, key) {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    const body = await r.json();
    return {
      url,
      httpStatus: r.status,
      ms: Date.now() - t0,
      // Ce que l'API dit d'elle-même
      errors: body.errors || null,
      results: body.results !== undefined ? body.results : null,
      paging: body.paging || null,
      // Quotas renvoyés dans les en-têtes
      quotaJour: r.headers.get("x-ratelimit-requests-limit"),
      quotaRestant: r.headers.get("x-ratelimit-requests-remaining"),
      limiteMinute: r.headers.get("X-RateLimit-Limit"),
      resteMinute: r.headers.get("X-RateLimit-Remaining"),
      // Un échantillon très court de la réponse
      echantillon: Array.isArray(body.response) ? body.response.slice(0, 1) : body.response,
    };
  } catch (e) {
    return { url, erreur: e.message, ms: Date.now() - t0 };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) {
    return res.status(200).json({
      VERDICT: "❌ Aucune clé API configurée sur Vercel (variable FOOTBALL_API_KEY absente)",
    });
  }

  const today = new Date().toISOString().split("T")[0];

  // 1. Le compte fonctionne-t-il ? (endpoint de statut, ne consomme presque rien)
  const statut = await call("/status", KEY);

  // 2. Les matchs du jour (on sait que ça marche déjà)
  const fixtures = await call(`/fixtures?date=${today}`, KEY);

  // 3. LE TEST CRUCIAL : les cotes du jour
  const oddsDate = await call(`/odds?date=${today}`, KEY);

  // 4. Les cotes d'un match précis (si on en a trouvé un)
  let oddsFixture = null;
  let fixtureTeste = null;
  try {
    const f = fixtures.echantillon && fixtures.echantillon[0];
    if (f && f.fixture && f.fixture.id) {
      fixtureTeste = {
        id: f.fixture.id,
        match: (f.teams && f.teams.home && f.teams.home.name) + " - " + (f.teams && f.teams.away && f.teams.away.name),
        ligue: f.league && f.league.name,
        statut: f.fixture.status && f.fixture.status.short,
      };
      oddsFixture = await call(`/odds?fixture=${f.fixture.id}`, KEY);
    }
  } catch (e) {}

  // 5. Les bookmakers disponibles sur ce compte
  const books = await call("/odds/bookmakers", KEY);

  // ── Verdict lisible ──
  const verdicts = [];
  if (statut.errors && Object.keys(statut.errors || {}).length)
    verdicts.push("❌ Problème de compte/clé : " + JSON.stringify(statut.errors));
  else verdicts.push("✅ La clé API fonctionne");

  if (statut.echantillon && statut.echantillon.subscription)
    verdicts.push("📋 Forfait : " + JSON.stringify(statut.echantillon.subscription));
  if (statut.echantillon && statut.echantillon.requests)
    verdicts.push("📊 Requêtes : " + JSON.stringify(statut.echantillon.requests));

  if (fixtures.results > 0) verdicts.push(`✅ Matchs du jour : ${fixtures.results} trouvés`);
  else verdicts.push("⚠️ Aucun match trouvé aujourd'hui");

  if (oddsDate.errors && Object.keys(oddsDate.errors || {}).length)
    verdicts.push("❌ COTES REFUSÉES : " + JSON.stringify(oddsDate.errors));
  else if (oddsDate.results > 0)
    verdicts.push(`✅ COTES DISPONIBLES : ${oddsDate.results} matchs cotés aujourd'hui`);
  else
    verdicts.push("❌ COTES VIDES : l'API répond sans erreur mais ne renvoie aucune cote");

  if (books.results > 0) verdicts.push(`✅ ${books.results} bookmakers accessibles`);
  else if (books.errors) verdicts.push("❌ Bookmakers refusés : " + JSON.stringify(books.errors));

  return res.status(200).json({
    VERDICT: verdicts,
    date: today,
    detail: {
      statut_compte: statut,
      matchs_du_jour: { url: fixtures.url, results: fixtures.results, errors: fixtures.errors, paging: fixtures.paging },
      COTES_PAR_DATE: oddsDate,
      match_teste: fixtureTeste,
      COTES_DU_MATCH: oddsFixture,
      bookmakers: { results: books.results, errors: books.errors, echantillon: books.echantillon },
    },
  });
};
