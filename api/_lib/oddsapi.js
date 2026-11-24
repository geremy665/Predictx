// ═══════════════════════════════════════════════════════════════
// EDGE — api/_lib/oddsapi.js
// Cotes des opérateurs français + Pinnacle via The Odds API.
// Variable Vercel : ODDS_API_KEY
// 10 opérateurs précis = 1 « région » = 1 crédit par championnat.
// ═══════════════════════════════════════════════════════════════
const BASE = "https://api.the-odds-api.com/v4";
const cle = () => process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || "";
const actif = () => !!cle();

// 5 agréés en France + 5 de référence (Pinnacle d'abord)
const BOOKS = {
  winamax_fr: "Winamax", betclic_fr: "Betclic", unibet_fr: "Unibet", pmu_fr: "PMU", netbet_fr: "NetBet",
  pinnacle: "Pinnacle", betfair_ex_eu: "Betfair Exchange", marathonbet: "Marathonbet",
  williamhill: "William Hill", onexbet: "1xBet",
};
const LISTE_BOOKS = Object.keys(BOOKS).join(",");

const CHAMPIONNATS = {
  soccer_france_ligue_one: "Ligue 1", soccer_france_ligue_two: "Ligue 2", soccer_france_coupe_de_france: "Coupe de France",
  soccer_epl: "Premier League", soccer_efl_champ: "Championship", soccer_fa_cup: "FA Cup",
  soccer_spain_la_liga: "LaLiga", soccer_spain_segunda_division: "LaLiga 2", soccer_spain_copa_del_rey: "Copa del Rey",
  soccer_italy_serie_a: "Serie A", soccer_italy_serie_b: "Serie B", soccer_italy_coppa_italia: "Coppa Italia",
  soccer_germany_bundesliga: "Bundesliga", soccer_germany_bundesliga2: "2. Bundesliga", soccer_germany_dfb_pokal: "DFB-Pokal",
  soccer_netherlands_eredivisie: "Eredivisie", soccer_portugal_primeira_liga: "Liga Portugal",
  soccer_belgium_first_div: "Pro League", soccer_turkey_super_league: "Süper Lig", soccer_spl: "Premiership écossaise",
  soccer_switzerland_superleague: "Super League suisse", soccer_austria_bundesliga: "Bundesliga autrichienne",
  soccer_greece_super_league: "Super League grecque", soccer_denmark_superliga: "Superliga danoise",
  soccer_uefa_champs_league: "Ligue des champions", soccer_uefa_europa_league: "Ligue Europa",
  soccer_uefa_europa_conference_league: "Ligue Conférence",
};

let QUOTA = { restants: null, utilises: null };

async function appel(chemin, params, delaiMs) {
  const q = new URLSearchParams(Object.assign({ apiKey: cle() }, params || {}));
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), delaiMs || 12000);
  try {
    const r = await fetch(BASE + chemin + "?" + q.toString(), { signal: c.signal });
    const rest = r.headers.get("x-requests-remaining"), used = r.headers.get("x-requests-used");
    if (rest != null) QUOTA.restants = parseFloat(rest);
    if (used != null) QUOTA.utilises = parseFloat(used);
    const j = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error("oddsapi " + r.status + " " + ((j && (j.message || j.error_code)) || "")); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(t); }
}

// Championnats suivis qui sont en saison (gratuit)
async function championnatsActifs() {
  const l = await appel("/sports", {});
  return (l || []).filter(s => s && s.active && CHAMPIONNATS[s.key]).map(s => s.key);
}
// Matchs prévus d'un championnat (gratuit)
async function calendrier(sport, deISO, aISO) {
  const l = await appel("/sports/" + sport + "/events", { commenceTimeFrom: deISO, commenceTimeTo: aISO, dateFormat: "iso" });
  return (l || []).map(e => ({ id: e.id, ko: e.commence_time, h: e.home_team, a: e.away_team }));
}
// Cotes 1N2 d'un championnat (1 crédit)
async function cotes(sport, deISO, aISO) {
  const l = await appel("/sports/" + sport + "/odds", {
    bookmakers: LISTE_BOOKS, markets: "h2h", oddsFormat: "decimal", dateFormat: "iso",
    commenceTimeFrom: deISO, commenceTimeTo: aISO,
  });
  return (l || []).map(e => {
    const books = [];
    (e.bookmakers || []).forEach(b => {
      const mk = (b.markets || []).find(m => m.key === "h2h");
      if (!mk) return;
      let o1 = 0, on = 0, o2 = 0;
      (mk.outcomes || []).forEach(o => {
        const p = parseFloat(o.price);
        if (o.name === e.home_team) o1 = p; else if (o.name === e.away_team) o2 = p; else if (/^draw$/i.test(o.name)) on = p;
      });
      if (o1 > 1 && on > 1 && o2 > 1) books.push({ n: BOOKS[b.key] || b.title, k: b.key, o1, on, o2 });
    });
    return { id: e.id, sport, lg: CHAMPIONNATS[sport] || e.sport_title || "", ko: e.commence_time,
      h: e.home_team, a: e.away_team, books };
  });
}
// Scores des 3 derniers jours (2 crédits)
async function scores(sport) {
  const l = await appel("/sports/" + sport + "/scores", { daysFrom: 3, dateFormat: "iso" });
  return (l || []).map(e => {
    let gh = null, ga = null;
    (e.scores || []).forEach(s => {
      const v = parseInt(s.score, 10);
      if (s.name === e.home_team) gh = v; else if (s.name === e.away_team) ga = v;
    });
    return { id: e.id, termine: !!e.completed, gh: isFinite(gh) ? gh : null, ga: isFinite(ga) ? ga : null };
  });
}

// Les grands championnats, pour la formule gratuite (500 crédits par mois)
const PRINCIPAUX = ["soccer_france_ligue_one", "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a",
  "soccer_germany_bundesliga", "soccer_uefa_champs_league", "soccer_uefa_europa_league",
  "soccer_uefa_europa_conference_league", "soccer_france_ligue_two"];

module.exports = { PRINCIPAUX, actif, championnatsActifs, calendrier, cotes, scores, quota: () => QUOTA, CHAMPIONNATS, BOOKS };
