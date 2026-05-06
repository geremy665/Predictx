// ═══════════════════════════════════════════════════════════════
// EDGE — api/tips.js
// Génère les meilleurs Value Bets du jour via Mistral
// Reçoit les matchs enrichis + retourne JSON tips triés par edge
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Cache-Control","s-maxage=300, stale-while-revalidate=600");
  if (req.method==="OPTIONS") return res.status(200).end();

  const MKEY = process.env.MISTRAL_API_KEY || "lvoeRXlFieBv5hpfh3TlZ12FZiFvIF8w";

  let body={};
  try {
    let raw="";
    if (req.body&&typeof req.body==="object") { body=req.body; }
    else {
      await new Promise((res2,rej)=>{
        req.on("data",c=>{raw+=c.toString();});
        req.on("end",res2); req.on("error",rej);
      });
      if(raw) body=JSON.parse(raw);
    }
  } catch(e){}

  const matches = body.matches || [];
  if (!matches.length) return res.status(400).json({error:"matches requis",tips:[]});

  // Trier par edge calculé (si dispo) puis construire contexte
  const ranked = matches
    .filter(m=>!m.isLive)
    .sort((a,b)=>{
      const ea=(a.e&&a.e.edg)||0, eb=(b.e&&b.e.edg)||0;
      return eb-ea;
    })
    .slice(0,20);

  const today = new Date().toLocaleDateString("fr-FR");
  const ctx   = ranked.map((m,i)=>{
    const e=m.e||{};
    const parts=[
      `${i+1}. ${m.h||m.home} vs ${m.a||m.away} | ${m.leagueName||m.c||""} | ${m.time||"?"}`,
      `Cotes: 1=${m.o1}x N=${m.on}x 2=${m.o2}x`,
    ];
    if(e.pH)  parts.push(`Probas EDGE: DOM ${(e.pH*100).toFixed(0)}% NUL ${(e.pN*100).toFixed(0)}% EXT ${(e.pA*100).toFixed(0)}%`);
    if(e.lH)  parts.push(`Lambda: DOM ${(+e.lH).toFixed(2)} EXT ${(+e.lA).toFixed(2)}`);
    if(e.edg) parts.push(`Edge=${((e.edg||0)*100).toFixed(1)}% Conf=${e.conf||0}% Signal=${e.bR||"?"} ${e.label||""}`);
    if(e.o25) parts.push(`Plus2.5=${((e.o25||0)*100).toFixed(0)}% BTTS=${((e.btts||0)*100).toFixed(0)}%`);
    if(m.hStats?.form5) parts.push(`Forme: DOM ${m.hStats.form5} EXT ${m.aStats?.form5||"?"}`);
    if(m.hRank) parts.push(`Classement: DOM #${m.hRank} EXT #${m.aRank}`);
    if(m.injuries?.homeInj?.length||m.injuries?.awayInj?.length) {
      const hInj=(m.injuries.homeInj||[]).slice(0,2).map(i=>i.player).join(", ");
      const aInj=(m.injuries.awayInj||[]).slice(0,2).map(i=>i.player).join(", ");
      if(hInj) parts.push(`Blessés DOM: ${hInj}`);
      if(aInj) parts.push(`Blessés EXT: ${aInj}`);
    }
    return parts.join(" | ");
  }).join("\n");

  const prompt = `Tu es EDGE, algorithme de sélection de paris value — le meilleur du marché.
Date: ${today}

MATCHS DISPONIBLES (triés par edge détecté par le moteur Dixon-Coles V13):
${ctx}

RÈGLES ABSOLUES:
1. Utilise UNIQUEMENT les matchs listés ci-dessus — JAMAIS inventer un match
2. Sélectionne 5-8 MEILLEURS paris value (priorité: edge ET confiance élevée)
3. Varie les marchés (1X2, buts, BTTS)
4. Mise max 3% bankroll par pari
5. Ne propose que des paris avec edge > 3%

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour):
[{"h":"équipe dom exacte","a":"équipe ext exacte","c":"ligue exacte","t":"heure","bet":"pari exact","odds":2.10,"conf":72,"edge":5.2,"reason":"raison précise 1 phrase basée sur stats","val":true,"mise":2,"marche":"1X2"}]`;

  try {
    const resp = await fetch("https://api.mistral.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${MKEY}`},
      body: JSON.stringify({
        model:"mistral-small-latest",
        max_tokens:1200,
        temperature:0.1,
        messages:[{role:"user",content:prompt}]
      }),
      signal: AbortSignal.timeout(25000)
    });
    const data  = await resp.json();
    const text  = data.choices?.[0]?.message?.content||"";
    const clean = text.replace(/```json/g,"").replace(/```/g,"").trim();
    const tips  = JSON.parse(clean);

    // Valider les tips
    const valid = Array.isArray(tips) ? tips.filter(t=>{
      if(!t.h||!t.a||!t.bet||!t.odds) return false;
      if(t.odds<1.10||t.odds>25) return false;
      return true;
    }) : [];

    return res.status(200).json({
      tips: valid,
      count: valid.length,
      generated: new Date().toISOString(),
      model: "mistral-small-latest"
    });

  } catch(e) {
    return res.status(500).json({error:e.message, tips:[]});
  }
};
