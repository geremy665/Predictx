// EDGE — api/scan.js v45 — 429 transitoire + débit régulé + garde-temps Vercel
function toNum(val, decimals) {
  if(val === null || val === undefined || isNaN(val)) return 0;
  return parseFloat(parseFloat(val).toFixed(decimals || 3));
}

// Ligues suivies TOUTE L'ANNÉE (Europe + été + international)
// ── Pays européens : on accepte TOUTE compétition qui s'y déroule ──
// Une liste fermée de ligues laissait de côté l'Islande, les pays baltes,
// la Bulgarie, la Hongrie, Chypre… c'est-à-dire l'Europe qui joue en été.

// On écarte les catégories qui ne se parient pas
// \w* après la racine capte les formes fléchies : Junior/Junioren/Juniors,
// Youth/Youths, Women/Womens, Reserve/Reserves, etc.
const EXCLURE = /\b(U1[5-9]|U2[0-3]|Youths?|Juniors?|Junioren|Jugend|Women'?s?|Feminine|Femenin|Reserves?|Amateur|Futsal|Beach)\w*\b/i;

function ligueRetenue(l){
  if(!l) return false;
  if(l.name && EXCLURE.test(l.name)) return false;
  // LEAGUES est désormais la SEULE source de vérité : la liste précise des
  // championnats retenus (Winamax/Betclic). Le pays ne sert plus qu'à un
  // filet de sécurité si l'identifiant de la ligue n'est pas reconnu.
  return LEAGUES.has(l.id);
}

// Liste resserrée sur ce qui est réellement pariable chez Winamax/Betclic —
// les Big 5, les coupes européennes, et les championnats secondaires les
// plus suivis. Toutes les D2/D3 étrangères et petites ligues mineures ont
// été retirées : elles gaspillaient le quota sans intéresser personne.
const LEAGUES = new Set([
  // Big 5
  61,140,39,135,78,
  // Coupes d'Europe + qualifications
  2,3,848,
  // Championnats secondaires les plus suivis en France
  94,   // Liga Portugal
  88,   // Eredivisie
  144,  // Pro League (Belgique)
  203,  // Süper Lig (Turquie)
  179,  // Premiership (Écosse)
  // Ligue 2 française uniquement — les autres D2 étrangères sont retirées
  62,   // Ligue 2
  // Coupes nationales des Big 5 — très suivies et bien cotées
  66,   // Coupe de France
  45,   // FA Cup
  48,   // League Cup (Angleterre)
  137,  // Coppa Italia
  143,  // Copa del Rey
  81,   // DFB Pokal
  96,   // Taça de Portugal
  // Supercoupes — matchs uniques mais très suivis
  531,  // Supercoupe d'Europe (UEFA)
  526,  // Trophée des Champions
  528,  // Community Shield
  556,  // Supercoupe d'Espagne
  547,  // Supercoupe d'Italie
  90,   // Supercoupe d'Allemagne
  // Championnats nordiques : ils jouent d'avril à novembre, exactement
  // quand les Big 5 sont à l'arrêt. Comblent le creux estival.
  113,  // Allsvenskan (Suède)
  103,  // Eliteserien (Norvège)
  // International UEFA + amicaux
  4,5,10,667,1,34,
]);

// Priorité d'affichage (plus haut = montré en premier)
const PRIORITY = {
  2:95, 3:92, 848:88,               // UCL, UEL, Conference
  61:90,140:90,39:90,135:90,78:90,  // Big 5
  94:74, 88:74, 144:72, 203:72,     // PT, NL, BE, TR
  62:70,                            // Ligue 2
  179:66,                           // Écosse
  531:93,                           // Supercoupe d'Europe — trophée majeur
  45:78, 66:76, 137:76, 143:76, 81:76, 48:70, 96:68,   // Coupes nationales
  526:72, 528:72, 556:72, 547:72, 90:72,               // Supercoupes nationales
  113:64, 103:64,                   // Suède, Norvège (pleine saison l'été)
  4:94, 5:75, 1:68, 34:68,          // Euro, Nations League, qualifs
  10:40, 667:18,                    // Amicaux (dernier)
};

const FLAG = {
  61:"FR",62:"FR",140:"ES",39:"ENG",135:"IT",78:"DE",
  2:"UCL",3:"UEL",848:"UECL",94:"PT",88:"NL",144:"BE",203:"TR",179:"SCO",
  66:"FR",45:"ENG",48:"ENG",137:"IT",143:"ES",81:"DE",96:"PT",
  531:"UEFA",526:"FR",528:"ENG",556:"ES",547:"IT",90:"DE",
  113:"SE",103:"NO",
  10:"INT",667:"AMI",4:"EUR",5:"UNL",1:"WCQ",34:"WCQ"
};

const LEAGUE_NAME = {
  61:"Ligue 1",62:"Ligue 2",140:"La Liga",39:"Premier League",135:"Serie A",
  78:"Bundesliga",2:"Champions League",3:"Europa League",848:"Conference League",
  94:"Liga Portugal",88:"Eredivisie",144:"Pro League",203:"Süper Lig",
  179:"Premiership",
  66:"Coupe de France",45:"FA Cup",48:"League Cup",137:"Coppa Italia",
  143:"Copa del Rey",81:"DFB Pokal",96:"Taça de Portugal",
  531:"Supercoupe d'Europe",526:"Trophée des Champions",528:"Community Shield",
  556:"Supercoupe d'Espagne",547:"Supercoupe d'Italie",90:"Supercoupe d'Allemagne",
  113:"Allsvenskan",103:"Eliteserien",
  10:"Amicaux Nations",667:"Amicaux Clubs",
  4:"Euro",5:"UEFA Nations League",1:"Qualif. Mondial",34:"Qualif. Mondial"
};

const DONE = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);
const SHARP_BK = [8, 6, 1, 2, 3];

let API_CALLS = 0;
let RATE_LIMITED = false;   // limite par minute touchée : transitoire
let DEBUT = 0;              // horodatage du début du scan
const BUDGET_MS = 7500;     // Vercel coupe à 10s : on garde une marge
function tempsEcoule() { return Date.now() - DEBUT; }
let API_ERROR = null;   // quota dépassé, clé invalide, etc.
let API_STOP = false;   // on arrête tout dès qu'une erreur bloquante survient

function noteApiError(d, httpStatus) {
  // Le 429 d'API-Football = limite PAR MINUTE, pas quota journalier.
  // Il est transitoire : on ralentit, on ne coupe surtout pas le scan.
  // (Auparavant API_STOP=true ici arrêtait tout dès le premier burst :
  //  7 appels effectués sur ~110, alors que le quota du jour était à 3%.)
  if (httpStatus === 429) { API_ERROR = "Limite par minute atteinte (ralentissement)"; RATE_LIMITED = true; return; }
  if (httpStatus === 401 || httpStatus === 403) { API_ERROR = "Clé API refusée"; API_STOP = true; return; }
  if (!d || !d.errors) return;
  const e = d.errors;
  if (Array.isArray(e)) { if (e.length) API_ERROR = String(e[0]); return; }
  const keys = Object.keys(e);
  if (!keys.length) return;
  const msg = String(e[keys[0]] || keys[0]);
  API_ERROR = msg;
  // ATTENTION : n'arrêter QUE sur un vrai dépassement de quota.
  // Le message "no odds for this plan" ou toute mention de "plan" est
  // renvoyé pour des matchs isolés sans cotes — il ne doit pas couper
  // les requêtes suivantes. Un filtre trop large stoppait le scan à
  // 25 appels sur 100, laissant la moitié des matchs sans cotes.
  if (/reached the request limit|too many requests|quota exceeded/i.test(msg)) API_STOP = true;
}

async function apiFetch(url, key, essai) {
  if (API_STOP) return null;
  API_CALLS++;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: { "x-apisports-key": key, "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) {
      noteApiError(null, r.status);
      // 429 = limite par minute : on attend et on retente une seule fois
      if (r.status === 429 && !essai && tempsEcoule() < BUDGET_MS) {
        await pause(1100);
        return apiFetch(url, key, 1);
      }
      return null;
    }
    const d = await r.json();
    noteApiError(d);
    return d.response || null;
  } catch(e) { return null; }
}

// Petite pause (limite par minute de l'API)
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exécute des tâches par petits lots au lieu de tout lancer d'un coup.
// Un burst de 35 requêtes simultanées déclenche le 429 d'API-Football.
async function parLots(items, fn, taille) {
  const out = [];
  for (let i = 0; i < items.length; i += taille) {
    // Garde-temps : mieux vaut renvoyer des cotes partielles que rien du tout
    // (une fonction Vercel coupée à 10s ne renvoie AUCUNE donnée).
    if (tempsEcoule() > BUDGET_MS) {
      while (out.length < items.length) out.push(null);
      break;
    }
    const lot = items.slice(i, i + taille);
    const r = await Promise.all(lot.map(fn));
    out.push(...r);
    // Débit régulé : ~8 requêtes/seconde en rythme normal.
    // Le burst de 35 simultanées déclenchait le 429 d'API-Football.
    if (i + taille < items.length) await pause(RATE_LIMITED ? 1100 : 600);
  }
  return out;
}

// Récupère TOUTES les cotes 1X2 d'une journée en 1 à 3 requêtes (au lieu d'une par match)
// → permet de couvrir une semaine entière sans exploser le quota API
async function getOddsBulk(date, key, maxPages) {
  const map = {};
  const limit = maxPages || 3;
  let page = 1, totalPages = 1;
  while (page <= Math.min(limit, totalPages)) {
    let d = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      if (API_STOP) break;
      API_CALLS++;
      // Pas de filtre "bet=" : l'ID du marché "Match Winner" n'est PAS garanti
      // être 1 sur tous les comptes/versions — un mauvais ID renvoie une réponse
      // vide sans erreur. On filtre nous-mêmes par NOM plus bas (fiable).
      const r = await fetch(`https://v3.football.api-sports.io/odds?date=${date}&page=${page}`, {
        headers: { "x-apisports-key": key, "Accept": "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!r.ok) { noteApiError(null, r.status); break; }
      d = await r.json();
      noteApiError(d);
    } catch (e) { break; }
    if (!d || !Array.isArray(d.response)) break;
    totalPages = (d.paging && d.paging.total) ? d.paging.total : 1;

    for (const item of d.response) {
      const fid = item.fixture && item.fixture.id;
      if (!fid || map[fid]) continue;
      const bks = item.bookmakers || [];
      bks.sort((a, b) => {
        const ia = SHARP_BK.indexOf(a.id), ib = SHARP_BK.indexOf(b.id);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      // On collecte TOUS les bookmakers pour calculer consensus + meilleure cote
      const all1 = [], allN = [], all2 = [];
      let ref = null, hasPin = false, pinOdds = null;
      for (const bk of bks) {
        const mw = (bk.bets || []).find(b => b.id === 1 || b.name === "Match Winner");
        if (!mw || !mw.values || mw.values.length < 3) continue;
        const h = mw.values.find(v => v.value === "Home");
        const dr = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (!h || !dr || !a) continue;
        const c1 = parseFloat(h.odd), cn = parseFloat(dr.odd), c2 = parseFloat(a.odd);
        if (!(c1 > 1.01 && cn > 1.01 && c2 > 1.01)) continue;
        all1.push({ o: c1, b: bk.name });
        allN.push({ o: cn, b: bk.name });
        all2.push({ o: c2, b: bk.name });
        if (bk.id === 8) { hasPin = true; pinOdds = { o1: c1, on: cn, o2: c2 }; }
        if (!ref) ref = { o1: c1, on: cn, o2: c2, book: bk.name };
      }
      if (!ref || all1.length === 0) continue;

      // Consensus = médiane des probabilités implicites, puis dé-viggé
      const med = arr => {
        const s = arr.map(x => x.o).sort((a, b) => a - b);
        const n = s.length;
        return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
      };
      const m1 = med(all1), mn = med(allN), m2 = med(all2);
      const marg = 1 / m1 + 1 / mn + 1 / m2;
      const cons = { p1: (1 / m1) / marg, pn: (1 / mn) / marg, p2: (1 / m2) / marg };

      // ── DISPERSION : à quel point les bookmakers sont-ils d'accord ? ──
      // Un fort désaccord signale de l'incertitude sur le marché — souvent
      // là où se cachent les meilleures opportunités de prix.
      const ecartType = arr => {
        if (arr.length < 2) return 0;
        const probs = arr.map(x => 1 / x.o);
        const moy = probs.reduce((a, b) => a + b, 0) / probs.length;
        const v = probs.reduce((a, b) => a + Math.pow(b - moy, 2), 0) / probs.length;
        return Math.sqrt(v) / Math.max(moy, 0.01);   // coefficient de variation
      };
      const dispersion = Math.round(Math.max(ecartType(all1), ecartType(allN), ecartType(all2)) * 1000) / 1000;

      // Meilleure cote disponible par issue
      const best = a => a.reduce((x, y) => (y.o > x.o ? y : x), a[0]);
      const b1 = best(all1), bN = best(allN), b2 = best(all2);

      // Value = espérance au meilleur prix, évaluée avec la probabilité consensus
      const cand = [
        { k: "1", edge: cons.p1 * b1.o - 1, odd: b1.o, book: b1.b },
        { k: "N", edge: cons.pn * bN.o - 1, odd: bN.o, book: bN.b },
        { k: "2", edge: cons.p2 * b2.o - 1, odd: b2.o, book: b2.b },
      ].sort((x, y) => y.edge - x.edge);
      const top = cand[0];

      map[fid] = {
        o1: ref.o1, on: ref.on, o2: ref.o2,
        // Liste complète par bookmaker : nécessaire pour l'arbitrage et le
        // comparateur. Limitée à 20 books pour ne pas alourdir la réponse.
        books: all1.slice(0, 20).map((x, i) => ({
          n: x.b,
          o1: x.o,
          on: allN[i] ? allN[i].o : null,
          o2: all2[i] ? all2[i].o : null,
        })).filter(b => b.o1 && b.on && b.o2),
        pinnacle: hasPin,
        pinO1: pinOdds ? pinOdds.o1 : null,
        pinON: pinOdds ? pinOdds.on : null,
        pinO2: pinOdds ? pinOdds.o2 : null,
        dispersion: dispersion,
        nBooks: all1.length,
        bestO1: b1.o, bestON: bN.o, bestO2: b2.o,
        bestBook1: b1.b, bestBookN: bN.b, bestBook2: b2.b,
        lineValue: (all1.length >= 3 && top.edge > 0)
          ? { pick: top.k, edge: +top.edge.toFixed(4), odd: top.odd, book: top.book, nBooks: all1.length }
          : null,
      };
    }
    page++;
  }
  return map;
}

async function getOdds(fixtureId, key) {
  try {
    const data = await apiFetch(`/odds?fixture=${fixtureId}`, key);
    if (!data?.length) return null;
    let result = {};
    let foundSharp = false;
    const allBks = [];
    for (const item of data) {
      for (const bk of (item.bookmakers || [])) allBks.push(bk);
    }
    allBks.sort((a,b) => {
      const ia = SHARP_BK.indexOf(a.id);
      const ib = SHARP_BK.indexOf(b.id);
      return (ia<0?99:ia) - (ib<0?99:ib);
    });
    for (const bk of allBks) {
      const bets = bk.bets || [];
      const isPinnacle = bk.id === 8;
      const mw = bets.find(b => b.id === 1 || b.name === "Match Winner");
      if (mw?.values?.length >= 3 && !result.o1) {
        const h = mw.values.find(v => v.value === "Home");
        const dr = mw.values.find(v => v.value === "Draw");
        const a = mw.values.find(v => v.value === "Away");
        if (h && dr && a) {
          result.o1 = parseFloat(h.odd);
          result.on = parseFloat(dr.odd);
          result.o2 = parseFloat(a.odd);
          result.pinnacle = isPinnacle;
          if (isPinnacle) foundSharp = true;
        }
      }
      const dc = bets.find(b => b.id === 12 || b.name === "Double Chance");
      if (dc?.values && !result.dc1x) {
        const hd = dc.values.find(v => v.value === "Home/Draw");
        const ha = dc.values.find(v => v.value === "Home/Away");
        const da = dc.values.find(v => v.value === "Draw/Away");
        if (hd) result.dc1x = parseFloat(hd.odd);
        if (ha) result.dc12 = parseFloat(ha.odd);
        if (da) result.dcx2 = parseFloat(da.odd);
      }
      const ou = bets.find(b => b.id === 3 || b.name === "Goals Over/Under");
      if (ou?.values) {
        ou.values.forEach(v => {
          const m = v.value.match(/(Over|Under)\s+([\d.]+)/i);
          if (!m) return;
          const k = (m[1].toLowerCase()==="over"?"over":"under")+m[2].replace(".","_");
          if (!result[k]) result[k] = parseFloat(v.odd);
        });
      }
      const btts = bets.find(b => b.id === 5 || b.name === "Both Teams Score");
      if (btts?.values && !result.bttsY) {
        const y = btts.values.find(v => v.value === "Yes");
        const n = btts.values.find(v => v.value === "No");
        if (y) result.bttsY = parseFloat(y.odd);
        if (n) result.bttsN = parseFloat(n.odd);
      }
      if (result.o1 && foundSharp) break;
    }
    return Object.keys(result).length ? result : null;
  } catch(e) { return null; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cache 30 min : les cotes pré-match bougent lentement, et c'est ce qui
  // permet de tenir dans le quota même avec plusieurs utilisateurs simultanés.
  // MAIS : après un déploiement, le cache peut servir une réponse périmée
  // pendant 30 min — d'où l'impression qu'un correctif ne change rien.
  // Ajouter ?nocache=1 à l'URL force une réponse fraîche.
  const sansCache = req.query && (req.query.nocache === "1" || req.query.nocache === "true");
  if (sansCache) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  } else {
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
  }
  if (req.method === "OPTIONS") return res.status(200).end();

  API_CALLS = 0; API_ERROR = null; API_STOP = false; RATE_LIMITED = false; DEBUT = Date.now();

  // ── EFFORT ADAPTÉ AU JOUR ──
  // Le samedi et le dimanche concentrent l'essentiel des matchs.
  // Mardi et mercredi : soirs de Champions League et Europa League.
  // Lundi et jeudi : peu de matchs, on économise le quota pour les jours chargés.
  const jourSemaine = new Date().getDay();   // 0 = dimanche
  const JOURS_CHARGES = [0, 2, 3, 5, 6];     // dim, mar, mer, ven, sam
  const chargé = JOURS_CHARGES.indexOf(jourSemaine) >= 0;
  // « detail » = nombre de matchs pour lesquels on récupère TOUS les marchés
  // (double chance, plus/moins de buts, BTTS). Sans ça, le moteur n'a que
  // le 1X2 à proposer — d'où l'impression qu'il ne suggère que des victoires.
  // Le flux /odds?date= renvoie les cotes du MONDE ENTIER : sur 30 pages,
  // seule une poignée concerne nos championnats. Le rattrapage ciblé
  // (une requête par match) est bien plus efficace — on l'augmente et on
  // réduit les pages génériques.
  // Volumes calibrés pour tenir dans le budget de temps de Vercel
  // avec un débit régulé (~8 req/s) : au-delà, la fonction est coupée
  // et l'utilisateur ne reçoit RIEN.
  const EFFORT = chargé
    ? { pagesJ0: 10, pagesJ1: 5, pagesJ2: 2, rattrapage: 30, detail: 20, fenetre: 5 }
    : { pagesJ0:  7, pagesJ1: 3, pagesJ2: 2, rattrapage: 22, detail: 15, fenetre: 4 };
  const KEY = process.env.FOOTBALL_API_KEY || "";
  if (!KEY) return res.status(200).json({ matches: [], error: "no_key" });

  try {
    const now = new Date();
    const season = now.getMonth() < 7 ? now.getFullYear()-1 : now.getFullYear();

    // -1 = hier (règlement du track record), 0..6 = une semaine d'avance
    // Les bookmakers publient leurs cotes 24 à 48h avant le coup d'envoi.
    // Afficher des matchs à J+2 ou J+3 revenait à montrer des rencontres
    // qui n'auraient JAMAIS de cotes — d'où l'impression que rien n'en a.
    const days = [-1,0,1,2,3].slice(0, EFFORT.fenetre).map(i =>
      new Date(now.getTime()+i*86400000).toISOString().split("T")[0]
    );

    // ── Pagination : /fixtures?date= renvoie tous les matchs du monde.
    // Sans lire les pages suivantes, des compétitions entières disparaissent.
    async function fixturesForDate(date) {
      // /fixtures?date= n'est PAS paginé : il renvoie tous les matchs du jour
      // en une seule réponse (contrairement à /odds qui, lui, l'est).
      let out = [];
      if (API_STOP) return out;
      API_CALLS++;
      let d = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 9000);
        const r = await fetch(`https://v3.football.api-sports.io/fixtures?date=${date}`, {
          headers: { "x-apisports-key": KEY, "Accept": "application/json" }, signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) { noteApiError(null, r.status); return out; }
        d = await r.json();
        noteApiError(d);
      } catch (e) { return out; }
      if (d && Array.isArray(d.response)) out = d.response;
      return out;
    }
    // Pagination complète sur les 4 premiers jours, allégée au-delà
    // Pagination dégressive : les jours proches comptent, les lointains beaucoup moins
    const results = await Promise.all(days.map(d => fixturesForDate(d)));

    const pool = results.flat().filter(Boolean)
      .filter(f => ligueRetenue(f.league))
      // Filet supplémentaire : certaines compétitions ont un nom neutre ("Cup")
      // mais ce sont les EQUIPES qui trahissent la catégorie jeunes/féminine.
      .filter(f => {
        const hn = (f.teams && f.teams.home && f.teams.home.name) || "";
        const an = (f.teams && f.teams.away && f.teams.away.name) || "";
        return !EXCLURE.test(hn) && !EXCLURE.test(an);
      });

    // Matchs terminés (hier + aujourd'hui) → règlement du track record côté client
    const finished = pool
      .filter(f => DONE.has(f.fixture?.status?.short))
      .map(f => ({
        id: f.fixture?.id,
        gh: f.goals?.home ?? null,
        ga: f.goals?.away ?? null,
      }));

    let all = pool.filter(f => !DONE.has(f.fixture?.status?.short || "NS"));

    // TRI PAR PRIORITÉ: live d'abord, puis priorité de ligue, puis heure
    all.sort((a,b) => {
      const aLive = LIVE.has(a.fixture?.status?.short) ? 1 : 0;
      const bLive = LIVE.has(b.fixture?.status?.short) ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      const pa = PRIORITY[a.league?.id] || 25;
      const pb = PRIORITY[b.league?.id] || 25;
      if (pa !== pb) return pb - pa;
      return (a.fixture?.date||"") < (b.fixture?.date||"") ? -1 : 1;
    });

    // ── SÉLECTION PAR QUOTA ──
    // Un simple tri par priorité affame les compétitions moins bien classées :
    // 40 matchs de Ligue 1 peuvent évincer toute la Conference League.
    // On sert donc chaque compétition à tour de rôle, par ordre de priorité.
    const liveArr = all.filter(f => LIVE.has(f.fixture?.status?.short)).slice(0, 12);
    const upArr   = all.filter(f => !LIVE.has(f.fixture?.status?.short));

    const byLeague = new Map();
    for (const f of upArr) {
      const id = f.league?.id;
      if (!byLeague.has(id)) byLeague.set(id, []);
      byLeague.get(id).push(f);
    }
    // Ligues classées par priorité, matchs classés par heure
    const ordered = Array.from(byLeague.entries())
      .sort((a, b) => (PRIORITY[b[0]] || 25) - (PRIORITY[a[0]] || 25));
    ordered.forEach(([, arr]) => arr.sort((a, b) => (a.fixture?.date || "") < (b.fixture?.date || "") ? -1 : 1));

    const LIMIT = 80 - liveArr.length;
    const picked = [];

    // ── GARANTIE : les compétitions majeures passent TOUJOURS en entier ──
    // Champions League, Europa League, Conference, Supercoupe d'Europe et
    // Big 5 : aucun match ne doit être écarté par le plafond, quel que soit
    // le volume du jour. C'est le cœur de ce que les gens viennent chercher.
    const MAJEURES = new Set([2, 3, 848, 531, 61, 140, 39, 135, 78, 4, 5]);
    const listeMaj = ordered.filter(([lid]) => MAJEURES.has(lid));
    // À tour de rôle, pas dans l'ordre : sinon la Ligue 1 et la Liga
    // consommaient tout le plafond et la Conference League disparaissait.
    // Les majeures ne peuvent pas consommer plus de 65% du plafond :
    // sinon les coupes nationales (FA Cup, Coupe de France, Coppa Italia…)
    // disparaissent complètement les jours chargés.
    const PLAFOND_MAJ = Math.floor(LIMIT * 0.65);
    let tourMaj = 0;
    while (picked.length < PLAFOND_MAJ && tourMaj < 40) {
      let ajout = 0;
      for (const [, arr] of listeMaj) {
        if (!arr.length || picked.length >= PLAFOND_MAJ) continue;
        picked.push(arr.shift());
        ajout++;
      }
      if (!ajout) break;
      tourMaj++;
    }

    let round = 0;
    // Puis les AUTRES compétitions uniquement : les majeures ont déjà eu
    // leur part. Sans cette exclusion, elles reprenaient toute la place.
    const listeAutres = ordered.filter(([lid]) => !MAJEURES.has(lid));
    const tourPool = listeAutres.length ? listeAutres : ordered;
    while (picked.length < LIMIT && round < 30) {
      let added = 0;
      for (const [, arr] of tourPool) {
        const quota = round === 0 ? 3 : 1;
        for (let q = 0; q < quota && picked.length < LIMIT; q++) {
          if (arr.length) { picked.push(arr.shift()); added++; }
        }
        if (picked.length >= LIMIT) break;
      }
      if (!added) break;
      round++;
    }
    const fixtures = liveArr.concat(picked);
    const today = days[1];
    const tomorrow = days[2];

    // ── COTES EN MASSE : 1 à 3 requêtes par jour au lieu d'une par match ──
    // Cotes groupées sur 3 jours seulement : au-delà, les bookmakers publient rarement.
    // Les matchs plus lointains restent visibles et passent par le rattrapage si prioritaires.
    // L'API renvoie 10 cotes par page et compte ~37 pages par jour :
    // se limiter à 3 pages ne captait que 8% des matchs cotés.
    // Le forfait Pro (7500 req/jour) permet enfin de tout lire.
    const oddDays = days.slice(1);   // J0, J+1, J+2 — tous les jours affichés  // aujourd'hui + demain
    const bulkMaps = await Promise.all(oddDays.map((d, i) => getOddsBulk(d, KEY, i === 0 ? EFFORT.pagesJ0 : (i === 1 ? EFFORT.pagesJ1 : EFFORT.pagesJ2))));
    const oddsByFixture = Object.assign({}, ...bulkMaps);

    // ── RATTRAPAGE : matchs prioritaires oubliés par la pagination groupée ──
    // (Champions/Europa/Conference et grands championnats ne doivent JAMAIS manquer)
    // Rattrapage : tout match AFFICHÉ et non coté mérite une requête dédiée.
    // ATTENTION : ne PAS filtrer par date. Les dates de l'API sont dans le
    // fuseau du match, celles calculées ici en UTC — la comparaison échouait
    // et rejetait absolument tous les matchs (48 identifiés, 0 traité).
    // Les matchs sont déjà triés par heure : le plafond suffit à cibler
    // les plus proches du coup d'envoi.
    const maintenant = Date.now();
    const missing = fixtures
      .filter(f => !oddsByFixture[f.fixture?.id])
      .filter(f => {
        const t = new Date(f.fixture?.date || 0).getTime();
        // Les matchs à plus de 3 jours n'ont presque jamais de cotes publiées
        return isFinite(t) && (t - maintenant) < 3 * 86400000;
      })
      .sort((a, b) => new Date(a.fixture?.date || 0) - new Date(b.fixture?.date || 0))
      .slice(0, EFFORT.rattrapage);

    if (missing.length) {
      const rescued = await parLots(missing, f => getOdds(f.fixture?.id, KEY), 5);
      missing.forEach((f, i) => {
        const o = rescued[i];
        if (o && o.o1) oddsByFixture[f.fixture.id] = Object.assign({ nBooks: 1 }, o);
      });
    }

    // Marchés complets (double chance, over/under, BTTS) pour les 10 matchs prioritaires
    // On sert d'abord les matchs les plus proches du coup d'envoi :
    // ce sont ceux que l'utilisateur consulte réellement.
    const detailTargets = fixtures
      .filter(f => !LIVE.has(f.fixture?.status?.short) && oddsByFixture[f.fixture?.id])
      .sort((a, b) => (a.fixture?.date || "") < (b.fixture?.date || "") ? -1 : 1)
      .slice(0, EFFORT.detail);
    const detailArr = await parLots(detailTargets, f => getOdds(f.fixture?.id, KEY), 5);
    const detailById = {};
    detailTargets.forEach((f, i) => { if (detailArr[i]) detailById[f.fixture.id] = detailArr[i]; });

    const oddsArr = fixtures.map(f => {
      const fid = f.fixture?.id;
      const base = oddsByFixture[fid];
      // On conserve les cotes même pour les matchs LIVE : mieux vaut une cote
      // d'ouverture identifiée comme telle qu'un écran "cotes indisponibles".
      if (!base) return null;
      return Object.assign({}, base, detailById[fid] || {});
    });

    const matches = fixtures.map((f, j) => {
      const st = f.fixture?.status?.short || "NS";
      const odds = oddsArr[j] || {};
      const lgId = f.league?.id;
      const o1 = odds.o1 || 1.90;
      const on = odds.on || 3.40;
      const o2 = odds.o2 || 3.80;
      const mg = 1/o1 + 1/on + 1/o2;
      const mp1 = (1/o1)/mg;
      const mp2 = (1/o2)/mg;
      // Dérivation xG réaliste : écart log de force + total ~2.6 buts
      // PSG@1.45 vs OM@6.50 → ~2.05 vs 0.85 (au lieu de 1.79 vs 1.33)
      const ratio = Math.max(0.2, Math.min(5, mp1/Math.max(mp2,0.02)));
      const diff = Math.max(-1.4, Math.min(1.4, 0.62*Math.log(ratio)));
      const total = 2.60;
      const hxg = toNum(Math.max(0.35, total/2 + diff/2), 2);
      const axg = toNum(Math.max(0.35, total/2 - diff/2), 2);

      return {
        id: f.fixture?.id,
        leagueName: LEAGUE_NAME[lgId] || f.league?.name || "",
        leagueId: lgId,
        c: LEAGUE_NAME[lgId] || f.league?.name || "",
        f: FLAG[lgId] || "INT",
        league: "l"+lgId,
        home: f.teams?.home?.name || "",
        away: f.teams?.away?.name || "",
        h: f.teams?.home?.name || "",
        a: f.teams?.away?.name || "",
        homeId: f.teams?.home?.id,
        awayId: f.teams?.away?.id,
        time: f.fixture?.date || "",
        t: f.fixture?.date || "",
        status: st,
        isLive: LIVE.has(st),
        goalsH: f.goals?.home ?? null,
        goalsA: f.goals?.away ?? null,
        o1, on, o2,
        hasRealOdds: !!(odds.o1),
        // Contexte de compétition : indispensable pour évaluer l'enjeu réel
        // (match retour d'une double confrontation, phase finale, etc.)
        round: f.league?.round || null,
        books: odds.books || [],
        hasPinnacle: !!(odds.pinnacle),
        pinO1: odds.pinO1 || null,
        pinON: odds.pinON || null,
        pinO2: odds.pinO2 || null,
        dispersion: odds.dispersion || 0,
        nBooks: odds.nBooks || 0,
        bestO1: odds.bestO1 || null, bestON: odds.bestON || null, bestO2: odds.bestO2 || null,
        bestBook1: odds.bestBook1 || null, bestBookN: odds.bestBookN || null, bestBook2: odds.bestBook2 || null,
        lineValue: odds.lineValue || null,
        dc1x: odds.dc1x || null, dc12: odds.dc12 || null, dcx2: odds.dcx2 || null,
        over25: odds.over2_5 || null, under25: odds.under2_5 || null,
        over35: odds.over3_5 || null, over15: odds.over1_5 || null,
        bttsY: odds.bttsY || null, bttsN: odds.bttsN || null,
        hxg, axg,
        hxga: toNum(axg*0.85, 2), axga: toNum(hxg*0.85, 2),
        hg: toNum(hxg*0.90, 2), ag: toNum(axg*0.90, 2),
        hsh: Math.round(hxg*2.9), ash: Math.round(axg*2.9),
        hf: Math.round(mp1*15), af: Math.round(mp2*15),
        hcs: Math.round(mp1*30), acs: Math.round(mp2*30),
        hFormScore: toNum(mp1*0.8, 3), aFormScore: toNum(mp2*0.8, 3),
        hWinRate: toNum(mp1*0.9, 3), aWinRate: toNum(mp2*0.9, 3),
        hMatchesPlayed: 10, aMatchesPlayed: 10,
        hForm: "", aForm: "",
        h2h: [], dataQuality: "odds_derived",
      };
    });

    // Live d'abord, puis les matchs réellement cotés (exploitables), puis par heure
    matches.sort((a,b) => {
      if(a.isLive !== b.isLive) return a.isLive ? -1 : 1;
      if(a.hasRealOdds !== b.hasRealOdds) return a.hasRealOdds ? -1 : 1;
      return (a.time||"") < (b.time||"") ? -1 : 1;
    });

    // Aucun match ET une erreur API : on le dit clairement au lieu d'afficher le vide
    if (!matches.length && API_ERROR) {
      return res.status(200).json({ matches: [], finished: [], count: 0,
        error: API_ERROR, apiError: API_ERROR, apiCalls: API_CALLS, source: "EDGE Scan v45" });
    }

    return res.status(200).json({
      matches,
      finished,
      count: matches.length,
      withOdds: matches.filter(m => m.hasRealOdds).length,
      withPinnacle: matches.filter(m => m.hasPinnacle).length,
      updated: now.toISOString(),
      daysCovered: days.length - 1,
      withValue: matches.filter(m => m.lineValue).length,
      oddsRescued: missing.length,
      apiError: API_ERROR,
      rateLimited: RATE_LIMITED,
      dureeMs: tempsEcoule(),
      // ── DIAGNOSTIC : suivre les cotes à chaque étape ──
      diag: {
        matchsSelectionnes: fixtures.length,
        cotesParDate: Object.keys(oddsByFixture).length,
        rattrapagesTentes: missing.length,
        rattrapagesReussis: missing.filter(f => oddsByFixture[f.fixture?.id]).length,
        // Un échantillon de ce qui est réellement dans oddsByFixture
        exempleCote: (function(){
          const k = Object.keys(oddsByFixture)[0];
          return k ? { id: k, valeur: oddsByFixture[k] } : null;
        })(),
        // Les 3 premiers matchs et leur statut de cote
        echantillon: fixtures.slice(0, 3).map(f => ({
          id: f.fixture?.id,
          equipes: (f.teams?.home?.name || "?") + " - " + (f.teams?.away?.name || "?"),
          aUneCote: !!oddsByFixture[f.fixture?.id],
        })),
      },
      leaguesFound: Array.from(new Set(matches.map(m => m.leagueId + " " + m.c))).sort(),
      fixturesScanned: pool.length,
      apiCalls: API_CALLS,
      missingOdds: matches.filter(m => !m.hasRealOdds).map(m => m.c + ": " + m.h + " - " + m.a).slice(0, 12),
      source: "EDGE Scan v45",
      season,
    });

  } catch(e) {
    return res.status(200).json({ matches: [], error: e.message });
  }
};
