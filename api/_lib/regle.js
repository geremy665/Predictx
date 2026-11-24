// ═══════════════════════════════════════════════════════════════
// EDGE — api/_lib/regle.js
// La règle v2, à l'identique de l'appli, pour que le serveur tienne la
// Preuve tout seul (téléphone éteint ou non).
// ═══════════════════════════════════════════════════════════════
const SDJ = { coteMin: 1.30, coteMax: 6.00, seuilOutsider: 4.00, maxOutsiders: 1,
  horizonH: 24, maxTotal: 3, maxParType: 2, regle: "v2" };
const EV_SUSPECT = 1.15;
const seuilEV = (cote, mult) => 1 + 0.01 * (mult || 1) * cote;
const multPrudence = src => (src === "Pinnacle" ? 1 : 2);
function coteMinRegle(p, mult) {
  const k = 0.01 * (mult || 1);
  if (!(p > k + 0.001)) return null;
  return Math.ceil((1 / (p - k)) * 100 - 1e-9) / 100;
}

// Opérateurs agréés par l'ANJ (même liste que l'appli)
const AGREES_FR = ["winamax", "betclic", "unibet", "bwin", "pmu", "parions sport", "parionssport", "fdj",
  "netbet", "zebet", "vbet", "genybet", "pokerstars", "olybet", "feelingbet", "barriere", "barrière", "france pari"];
function estAgreeFR(nom) {
  const n = String(nom || "").toLowerCase().replace(/[^a-zàâéèêëîïôûüç ]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return false;
  return AGREES_FR.some(a => n === a || n.indexOf(a + " ") === 0 || n.indexOf(" " + a) >= 0 ||
    n.replace(/ /g, "") === a.replace(/ /g, ""));
}

function devigShin(o1, on, o2) {
  if (!o1 || !on || !o2) return null;
  const r = [1 / o1, 1 / on, 1 / o2];
  const somme = r[0] + r[1] + r[2];
  if (!(somme > 1)) return null;
  const probs = z => r.map(ri => {
    const inner = z * z + 4 * (1 - z) * ri * ri / somme;
    if (inner < 0) return 0;
    return (Math.sqrt(inner) - z) / (2 * (1 - z));
  });
  let lo = 0, hi = 0.4, z = 0;
  for (let it = 0; it < 80; it++) {
    z = (lo + hi) / 2;
    const s = probs(z).reduce((a, b) => a + b, 0);
    if (s > 1) lo = z; else hi = z;
  }
  const p = probs(z), tot = p[0] + p[1] + p[2];
  if (!isFinite(tot) || tot <= 0 || !p.every(x => isFinite(x) && x > 0)) return null;
  return { p1: p[0] / tot, pn: p[1] / tot, p2: p[2] / tot };
}
function devigPower(o1, on, o2) {
  if (!o1 || !on || !o2) return null;
  const r = [1 / o1, 1 / on, 1 / o2];
  let lo = 0.5, hi = 1.5, k = 1;
  for (let it = 0; it < 60; it++) {
    k = (lo + hi) / 2;
    const s = Math.pow(r[0], k) + Math.pow(r[1], k) + Math.pow(r[2], k);
    if (s > 1) lo = k; else hi = k;
  }
  const p = r.map(x => Math.pow(x, k)), tot = p[0] + p[1] + p[2];
  if (!isFinite(tot) || tot <= 0) return null;
  return { p1: p[0] / tot, pn: p[1] / tot, p2: p[2] / tot };
}
function consensus(books) {
  let acc = [0, 0, 0], wTot = 0, n = 0;
  (books || []).forEach(b => {
    if (!(b.o1 > 1 && b.on > 1 && b.o2 > 1)) return;
    const d = devigShin(b.o1, b.on, b.o2) || devigPower(b.o1, b.on, b.o2);
    if (!d) return;
    const mg = 1 / b.o1 + 1 / b.on + 1 / b.o2 - 1;
    if (!isFinite(mg) || mg <= 0) return;
    const w = 1 / Math.max(mg, 0.005);
    acc[0] += d.p1 * w; acc[1] += d.pn * w; acc[2] += d.p2 * w; wTot += w; n++;
  });
  if (!wTot || n < 3) return null;
  const s = acc[0] + acc[1] + acc[2];
  return { p1: acc[0] / s, pn: acc[1] / s, p2: acc[2] / s };
}
// Probabilité du marché : Pinnacle marge retirée, sinon le consensus
function probMarche(ev) {
  const pin = (ev.books || []).find(b => /pinnacle/i.test(b.n || ""));
  if (pin && pin.o1 > 1 && pin.on > 1 && pin.o2 > 1) {
    const d = devigShin(pin.o1, pin.on, pin.o2) || devigPower(pin.o1, pin.on, pin.o2);
    if (d) return Object.assign(d, { src: "Pinnacle" });
  }
  const c = consensus(ev.books);
  return c ? Object.assign(c, { src: "consensus des bookmakers" }) : null;
}
function meilleurPrixFR(ev, issue) {
  const champ = { "1": "o1", "N": "on", "2": "o2" }[issue];
  let best = null;
  (ev.books || []).forEach(b => {
    if (!estAgreeFR(b.n)) return;
    const v = parseFloat(b[champ]);
    if (isFinite(v) && v > 1 && (!best || v > best.cote)) best = { cote: v, book: b.n };
  });
  return best;
}
// Meilleur pari d'un match selon la règle (ou null)
function candidat(ev) {
  const pm = probMarche(ev);
  if (!pm) return { analyse: false, cand: null, pm: null };
  let meilleur = null, suspects = 0;
  [["1", pm.p1, "Victoire " + ev.h], ["N", pm.pn, "Match nul"], ["2", pm.p2, "Victoire " + ev.a]].forEach(x => {
    const fr = meilleurPrixFR(ev, x[0]);
    if (!fr || fr.cote < SDJ.coteMin || fr.cote > SDJ.coteMax) return;
    const evv = x[1] * fr.cote, mult = multPrudence(pm.src);
    if (!isFinite(evv) || evv < seuilEV(fr.cote, mult)) return;
    if (evv > EV_SUSPECT) { suspects++; return; }
    if (!meilleur || evv > meilleur.ev) meilleur = { k: x[0], label: x[2], prob: x[1], src: pm.src,
      cote: fr.cote, book: fr.book, ev: evv, mult, coteMin: coteMinRegle(x[1], mult) };
  });
  return { analyse: true, cand: meilleur, pm, suspects };
}

// Jour du coup d'envoi, heure de Paris (AAAA-MM-JJ)
function jourParis(ts) {
  try { return new Date(ts).toLocaleDateString("fr-CA", { timeZone: "Europe/Paris" }); }
  catch (e) { return new Date(ts).toISOString().slice(0, 10); }
}

// ── Rapprochement des noms d'équipes entre deux fournisseurs ──
const VIDES = new Set(["fc", "cf", "afc", "ac", "sc", "as", "ss", "ssc", "sv", "fk", "sk", "cd", "ud", "rc", "rcd",
  "sd", "club", "de", "la", "le", "the", "calcio", "football", "futbol", "cfc", "bk", "if", "aj", "ogc", "hsc", "us"]);
const ALIAS = { utd: "united", st: "saint", munchen: "munich", internazionale: "inter", wolves: "wolverhampton",
  spurs: "tottenham", psg: "paris", koln: "cologne", man: "manchester", nott: "nottingham", olympique: "" };
function jetons(nom) {
  return String(nom || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .map(t => (ALIAS[t] !== undefined ? ALIAS[t] : t))
    .filter(t => t && t.length > 1 && !VIDES.has(t) && !/^\d+$/.test(t));
}
function simEquipe(a, b, strict) {
  const A = jetons(a), B = jetons(b);
  if (!A.length || !B.length) return 0;
  let n = 0;
  A.forEach(x => { if (B.some(y => y === x || (x.length >= 4 && y.length >= 4 && (x.indexOf(y) === 0 || y.indexOf(x) === 0)))) n++; });
  // strict : mêmes mots des deux côtés (« Paris FC » ≠ « Paris Saint-Germain »)
  return n / (strict ? Math.max(A.length, B.length) : Math.min(A.length, B.length));
}
// Même match ? Note > 0 si oui (plus elle est haute, plus c'est sûr).
function memeMatch(h1, a1, t1, h2, a2, t2) {
  const dt = Math.abs(new Date(t1).getTime() - new Date(t2).getTime());
  if (!isFinite(dt) || dt > 30 * 60000) return 0;
  const sh = simEquipe(h1, h2), sa = simEquipe(a1, a2);
  // Les deux équipes se ressemblent, et au moins une franchement
  if (Math.min(sh, sa) >= 0.5 && sh + sa >= 1.5) return 1 + sh + sa;
  // Une équipe au nom identique à la même heure : une équipe ne joue
  // jamais deux matchs en même temps
  const xh = simEquipe(h1, h2, true), xa = simEquipe(a1, a2, true);
  if (Math.max(xh, xa) >= 0.99 && dt <= 10 * 60000) return 0.5 + xh + xa;
  return 0;
}

module.exports = { SDJ, EV_SUSPECT, seuilEV, multPrudence, coteMinRegle, estAgreeFR, devigShin, devigPower,
  consensus, probMarche, meilleurPrixFR, candidat, jourParis, simEquipe, memeMatch };
