// ═══════════════════════════════════════════════════════════════
// EDGE — api/chat.js v3
// Chat IA avec contexte match injecté
// ═══════════════════════════════════════════════════════════════

const RATE_LIMIT = new Map();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();
  if (req.method!=="POST") return res.status(405).json({error:"POST requis"});

  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
  if (!CLAUDE_KEY && !MISTRAL_KEY) return res.status(500).json({error:"Clés IA manquantes"});

  // Rate limit: 20 req/heure par IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]||"unknown";
  const now = Date.now();
  const hits = (RATE_LIMIT.get(ip)||[]).filter(t=>now-t<3600000);
  if(hits.length>=20) return res.status(429).json({error:"Limite atteinte — réessaie dans 1h"});
  hits.push(now);
  RATE_LIMIT.set(ip, hits);

  let body={};
  try{
    if(req.body&&typeof req.body==="object"){body=req.body;}
    else{
      let raw="";
      await new Promise((r,rj)=>{req.on("data",c=>{raw+=c;});req.on("end",r);req.on("error",rj);});
      try{body=JSON.parse(raw);}catch(e){}
    }
  }catch(e){}

  const messages = body.messages||[];
  if(!messages.length) return res.status(400).json({error:"Messages requis"});

  // Construire le contexte match si disponible
  const matchCtx = body.matchContext || null;
  const appCtx = body.appContext || null;

  let systemPrompt = `Tu es EDGE, un assistant d'analyse de paris sportifs.
Tu aides les parieurs à comprendre les matchs avec des données mathématiques réelles.
Tu es direct, factuel, et tu rappelles toujours que le pari comporte des risques. 18+ uniquement.
Tu ne garantis JAMAIS de gains. Tu analyses, tu n'assures pas.`;

  // Injecter le contexte match si disponible
  if(matchCtx){
    const m = matchCtx;
    const r = matchCtx.edgeResult||null;
    systemPrompt += `\n\n=== DONNÉES RÉELLES DU MATCH EN COURS ===`;
    systemPrompt += `\nMatch: ${m.home||m.h} vs ${m.away||m.a}`;
    if(m.leagueName||m.league) systemPrompt += ` | ${m.leagueName||m.league}`;
    if(m.time) systemPrompt += ` | ${new Date(m.time).toLocaleString("fr-FR",{hour:"2-digit",minute:"2-digit"})}`;
    systemPrompt += `\nCotes: DOM ${m.o1||"?"}x | NUL ${m.on||m.oN||"?"}x | EXT ${m.o2||"?"}x`;
    if(m.hasRealOdds===false) systemPrompt += ` ⚠️ Cotes estimées`;
    if(m.hxg&&m.axg) systemPrompt += `\nxG attendus: DOM ${m.hxg} | EXT ${m.axg}`;
    if(m.hf!=null&&m.af!=null) systemPrompt += `\nForme (5 matchs): DOM ${m.hf}/15pts | EXT ${m.af}/15pts`;
    if(m.hRank&&m.aRank) systemPrompt += `\nClassement: DOM #${m.hRank} | EXT #${m.aRank}`;
    if(r){
      systemPrompt += `\n\n--- Résultat moteur EDGE ---`;
      systemPrompt += `\nProbas: DOM ${((r.pH||0)*100).toFixed(1)}% | NUL ${((r.pN||0)*100).toFixed(1)}% | EXT ${((r.pA||0)*100).toFixed(1)}%`;
      systemPrompt += `\nSignal: ${r.label||r.bR||"?"} @ ${r.bO||"?"}x`;
      systemPrompt += `\nEdge: ${((r.edg||0)*100).toFixed(1)}% | Confiance: ${r.conf||0}/100`;
      if(r.dataQ) systemPrompt += `\nQualité données: ${["Faible","Moyenne","Bonne","Excellente"][Math.min((r.dataQ||1)-1,3)]}`;
    }
    if(m.h2h&&m.h2h.length){
      const h=m.h2h.slice(0,5);
      const hW=h.filter(g=>g.winner==="home").length;
      const aW=h.filter(g=>g.winner==="away").length;
      systemPrompt += `\nH2H (${h.length} matchs): DOM ${hW}V ${h.length-hW-aW}N ${aW}D`;
    }
    systemPrompt += `\n\nUtilise ces données pour répondre aux questions. Si une donnée manque, dis-le.`;
  }

  // Contexte global app (matchs du jour, bankroll)
  if(appCtx){
    if(appCtx.totalMatches) systemPrompt += `\n\nMatchs chargés aujourd'hui: ${appCtx.totalMatches}`;
    if(appCtx.valueCount) systemPrompt += ` | Value bets détectés: ${appCtx.valueCount}`;
    if(appCtx.bankroll) systemPrompt += `\nBankroll utilisateur: ${appCtx.bankroll}€`;
    if(appCtx.roi!=null) systemPrompt += ` | ROI: ${appCtx.roi}%`;
  }

  const maxTokens = Math.min(body.max_tokens||1200, 2000);

  // Essayer Claude en premier
  if(CLAUDE_KEY){
    try{
      const response = await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-api-key": CLAUDE_KEY,
          "anthropic-version":"2023-06-01"
        },
        body:JSON.stringify({
          model:"claude-sonnet-4-6",
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: messages.slice(-8)
        })
      });

      if(response.ok){
        const data = await response.json();
        const text = data.content?.[0]?.text||"";
        if(text) return res.status(200).json({text, model:"claude-sonnet-4-6"});
      }
    }catch(e){}
  }

  // Fallback Mistral
  if(MISTRAL_KEY){
    try{
      const msgsWithSystem = [
        {role:"user", content:systemPrompt+"\n\nCompris?"},
        {role:"assistant", content:"Compris. Je suis EDGE, prêt à analyser avec les données disponibles."},
        ...messages.slice(-6)
      ];
      const mr = await fetch("https://api.mistral.ai/v1/chat/completions",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${MISTRAL_KEY}`},
        body:JSON.stringify({
          model:"mistral-small-latest",
          max_tokens: maxTokens,
          temperature:0.3,
          messages: msgsWithSystem
        })
      });
      if(mr.ok){
        const md = await mr.json();
        const text = md.choices?.[0]?.message?.content||"";
        if(text) return res.status(200).json({text, model:"mistral-small-latest"});
      }
    }catch(e){}
  }

  return res.status(502).json({error:"IA temporairement indisponible"});
};
