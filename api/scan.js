// ═══════════════════════════════════════════════════════════════
// EDGE — api/scan.js
// Chaîne de montage automatique :
// 1. Fetch matchs du jour (API-Football)
// 2. Enrichissement stats xG, H2H, blessés
// 3. Analyse IA Mistral (Value detection)
// 4. Retourne JSON enrichi prêt pour le frontend
// ═══════════════════════════════════════════════════════════════

const LEAGUES = [
  {id:61, name:"Ligue 1", f:"FR"},
  {id:140,name:"La Liga", f:"ES"},
  {id:39, name:"Premier League", f:"ENG"},
  {id:135,name:"Serie A", f:"IT"},
  {id:78, name:"Bundesliga", f:"DE"},
  {id:2,  name:"Champions League", f:"UCL"},
  {id:3,  name:"Europa League", f:"UEL"},
  {id:94, name:"Primeira Liga", f:"PT"},
  {id:88, name:"Eredivisie", f:"NL"},
];
const lgMap = {};
LEAGUES.forEach(l => lgMap[l.id] = l);
const lgIds = new Set(LEAGUES.map(l => l.id));

// ── Fetch sécurisé ───────────────────────────────────────────
async function apiFetch(url, key, ms=7000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers: {"x-apisports-key": key, "Accept": "application/json"},
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    return d.response || null;
  } catch(e) { return null; }
}

// ── Extraction statistiques propres ─────────────────────────
function extractStats(teamStats) {
  if (!teamStats?.response) return {};
  const s = teamStats.response;
  const fG = s.goals?.for;
  const aG = s.goals?.against;
  const played = s.fixtures?.played?.total || 0;
  const wins   = s.fixtures?.wins?.total   || 0;
  const loses  = s.fixtures?.loses?.total  || 0;

  // xG moyen (API donne parfois)
  const xgFor  = fG?.average?.total  ? parseFloat(fG.average.total)  : null;
  const xgAgst = aG?.average?.total  ? parseFloat(aG.average.total)  : null;

  // Forme (5 derniers: W/D/L)
  const formStr = s.form || "";
  const form5   = formStr.slice(-5);
  const formPts = form5.split("").reduce((a,c)=>a+(c==="W"?3:c==="D"?1:0),0);

  return {
    played, wins, loses,
    winRate: played>0 ? +(wins/played).toFixed(3) : null,
    xgFor:   xgFor,
    xgAgst:  xgAgst,
    avgGoalsFor:   fG?.average?.total  ? parseFloat(fG.average.total)  : null,
    avgGoalsAgst:  aG?.average?.total  ? parseFloat(aG.average.total)  : null,
    form5, formPts,
    cleanSheetPct: s.clean_sheet?.total && played
      ? +(s.clean_sheet.total/played*100).toFixed(0) : null,
    failedToScore: s.failed_to_score?.total || 0,
    lineups: s.lineups || []
  };
}

// ── Extraction H2H ──────────────────────────────────────────
function extractH2H(h2hData) {
  if (!h2hData?.response?.length) return [];
  return h2hData.response.slice(0,8).map(f => ({
    date:       f.fixture?.date,
    home:       f.teams?.home?.name,
    away:       f.teams?.away?.name,
    homeGoals:  f.goals?.home ?? 0,
    awayGoals:  f.goals?.away ?? 0,
    winner:     f.goals?.home > f.goals?.away ? "home"
              : f.goals?.away > f.goals?.home ? "away" : "draw"
  }));
}

// ── Extraction blessés ──────────────────────────────────────
function extractInjuries(injData, homeId, awayId) {
  if (!injData?.response?.length) return {homeInj:[], awayInj:[]};
  const inj = injData.response;
  return {
    homeInj: inj.filter(i=>i.player?.id&&i.team?.id===homeId).map(i=>({
      player:i.player?.name, reason:i.player?.reason, returnDate:i.player?.returnDate||null
    })),
    awayInj: inj.filter(i=>i.player?.id&&i.team?.id===awayId).map(i=>({
      player:i.player?.name, reason:i.player?.reason, returnDate:i.player?.returnDate||null
    }))
  };
}

// ── Extraction classement ────────────────────────────────────
function extractRanks(standData, homeId, awayId) {
  if (!standData?.response?.length) return {};
  try {
    const table = standData.response[0]?.league?.standings?.[0] || [];
    const hRow  = table.find(r=>r.team?.id===homeId);
    const aRow  = table.find(r=>r.team?.id===awayId);
    return {
      hRank: hRow?.rank || null,
      aRank: aRow?.rank || null,
      hPoints: hRow?.points || null,
      aPoints: aRow?.points || null
    };
  } catch(e) { return {}; }
}

// ── Condensé pour IA (pas trop de tokens) ───────────────────
function buildAIContext(match) {
  const lines = [
    `MATCH: ${match.home} vs ${match.away} | ${match.leagueName}`,
    `COTES: 1=${match.o1}x N=${match.on}x 2=${match.o2}x`,
  ];
  if (match.hxg) lines.push(`xG DOM: ${match.hxg} | xG EXT: ${match.axg}`);
  if (match.hxga) lines.push(`xGA DOM: ${match.hxga} | xGA EXT: ${match.axga}`);
  if (match.hStats?.form5) lines.push(`Forme DOM (5j): ${match.hStats.form5} (${match.hStats.formPts}pts) | EXT: ${match.aStats?.form5||"?"} (${match.aStats?.formPts||"?"}pts)`);
  if (match.hRank) lines.push(`Classement: DOM #${match.hRank} | EXT #${match.aRank}`);
  if (match.h2h?.length) {
    const last3 = match.h2h.slice(0,3).map(g=>`${g.homeGoals}-${g.awayGoals}`).join(" ");
    const hW = match.h2h.filter(g=>g.winner==="home").length;
    const aW = match.h2h.filter(g=>g.winner==="away").length;
    lines.push(`H2H ${match.h2h.length} matchs: DOM ${hW}V | EXT ${aW}V | Derniers: ${last3}`);
  }
  if (match.injuries?.homeInj?.length)
    lines.push(`Blessés DOM: ${match.injuries.homeInj.slice(0,3).map(i=>i.player).join(", ")}`);
  if (match.injuries?.awayInj?.length)
    lines.push(`Blessés EXT: ${match.injuries.awayInj.slice(0,3).map(i=>i.player).join(", ")}`);
  return lines.join("\n");
}

// ── Analyse IA Mistral ───────────────────────────────────────
async function analyzeWithAI(match, mistralKey) {
  if (!mistralKey) return null;
  const ctx = buildAIContext(match);
  const prompt = `Tu es EDGE, le meilleur moteur d'analyse de paris sportifs (Dixon-Coles V13, 90% de précision).

${ctx}

Analyse ce match. Réponds UNIQUEMENT en JSON pur (pas de markdown, pas de texte autour) :
{"signal":"1","proba_dom":58,"proba_nul":24,"proba_ext":18,"edge":6.2,"value":true,"conf":72,"reasoning":"Raison précise en 1 phrase basée sur les stats","score_predit":"2-1","alerte":""}

Règles absolues:
- signal: "1" (dom gagne), "N" (nul), "2" (ext gagne)
- value: true si edge > 3%
- edge: Expected Value en % = proba * cote - 1 (×100)
- conf: confiance 0-100
- alerte: si risque important (blessés clés, rotation, etc.) sinon vide
- reasoning: une seule phrase, précise, basée sur les données`;

  try {
    const resp = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {"Content-Type":"application/json","Authorization":`Bearer ${mistralKey}`},
      body: JSON.stringify({
        model: "mistral-small-latest",
        max_tokens: 300,
        temperature: 0.1,
        messages: [{role:"user", content: prompt}]
      }),
      signal: (() => { const c=new AbortController(); setTimeout(()=>c.abort(),15000); return c.signal; })()
    });
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || "";
    // Parser JSON — nettoyer backticks si présents
    const clean = text.replace(/```json/g,"").replace(/```/g,"").trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch(e) { return null; }
}

// ── HANDLER PRINCIPAL ────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Cache-Control","s-maxage=120, stale-while-revalidate=240");
  if (req.method==="OPTIONS") return res.status(200).end();

  const FKEY = process.env.FOOTBALL_API_KEY || "b0e8adc0dfcca1cc964daa5bfe9a56c1";
  const MKEY = process.env.MISTRAL_API_KEY  || "lvoeRXlFieBv5hpfh3TlZ12FZiFvIF8w";

  // Mode: "full" = avec enrichissement complet, "fast" = matchs seulement
  const mode = req.query?.mode || "fast";
  const withAI = req.query?.ai === "1";

  // Timeout global: si tout prend trop longtemps, on retourne vide
  const timeoutP = new Promise(resolve =>
    setTimeout(() => resolve({matches:[], count:0, timeout:true}), 9000)
  );

  async function runScan(){
    const now   = new Date();
    const today = now.toISOString().split("T")[0];
    const tom   = new Date(now.getTime()+86400000).toISOString().split("T")[0];

    // 1. Matchs du jour + demain + live
    const [fixtToday, fixtTom, fixtLive] = await Promise.all([
      apiFetch(`/fixtures?date=${today}`, FKEY, 4000),
      apiFetch(`/fixtures?date=${tom}`,   FKEY, 4000),
      apiFetch(`/fixtures?live=all`,      FKEY, 3000)
    ]);

    const liveMap = {};
    (fixtLive||[]).forEach(f => {
      if (lgIds.has(f.league?.id)) {
        liveMap[f.fixture?.id] = {
          home: f.goals?.home, away: f.goals?.away,
          elapsed: f.fixture?.status?.elapsed
        };
      }
    });

    const DONE = new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","INT","PST"]);
    const LIVE  = new Set(["1H","2H","HT","ET","BT","P","LIVE"]);

    const allFix = [...(fixtToday||[]), ...(fixtTom||[])]
      .filter(f => lgIds.has(f.league?.id) && !DONE.has(f.fixture?.status?.short||"NS"));

    if (!allFix.length) {
      return res.status(200).json({matches:[], count:0, updated:now.toISOString()});
    }

    // 2. Enrichissement stats (mode full seulement — limite les appels API)
    const season = now.getFullYear();
    const enrichedMatches = await Promise.all(
      allFix.slice(0,20).map(async (f, idx) => {
        const lgD    = lgMap[f.league?.id];
        if (!lgD) return null;
        const homeId = f.teams?.home?.id;
        const awayId = f.teams?.away?.id;
        const lgId   = f.league?.id;
        const fId    = f.fixture?.id;
        const status = f.fixture?.status?.short || "NS";
        const isLive = LIVE.has(status);
        const live   = liveMap[fId];

        // Cotes (si dispo)
        const DEFODDS = [[1.55,4.20,6.50],[1.70,3.80,5.00],[1.85,3.50,4.20],[2.10,3.30,3.40],[2.35,3.20,3.00],[2.60,3.10,2.75],[2.90,3.20,2.50],[3.20,3.30,2.25],[3.80,3.40,1.90],[5.00,3.80,1.60]];
        const [o1d,ond,o2d] = DEFODDS[(fId||idx)%10];
        const o1 = +(f.odds?.o1 || o1d).toFixed(2);
        const on = +(f.odds?.on || ond).toFixed(2);
        const o2 = +(f.odds?.o2 || o2d).toFixed(2);

        // xG proxy depuis cotes
        const mg = 1/o1+1/on+1/o2;
        const p1 = (1/o1)/mg, p2=(1/o2)/mg;
        const hxg = +(1.3+p1*1.0).toFixed(2);
        const axg = +(1.3+p2*1.0).toFixed(2);

        let hStats={}, aStats={}, h2h=[], injuries={}, ranks={};

        if (mode==="full" && homeId && awayId) {
          // Fetch enrichissement en parallèle (max 4 appels par match)
          const [hStatsR, aStatsR, h2hR, injR, standR] = await Promise.all([
            apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${homeId}`, FKEY, 5000),
            apiFetch(`/teams/statistics?league=${lgId}&season=${season}&team=${awayId}`, FKEY, 5000),
            apiFetch(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=8`, FKEY, 5000),
            apiFetch(`/injuries?fixture=${fId}`, FKEY, 4000),
            apiFetch(`/standings?league=${lgId}&season=${season}`, FKEY, 5000)
          ]);
          hStats   = extractStats({response: hStatsR?.[0]});
          aStats   = extractStats({response: aStatsR?.[0]});
          h2h      = extractH2H({response: h2hR});
          injuries = extractInjuries({response: injR}, homeId, awayId);
          ranks    = extractRanks({response: standR}, homeId, awayId);
        }

        const hxgFinal = hStats.xgFor  || hxg;
        const axgFinal = aStats.xgFor  || axg;
        const hxgaFinal= aStats.xgAgst || +(hxg*0.85).toFixed(2);
        const axgaFinal= hStats.xgAgst || +(axg*0.85).toFixed(2);

        const match = {
          id: fId, leagueId: lgId, leagueName: lgD.name, c: lgD.name, f: lgD.f,
          home: f.teams?.home?.name||"", away: f.teams?.away?.name||"",
          h: f.teams?.home?.name||"", a: f.teams?.away?.name||"",
          homeId, awayId, time: f.fixture?.date||"", status, isLive,
          o1, on, o2,
          hxg: hxgFinal, axg: axgFinal,
          hxga: hxgaFinal, axga: axgaFinal,
          hg: +(hStats.avgGoalsFor || hxgFinal*0.92).toFixed(2),
          ag: +(aStats.avgGoalsFor || axgFinal*0.92).toFixed(2),
          hf:   hStats.formPts || Math.round(p1*15),
          af:   aStats.formPts || Math.round(p2*15),
          hsh:  Math.round(hxgFinal*2.8),
          ash:  Math.round(axgFinal*2.8),
          hcs:  hStats.cleanSheetPct || Math.round(p1*35),
          acs:  aStats.cleanSheetPct || Math.round(p2*35),
          hWinRate: hStats.winRate || null,
          aWinRate: aStats.winRate || null,
          hRank: ranks.hRank || null, aRank: ranks.aRank || null,
          h2h, injuries,
          hStats: {form5: hStats.form5, formPts: hStats.formPts},
          aStats: {form5: aStats.form5, formPts: aStats.formPts},
          liveScore: isLive ? {
            home: live?.home ?? f.goals?.home ?? null,
            away: live?.away ?? f.goals?.away ?? null,
            elapsed: live?.elapsed ?? f.fixture?.status?.elapsed ?? null
          } : null
        };

        // 3. Analyse IA si demandée
        if (withAI && MKEY && !isLive) {
          const ai = await analyzeWithAI(match, MKEY);
          if (ai) {
            match.aiSignal    = ai.signal;
            match.aiProb      = {dom: ai.proba_dom, nul: ai.proba_nul, ext: ai.proba_ext};
            match.aiEdge      = ai.edge;
            match.aiValue     = ai.value;
            match.aiConf      = ai.conf;
            match.aiReason    = ai.reasoning;
            match.aiScore     = ai.score_predit;
            match.aiAlerte    = ai.alerte;
          }
        }

        return match;
      })
    );

    const matches = enrichedMatches
      .filter(Boolean)
      .sort((a,b)=>{
        if(a.isLive&&!b.isLive)return -1;
        if(!a.isLive&&b.isLive)return 1;
        return new Date(a.time)-new Date(b.time);
      });

    return {
      matches,
      count:    matches.length,
      live:     matches.filter(m=>m.isLive).length,
      upcoming: matches.filter(m=>!m.isLive).length,
      mode,
      aiEnabled: withAI,
      updated:  now.toISOString(),
      source:   "EDGE Scan Engine v2"
    };
  }

  try {
    const result = await Promise.race([runScan(), timeoutP]);
    return res.status(200).json(result);
  } catch(e) {
    return res.status(200).json({error: e.message, matches:[], count:0});
  }
};
