// ═══════════════════════════════════════════════════════════════
// EDGE — api/analyze.js
// Analyse Sherlock complète d'un match spécifique
// Reçoit les données du match + retourne analyse IA structurée
// ═══════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  const MKEY = process.env.MISTRAL_API_KEY || "lvoeRXlFieBv5hpfh3TlZ12FZiFvIF8w";

  let body={};
  try {
    let raw="";
    if(req.body&&typeof req.body==="object"){body=req.body;}
    else{
      await new Promise((r2,rj)=>{req.on("data",c=>{raw+=c.toString();});req.on("end",r2);req.on("error",rj);});
      if(raw) body=JSON.parse(raw);
    }
  } catch(e){}

  const d=body.match||body; // données du match
  const r=body.result||body.calc; // résultat calc() du moteur

  const lines=[];
  lines.push(`=== MATCH ===`);
  lines.push(`${d.home||d.h||"?"} vs ${d.away||d.a||"?"} | ${d.league||d.c||d.leagueName||"?"}`);
  lines.push(`Cotes: 1=${d.o1||"?"}x N=${d.on||d.oN||"?"}x 2=${d.o2||"?"}x`);
  lines.push("");

  if(r){
    lines.push(`=== MOTEUR EDGE (Dixon-Coles V13 — 90% précision) ===`);
    lines.push(`Probas: DOM ${(r.pH*100).toFixed(1)}% | NUL ${(r.pN*100).toFixed(1)}% | EXT ${(r.pA*100).toFixed(1)}%`);
    lines.push(`Lambda: DOM λ=${(+r.lH).toFixed(2)} buts attendus | EXT λ=${(+r.lA).toFixed(2)} buts attendus`);
    lines.push(`Signal: ${r.bR} = ${r.label||""} @ ${r.bO||"?"}x | Edge: ${((r.edg||0)*100).toFixed(2)}% | Kelly: ${((r.kel||0)*100).toFixed(2)}% BK | Conf: ${r.conf||0}/100`);
    if(r.mcH) lines.push(`Monte Carlo 1000 sim: DOM ${(r.mcH*100).toFixed(0)}% NUL ${(r.mcN*100).toFixed(0)}% EXT ${(r.mcA*100).toFixed(0)}%`);
    if(r.sc2&&r.sc2.length) lines.push(`Scores probables: ${r.sc2.slice(0,4).map(s=>`${s.h}-${s.a}(${(s.p*100).toFixed(1)}%)`).join(" ")}`);
    if(r.markets){
      const mkts=r.markets.filter(m=>m.p>0.1).slice(0,5);
      lines.push(`Marchés: ${mkts.map(m=>`${m.n} ${(m.p*100).toFixed(0)}%${m.e?" EV+"+((m.e||0)*100).toFixed(1)+"%":""}`).join(" | ")}`);
    }
    lines.push("");
  }

  lines.push(`=== STATS BRUTES ===`);
  lines.push(`xG dom=${d.hxg||d.hXG||"?"} xGA dom=${d.hxga||d.hXGA||"?"} | xG ext=${d.axg||d.aXG||"?"} xGA ext=${d.axga||d.aXGA||"?"}`);
  lines.push(`Forme dom=${d.hf||d.hF||"?"}pts ext=${d.af||d.aF||"?"}pts | Tirs dom=${d.hsh||"?"} ext=${d.ash||"?"}`);
  lines.push(`Clean sheets dom=${d.hcs||"?"}% ext=${d.acs||"?"}%`);
  lines.push("");

  const ctx=[];
  if(d.rotationH>0)ctx.push(`DOM rotation ${d.rotationH===2?"massive":"légère"}`);
  if(d.rotationA>0)ctx.push(`EXT rotation ${d.rotationA===2?"massive":"légère"}`);
  if(d.keyPlayerOut>0)ctx.push(`Absents DOM ${d.keyPlayerOut}/10`);
  if(d.keyPlayerOutA>0)ctx.push(`Absents EXT ${d.keyPlayerOutA}/10`);
  if(d.matchsLast7H>=2)ctx.push(`DOM fatigue ${d.matchsLast7H}m/7j`);
  if(d.matchsLast7A>=2)ctx.push(`EXT fatigue ${d.matchsLast7A}m/7j`);
  if(d.derby)ctx.push("DERBY variance élevée");
  if(d.stakeLevel===0)ctx.push("Match sans enjeu");
  if(d.stakeLevel===3)ctx.push("Match décisif");
  if(d.hRank&&d.aRank)ctx.push(`Classement DOM #${d.hRank} EXT #${d.aRank}`);
  if(r&&r.ctx&&r.ctx.length)ctx.push(...r.ctx.slice(0,3));
  if(ctx.length) lines.push(`=== CONTEXTE ===\n${ctx.join(" | ")}\n`);

  if(d.h2h&&d.h2h.length){
    const h2h=d.h2h.slice(0,6);
    const hW=h2h.filter(g=>g.winner==="home").length;
    const aW=h2h.filter(g=>g.winner==="away").length;
    const avgGH=h2h.reduce((s,g)=>s+(g.homeGoals||0),0)/h2h.length;
    const avgGA=h2h.reduce((s,g)=>s+(g.awayGoals||0),0)/h2h.length;
    lines.push(`=== H2H (${h2h.length} matchs) ===`);
    lines.push(`DOM ${hW}V ${h2h.length-hW-aW}N ${aW}D | Buts moy DOM ${avgGH.toFixed(1)} EXT ${avgGA.toFixed(1)}`);
    lines.push(`Derniers: ${h2h.slice(0,3).map(g=>`${g.homeGoals||0}-${g.awayGoals||0}`).join(" ")}\n`);
  }
  if(d.injuries){
    const hInj=(d.injuries.homeInj||[]).slice(0,4).map(i=>i.player).join(", ");
    const aInj=(d.injuries.awayInj||[]).slice(0,4).map(i=>i.player).join(", ");
    if(hInj||aInj){
      lines.push(`=== BLESSÉS ===`);
      if(hInj) lines.push(`DOM: ${hInj}`);
      if(aInj) lines.push(`EXT: ${aInj}`);
      lines.push("");
    }
  }

  lines.push(`=== MISSION ===`);
  lines.push(`Analyse ce match comme Sherlock Holmes — chaque donnée est un indice.`);
  lines.push(`Structure ta réponse EXACTEMENT ainsi:`);
  lines.push(`VERDICT: [pari recommandé] @ [cote]x | Mise: [X]% bankroll`);
  lines.push(`FORCES DOM: [3 points max basés sur stats]`);
  lines.push(`FORCES EXT: [3 points max basés sur stats]`);
  lines.push(`RISQUES: [blessures, fatigue, derby, météo]`);
  lines.push(`SCÉNARIO: [comment le match va se dérouler]`);
  lines.push(`ALTERNATIVES: [autres marchés si signal principal risqué]`);
  lines.push(`280 mots max. Direct, précis, zéro langue de bois.`);

  const prompt=lines.join("\n");

  try {
    const resp=await fetch("https://api.mistral.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":`Bearer ${MKEY}`},
      body:JSON.stringify({
        model:"mistral-small-latest",
        max_tokens:800,
        temperature:0.2,
        messages:[
          {role:"user",content:"Tu es EDGE, le moteur d'analyse de paris sportifs le plus précis du marché (Dixon-Coles V13, 90% de précision sur 10 cas réels). Tu analyses comme Sherlock Holmes — chirurgical, direct, basé uniquement sur les données. 18+ parier responsablement. Compris?"},
          {role:"assistant",content:"Compris. EDGE Sherlock Engine prêt. J'analyse chaque match comme une scène de crime — aucun indice ignoré."},
          {role:"user",content:prompt}
        ]
      }),
      signal:AbortSignal.timeout(28000)
    });

    if(!resp.ok){
      const err=await resp.text();
      return res.status(resp.status).json({error:`Mistral ${resp.status}: ${err.substring(0,100)}`});
    }

    const data=await resp.json();
    const text=data.choices?.[0]?.message?.content||"";
    if(!text) return res.status(500).json({error:"Réponse vide"});

    return res.status(200).json({
      text: text.replace(/```[a-z]*/g,"").replace(/```/g,"").trim(),
      model:"mistral-small-latest",
      tokens: data.usage?.total_tokens||0
    });
  } catch(e){
    return res.status(500).json({error:e.message||"Timeout"});
  }
};
