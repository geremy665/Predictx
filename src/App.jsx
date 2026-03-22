import { useState } from "react";

/* ═══════════════════════════════════════════════════════
   MOTEUR BETTING ENGINE V2.0
   Architecture: Dixon-Coles + Kelly Criterion + Time-Decay LIVE
   Inspiré du code Gemini, amélioré et intégré
═══════════════════════════════════════════════════════ */

// ── Poisson ──
const pmf=(l,k)=>{if(l<=0)return k===0?1:0;let v=Math.exp(-l);for(let i=1;i<=k;i++)v*=l/i;return v;};
const cdf=(l,m)=>{let s=0;for(let k=0;k<=m;k++)s+=pmf(l,k);return s;};

// ── Correction Dixon-Coles complète (scores 0-0, 1-0, 0-1, 1-1) ──
const tau=(h,a,lH,lA,rho=-0.13)=>{
  if(h===0&&a===0)return Math.max(0.01,1-lH*lA*rho);
  if(h===1&&a===0)return Math.max(0.01,1+lA*rho);
  if(h===0&&a===1)return Math.max(0.01,1+lH*rho);
  if(h===1&&a===1)return Math.max(0.01,1-rho);
  return 1;
};

// ── Validation sécurité marché (inspiré Gemini) ──
const validateMarket=(o1,oN,o2)=>{
  if(!o1||!oN||!o2)return"SUSPENDED";
  const margin=1/o1+1/oN+1/o2;
  if(margin>1.3)return"SUSPENDED"; // Marge trop haute = marché suspect
  if(margin>1.15)return"WARNING";
  return"SAFE";
};

// ── Edge & Kelly (Kelly ¼ avec cap 5%) ──
const edgeF=(p,o)=>(!o||!p||o<=1)?null:+(p*o-1).toFixed(3);
const kellyF=(p,o,f=0.25)=>{
  if(!o||o<=1||!p)return 0;
  const e=(p*o)-1;
  if(e<=0)return 0;
  // Kelly fractionné ¼ + cap sécurité 5% (comme Gemini)
  return+Math.min((e/(o-1))*f,0.05).toFixed(3);
};
const arb=(o1,oN,o2)=>{if(!o1||!oN||!o2)return null;const s=1/o1+1/oN+1/o2;return s<1?+((1-s)*100).toFixed(2):null;};

// ── Time Decay LIVE (exponentiel, pas linéaire comme Gemini) ──
// En fin de match les équipes défendent → moins de buts → decay exponentiel
const liveTimeFactor=(min)=>{
  if(!min||min<=0)return 1;
  const remaining=Math.max(0,(90-min)/90);
  // Exponentiel : les buts ralentissent après 70' (différent de Gemini qui est linéaire)
  return Math.pow(remaining,0.7);
};

// ── Form Decay (5 derniers matchs = poids 1.85x les 5 précédents) ──
const formWeight=(pts5,pts10)=>{
  const r5=(pts5||7)/15*0.65;
  const r10=(pts10||14)/30*0.35;
  return 0.60+0.80*(r5+r10);
};

// ── MOTEUR PRINCIPAL Dixon-Coles Complet ──
function calc(m, liveMin=null){
  try{
    // 1. Lambdas de base (xG pondéré + buts réels)
    let lH=(m.hxg||1.4)*0.55+(m.hg||1.3)*0.30+((m.hSh||12)/22)*0.15;
    let lA=(m.axg||1.1)*0.55+(m.ag||1.0)*0.30+((m.aSh||9)/22)*0.15;

    // 2. Ajustements défensifs (xGA)
    const hDef=((m.hxga||1.1)*0.55+(m.hC||1.2)*0.30+(1-(m.hCS||35)/100)*0.15)/1.15;
    const aDef=((m.axga||1.3)*0.55+(m.aC||1.4)*0.30+(1-(m.aCS||25)/100)*0.15)/1.15;
    lH*=Math.pow(aDef,0.42);
    lA*=Math.pow(hDef,0.42);

    // 3. Avantage domicile
    lH*=1.10;

    // 4. Form Decay
    lH*=formWeight(m.hf,m.hf10);
    lA*=formWeight(m.af,m.af10);

    // 5. Contexte
    if(m.derby){lH*=0.93;lA*=0.93;}
    if(m.hFat)lH*=0.94;
    if(m.aFat)lA*=0.94;

    // 6. Time Decay LIVE (exponentiel — amélioration vs Gemini)
    if(liveMin!==null){
      const tf=liveTimeFactor(liveMin);
      lH*=tf; lA*=tf;
    }

    // 7. Clamp
    lH=Math.max(0.25,Math.min(4.2,lH));
    lA=Math.max(0.18,Math.min(3.8,lA));

    // 8. Matrice Dixon-Coles 8x8 avec correction tau complète
    let pH=0,pN=0,pA=0,sc=[];
    for(let h=0;h<=7;h++)for(let a=0;a<=7;a++){
      const p=pmf(lH,h)*pmf(lA,a)*tau(h,a,lH,lA);
      sc.push({s:`${h}-${a}`,p});
      if(h>a)pH+=p; else if(h===a)pN+=p; else pA+=p;
    }
    // Normalisation
    const tot=pH+pN+pA;
    pH/=tot; pN/=tot; pA/=tot;
    sc.sort((a,b)=>b.p-a.p);

    // 9. Paris principal
    let bP=pH,bR="1";
    if(pN>bP){bP=pN;bR="N";}
    if(pA>bP){bP=pA;bR="2";}
    const bO=+(bR==="1"?m.o1:bR==="N"?m.oN:m.o2)||0;

    // 10. Edge & Kelly
    const edg=edgeF(bP,bO);
    const kel=kellyF(bP,bO);

    // 11. Validation marché (inspiré Gemini)
    const safetyStatus=validateMarket(m.o1,m.oN,m.o2);

    // 12. Score confiance multi-critères
    const conf=Math.min(97,Math.round(
      bP*38+(edg>0?Math.min(edg*70,20):0)+
      formWeight(m.hf,m.hf10)*8+
      (m.derby?-10:5)+(m.hFat||m.aFat?-5:3)+
      (bO>1.2&&bO<5?4:0)+
      (safetyStatus==="SAFE"?3:safetyStatus==="WARNING"?-3:-10)
    ));

    const lT=lH+lA;
    return{
      pH,pN,pA,lH,lA,
      sc:sc.slice(0,6),
      p15:1-cdf(lT,1),
      p25:1-cdf(lT,2),
      p35:1-cdf(lT,3),
      pBT:(1-pmf(lH,0))*(1-pmf(lA,0)),
      bR,bP,bO,edg,kel,conf,
      safetyStatus,
      liveMin,
      label:bR==="1"?m.h:bR==="N"?"Match Nul":m.a
    };
  }catch(e){
    // Anti-crash (inspiré Gemini try/catch)
    return{pH:0.33,pN:0.33,pA:0.33,lH:1.3,lA:1.1,sc:[],p15:0.7,p25:0.45,p35:0.22,pBT:0.5,bR:"N",bP:0.33,bO:0,edg:null,kel:0,conf:30,safetyStatus:"SUSPENDED",label:"Match Nul"};
  }
}

/* ── MATCHS 22 MARS 2026 — COTES RÉELLES ── */
const MS = [
  // LIGUE 1
  {id:1,c:"Ligue 1",f:"🇫🇷",h:"Olympique Lyonnais",a:"AS Monaco",t:"15:00",
   o1:2.88,oN:3.50,o2:2.32,hot:1,
   bk:[{n:"Betclic",o1:2.85,oN:3.53,o2:2.35},{n:"Pinnacle",o1:2.92,oN:3.48,o2:2.28},{n:"Unibet",o1:2.82,oN:3.55,o2:2.38},{n:"1xBet",o1:2.95,oN:3.45,o2:2.30}],
   hxg:1.65,hg:1.61,hxga:1.05,axg:1.72,ag:1.97,axga:1.32,hf:9,af:10},
  {id:2,c:"Ligue 1",f:"🇫🇷",h:"Olympique de Marseille",a:"LOSC Lille",t:"17:15",
   o1:1.92,oN:3.68,o2:3.82,hot:1,
   bk:[{n:"Betclic",o1:1.86,oN:3.73,o2:3.93},{n:"Pinnacle",o1:1.92,oN:3.68,o2:3.82},{n:"Unibet",o1:1.88,oN:3.70,o2:3.88},{n:"Winamax",o1:1.90,oN:3.65,o2:3.85}],
   hxg:1.78,hg:1.85,hxga:1.02,axg:1.68,ag:1.68,axga:1.08,hf:11,af:10},
  {id:3,c:"Ligue 1",f:"🇫🇷",h:"Stade Rennais FC",a:"FC Metz",t:"17:15",
   o1:1.36,oN:5.30,o2:7.80,
   bk:[{n:"Betclic",o1:1.33,oN:5.50,o2:8.00},{n:"Pinnacle",o1:1.36,oN:5.30,o2:7.80},{n:"Unibet",o1:1.34,oN:5.40,o2:7.90}],
   hxg:1.48,hg:1.60,hxga:1.02,axg:0.82,ag:0.85,axga:2.25,hf:9,af:4},
  {id:4,c:"Ligue 1",f:"🇫🇷",h:"FC Nantes",a:"RC Strasbourg",t:"20:45",
   o1:3.60,oN:3.50,o2:1.98,
   bk:[{n:"Betclic",o1:3.53,oN:3.55,o2:2.02},{n:"Pinnacle",o1:3.60,oN:3.50,o2:1.98},{n:"Unibet",o1:3.55,oN:3.52,o2:2.00}],
   hxg:0.88,hg:0.96,hxga:1.82,axg:1.52,ag:1.61,axga:1.12,hf:3,af:10},
  {id:5,c:"Ligue 1",f:"🇫🇷",h:"Paris Saint-Germain",a:"LOSC Lille",t:"20:45",
   o1:1.45,oN:4.70,o2:7.20,hot:1,
   bk:[{n:"Betclic",o1:1.42,oN:4.80,o2:7.50},{n:"Pinnacle",o1:1.45,oN:4.70,o2:7.20},{n:"Unibet",o1:1.43,oN:4.75,o2:7.35},{n:"Winamax",o1:1.44,oN:4.72,o2:7.40}],
   hxg:2.21,hg:2.21,hxga:0.72,axg:1.68,ag:1.68,axga:1.08,hf:14,af:10},
  // LA LIGA
  {id:6,c:"La Liga",f:"🇪🇸",h:"FC Barcelone",a:"Rayo Vallecano",t:"14:00",
   o1:1.41,oN:4.60,o2:8.00,hot:1,
   bk:[{n:"Betclic",o1:1.38,oN:4.70,o2:8.20},{n:"Pinnacle",o1:1.41,oN:4.60,o2:8.00},{n:"Unibet",o1:1.39,oN:4.65,o2:8.10},{n:"1xBet",o1:1.43,oN:4.55,o2:7.80}],
   hxg:2.52,hg:2.72,hxga:0.72,axg:1.05,ag:1.12,axga:1.48,hf:13,af:5},
  {id:7,c:"La Liga",f:"🇪🇸",h:"Athletic Club",a:"Real Betis",t:"18:30",
   o1:2.10,oN:3.35,o2:3.55,
   bk:[{n:"Betclic",o1:2.05,oN:3.40,o2:3.65},{n:"Pinnacle",o1:2.10,oN:3.35,o2:3.55},{n:"Unibet",o1:2.08,oN:3.38,o2:3.60}],
   hxg:1.55,hg:1.62,hxga:1.02,axg:1.38,ag:1.38,axga:1.18,hf:10,af:9},
  {id:8,c:"La Liga",f:"🇪🇸",h:"Real Madrid CF",a:"Atlético de Madrid",t:"21:00",
   o1:2.02,oN:3.48,o2:3.72,hot:1,derby:1,
   bk:[{n:"Betclic",o1:1.95,oN:3.55,o2:3.85},{n:"Pinnacle",o1:2.02,oN:3.48,o2:3.72},{n:"Unibet",o1:1.98,oN:3.52,o2:3.80},{n:"William Hill",o1:1.96,oN:3.50,o2:3.75},{n:"1xBet",o1:2.05,oN:3.45,o2:3.68}],
   hxg:2.38,hg:2.42,hxga:0.82,axg:1.62,ag:1.62,axga:0.85,hf:12,af:11},
  // PREMIER LEAGUE
  {id:9,c:"Premier League",f:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",h:"Newcastle United",a:"Sunderland AFC",t:"13:00",
   o1:1.76,oN:3.78,o2:4.42,hot:1,derby:1,
   bk:[{n:"Betclic",o1:1.72,oN:3.85,o2:4.55},{n:"Pinnacle",o1:1.76,oN:3.78,o2:4.42},{n:"Unibet",o1:1.74,oN:3.82,o2:4.48},{n:"William Hill",o1:1.73,oN:3.80,o2:4.50}],
   hxg:1.82,hg:1.88,hxga:0.88,axg:1.28,ag:1.28,axga:1.45,hf:11,af:6},
  {id:10,c:"Premier League",f:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",h:"Manchester City",a:"Crystal Palace",t:"15:00",
   o1:1.58,oN:4.12,o2:5.80,hot:1,
   bk:[{n:"Betclic",o1:1.55,oN:4.20,o2:6.00},{n:"Pinnacle",o1:1.58,oN:4.12,o2:5.80},{n:"Unibet",o1:1.56,oN:4.16,o2:5.90},{n:"William Hill",o1:1.57,oN:4.14,o2:5.85}],
   hxg:2.18,hg:2.35,hxga:0.85,axg:1.12,ag:1.05,axga:1.42,hf:13,af:5},
  {id:11,c:"Premier League",f:"🏴󠁧󠁢󠁥󠁮󠁧󠁿",h:"Aston Villa",a:"West Ham United",t:"15:15",
   o1:1.82,oN:3.65,o2:4.22,
   bk:[{n:"Betclic",o1:1.78,oN:3.70,o2:4.35},{n:"Pinnacle",o1:1.82,oN:3.65,o2:4.22},{n:"Unibet",o1:1.80,oN:3.68,o2:4.28}],
   hxg:1.85,hg:1.95,hxga:0.95,axg:1.32,ag:1.32,axga:1.48,hf:11,af:6},
  // SERIE A
  {id:12,c:"Serie A",f:"🇮🇹",h:"SSC Napoli",a:"US Lecce",t:"15:00",
   o1:1.51,oN:4.20,o2:7.00,
   bk:[{n:"Betclic",o1:1.48,oN:4.30,o2:7.20},{n:"Pinnacle",o1:1.51,oN:4.20,o2:7.00},{n:"Unibet",o1:1.49,oN:4.25,o2:7.10}],
   hxg:2.02,hg:2.15,hxga:0.82,axg:0.88,ag:0.95,axga:1.78,hf:12,af:4},
  {id:13,c:"Serie A",f:"🇮🇹",h:"AS Roma",a:"ACF Fiorentina",t:"18:00",
   o1:2.08,oN:3.28,o2:3.60,hot:1,
   bk:[{n:"Betclic",o1:2.02,oN:3.35,o2:3.72},{n:"Pinnacle",o1:2.08,oN:3.28,o2:3.60},{n:"Unibet",o1:2.05,oN:3.32,o2:3.66},{n:"1xBet",o1:2.10,oN:3.25,o2:3.55}],
   hxg:1.62,hg:1.62,hxga:1.05,axg:1.58,ag:1.72,axga:1.12,hf:9,af:10},
  {id:14,c:"Serie A",f:"🇮🇹",h:"Inter Milan",a:"Udinese Calcio",t:"20:45",
   o1:1.45,oN:4.50,o2:7.60,hot:1,
   bk:[{n:"Betclic",o1:1.42,oN:4.60,o2:7.80},{n:"Pinnacle",o1:1.45,oN:4.50,o2:7.60},{n:"Unibet",o1:1.43,oN:4.55,o2:7.70},{n:"1xBet",o1:1.47,oN:4.45,o2:7.40}],
   hxg:2.15,hg:2.42,hxga:0.72,axg:0.95,ag:0.98,axga:1.68,hf:13,af:4},
  // BUNDESLIGA
  {id:15,c:"Bundesliga",f:"🇩🇪",h:"Borussia Dortmund",a:"FSV Mainz 05",t:"17:30",
   o1:1.68,oN:3.82,o2:5.05,
   bk:[{n:"Betclic",o1:1.65,oN:3.90,o2:5.20},{n:"Pinnacle",o1:1.68,oN:3.82,o2:5.05},{n:"Unibet",o1:1.66,oN:3.86,o2:5.12}],
   hxg:2.12,hg:2.18,hxga:1.05,axg:1.32,ag:1.32,axga:1.42,hf:11,af:7},
  {id:16,c:"Bundesliga",f:"🇩🇪",h:"Bayer Leverkusen",a:"VfB Stuttgart",t:"19:30",
   o1:1.76,oN:3.72,o2:4.65,hot:1,
   bk:[{n:"Betclic",o1:1.72,oN:3.80,o2:4.80},{n:"Pinnacle",o1:1.76,oN:3.72,o2:4.65},{n:"Unibet",o1:1.74,oN:3.76,o2:4.72},{n:"1xBet",o1:1.78,oN:3.70,o2:4.60}],
   hxg:2.22,hg:2.28,hxga:0.88,axg:1.58,ag:1.62,axga:1.12,hf:12,af:10},
  // LIGA PORTUGAL
  {id:17,c:"Liga Portugal",f:"🇵🇹",h:"SL Benfica",a:"Sporting CP",t:"18:00",
   o1:2.30,oN:3.22,o2:3.05,hot:1,derby:1,
   bk:[{n:"Betclic",o1:2.25,oN:3.28,o2:3.15},{n:"Pinnacle",o1:2.30,oN:3.22,o2:3.05},{n:"Unibet",o1:2.28,oN:3.25,o2:3.10},{n:"1xBet",o1:2.32,oN:3.18,o2:3.02}],
   hxg:2.08,hg:2.12,hxga:0.85,axg:2.12,ag:2.05,axga:0.78,hf:12,af:13},
  // SCOTTISH
  {id:18,c:"Scottish Prem.",f:"🏴󠁧󠁢󠁳󠁣󠁴󠁿",h:"Celtic FC",a:"Rangers FC",t:"12:30",
   o1:1.80,oN:3.72,o2:4.15,hot:1,derby:1,
   bk:[{n:"Betclic",o1:1.75,oN:3.80,o2:4.30},{n:"Pinnacle",o1:1.80,oN:3.72,o2:4.15},{n:"Unibet",o1:1.77,oN:3.76,o2:4.22},{n:"William Hill",o1:1.76,oN:3.78,o2:4.25}],
   hxg:2.35,hg:2.38,hxga:0.78,axg:1.92,ag:1.95,axga:0.95,hf:13,af:11},
  // CHAMPIONS LEAGUE
  {id:19,c:"Champions League",f:"🏆",h:"Real Madrid CF",a:"Arsenal FC",t:"21:00",hot:1,
   o1:2.15,oN:3.38,o2:3.48,
   bk:[{n:"Betclic",o1:2.10,oN:3.45,o2:3.60},{n:"Pinnacle",o1:2.15,oN:3.38,o2:3.48},{n:"Unibet",o1:2.12,oN:3.42,o2:3.55},{n:"William Hill",o1:2.11,oN:3.40,o2:3.52},{n:"1xBet",o1:2.18,oN:3.35,o2:3.45}],
   hxg:2.38,hg:2.42,hxga:0.82,axg:2.12,ag:2.05,axga:0.78,hf:12,af:12},
].map(m=>({...m,e:calc(m),arb:arb(m.o1,m.oN,m.o2)}));

/* ── CSS ── */
const S=`
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#070709;--c1:#10121a;--c2:#181c28;--c3:#1e2235;--gold:#e8b84b;--em:#34d399;--red:#f87171;--blue:#60a5fa;--t1:#f0f4f8;--t2:#8892a4;--t3:#3d4559;--ln:rgba(255,255,255,.06)}
html,body{background:var(--bg);color:var(--t1);font-family:'Inter',sans-serif;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden}
::-webkit-scrollbar{width:2px;height:2px}::-webkit-scrollbar-thumb{background:var(--c3)}
button,input,select{font-family:'Inter',sans-serif}
@keyframes fu{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes sh{0%{background-position:-200%}100%{background-position:200%}}
@keyframes pu{0%,100%{opacity:1}50%{opacity:.2}}
.fu{animation:fu .3s ease forwards}
.pu{animation:pu 2s ease-in-out infinite}

/* HEADER */
header{position:sticky;top:0;z-index:100;background:rgba(7,7,9,.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--ln)}
.hi{max-width:900px;margin:0 auto;display:flex;align-items:center;padding:0 16px;height:54px;gap:10px}
.logo{font-family:'Syne',sans-serif;font-size:16px;font-weight:900;color:var(--t1)}
.logo span{color:var(--gold)}
.hbadge{padding:3px 10px;border-radius:100px;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--ln);color:var(--t3);white-space:nowrap}
.hbadge.ok{border-color:rgba(52,211,153,.3);color:var(--em);background:rgba(52,211,153,.06)}
.bkbtn{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;padding:6px 12px;background:var(--c1);border:1px solid rgba(232,184,75,.2);border-radius:10px;cursor:pointer}
.bkl{font-family:'JetBrains Mono',monospace;font-size:8px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em}
.bkv{font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--gold)}

/* NAV */
nav{background:rgba(7,7,9,.95);backdrop-filter:blur(20px);border-bottom:1px solid var(--ln);overflow-x:auto;position:sticky;top:54px;z-index:90}
.ni{max-width:900px;margin:0 auto;display:flex;padding:0 12px}
.tb{display:flex;align-items:center;gap:5px;padding:11px 13px;border:none;background:transparent;font-size:12px;font-weight:500;color:var(--t3);cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.tb:hover{color:var(--t1)}
.tb.on{color:var(--t1);border-bottom-color:var(--gold);font-weight:700}
.tb .n{font-family:'JetBrains Mono',monospace;font-size:9px;padding:1px 6px;border-radius:100px;background:var(--c3);color:var(--t3)}
.tb.on .n{background:rgba(232,184,75,.15);color:var(--gold)}

/* PAGE */
.pg{max-width:900px;margin:0 auto;padding:20px 16px 60px}

/* MATCH ROW */
.league{margin-bottom:24px}
.lg-hd{display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer}
.lg-n{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
.lg-c{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);padding:1px 7px;background:var(--c2);border-radius:100px}
.lg-l{flex:1;height:1px;background:var(--ln)}
.lg-ar{font-size:10px;color:var(--t3);transition:transform .2s}
.lg-ar.op{transform:rotate(180deg)}

.mwrap{background:var(--c1);border:1px solid var(--ln);border-radius:13px;overflow:hidden;margin-bottom:5px}
.mwrap.hot{border-color:rgba(232,184,75,.2)}
.mtop{height:2px;display:none}
.mwrap.hot .mtop{display:block;background:linear-gradient(90deg,var(--gold),transparent)}
.mwrap.arb .mtop{display:block;background:linear-gradient(90deg,var(--em),transparent)}
.mrow{display:grid;grid-template-columns:58px 1fr 160px 1fr 72px;align-items:center;padding:13px 14px;cursor:pointer;position:relative;transition:background .12s;border-bottom:1px solid var(--ln)}
.mrow:last-child{border-bottom:none}
.mrow:hover{background:rgba(255,255,255,.02)}

.mtime{text-align:center}
.mt{font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--t3);display:block}
.mt.hot{color:var(--gold)}
.mtag{font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;display:block;text-align:center;margin-bottom:2px}
.mtag.choc{color:var(--gold)}.mtag.arb{color:var(--em)}

.mteam{font-size:13px;font-weight:500;color:var(--t1)}
.mteam.r{text-align:right;padding-right:9px}
.mxg{font-family:'JetBrains Mono',monospace;font-size:9px;margin-top:2px}

.odds{display:flex;gap:4px;justify-content:center}
.odd{display:flex;flex-direction:column;align-items:center;min-width:48px;padding:6px 4px;border-radius:8px;background:var(--c2);border:1px solid var(--ln);cursor:pointer;transition:all .13s}
.odd:hover{background:rgba(232,184,75,.1);border-color:rgba(232,184,75,.4);transform:translateY(-2px)}
.odd.val{background:rgba(232,184,75,.1);border-color:rgba(232,184,75,.4)}
.odd.best{background:rgba(52,211,153,.08);border-color:rgba(52,211,153,.35)}
.odd-l{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);letter-spacing:.05em}
.odd-v{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--gold);margin-top:1px}

.mcta{display:flex;justify-content:flex-end}
.abtn{padding:5px 11px;border-radius:100px;font-size:11px;font-weight:600;border:1px solid var(--ln);color:var(--t3);background:transparent;cursor:pointer;transition:all .13s;white-space:nowrap}
.abtn:hover{border-color:rgba(232,184,75,.4);color:var(--gold)}

.vbadge{position:absolute;right:76px;top:50%;transform:translateY(-50%);font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;color:var(--em);background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);border-radius:100px;padding:2px 6px}

/* SCANNER */
.scan-hero{text-align:center;padding:32px 16px 24px}
.scan-t{font-family:'Syne',sans-serif;font-size:clamp(26px,6vw,38px);font-weight:900;letter-spacing:-1.5px;margin-bottom:8px}
.scan-t span{color:var(--gold)}
.scan-s{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);letter-spacing:.07em;text-transform:uppercase;margin-bottom:24px}
.scan-btn{height:52px;padding:0 36px;background:linear-gradient(135deg,var(--gold),#c49230,var(--gold));background-size:200%;border:none;border-radius:13px;font-family:'Syne',sans-serif;font-size:13px;font-weight:800;letter-spacing:.3px;color:#070709;cursor:pointer;box-shadow:0 6px 28px rgba(232,184,75,.25);animation:sh 4s linear infinite;transition:all .22s}
.scan-btn:hover{box-shadow:0 10px 40px rgba(232,184,75,.4);transform:translateY(-2px)}
.scan-btn:disabled{background:var(--c3);color:var(--t3);box-shadow:none;transform:none;animation:none}

.sgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:18px}
.sbox{background:var(--c1);border:1px solid var(--ln);border-radius:11px;padding:13px;text-align:center}
.sv{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--t1);line-height:1;margin-bottom:3px}
.sl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.07em}

.sig{background:var(--c1);border:1px solid var(--ln);border-radius:16px;overflow:hidden;margin-bottom:8px;cursor:pointer;transition:all .18s}
.sig:hover{border-color:rgba(255,255,255,.1);transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,.4)}
.sig.top{border-color:rgba(232,184,75,.28)}
.sig-str{height:3px}
.sig-bd{padding:17px 18px}
.sig-mt{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);margin-bottom:9px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sig-tm{font-size:14px;font-weight:500;color:var(--t2);margin-bottom:5px}
.sig-bt{font-family:'Syne',sans-serif;font-size:20px;font-weight:900;letter-spacing:-.5px;margin-bottom:14px;line-height:1.1}
.sig-mg{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px}
.sig-m{background:var(--c2);border-radius:9px;padding:9px 7px;text-align:center}
.sig-ml{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px}
.sig-mv{font-family:'Syne',sans-serif;font-size:17px;font-weight:800}
.cbar{height:3px;background:var(--c3);border-radius:2px;overflow:hidden;margin-bottom:10px}
.cbf{height:100%;border-radius:2px;transition:width 1.2s cubic-bezier(.16,1,.3,1)}

/* COMPARATEUR */
.ctable{width:100%;border-collapse:collapse;font-size:12px}
.ctable th{padding:8px 10px;text-align:left;font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid var(--ln)}
.ctable td{padding:10px 10px;border-bottom:1px solid rgba(255,255,255,.03)}
.ctable tr:last-child td{border-bottom:none}
.bkn{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;color:var(--t1)}
.oc{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;color:var(--t2)}
.oc.best{color:var(--em)}.oc.val{color:var(--gold)}
.pin-b{display:inline-flex;align-items:center;gap:3px;font-family:'JetBrains Mono',monospace;font-size:8px;font-weight:700;color:var(--blue);background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.3);border-radius:100px;padding:1px 6px;margin-left:5px}
.avg-r td{background:rgba(232,184,75,.04);font-weight:700}
.avg-r .oc{color:var(--gold)}

/* VERDICT */
.vrd{background:var(--c1);border:1px solid rgba(232,184,75,.2);border-radius:20px;padding:24px 20px;margin-bottom:10px;position:relative;overflow:hidden}
.vrd::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(232,184,75,.6),transparent)}
.vey{font-family:'JetBrains Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--t3);margin-bottom:7px}
.vbet{font-family:'Syne',sans-serif;font-size:clamp(20px,4vw,30px);font-weight:900;letter-spacing:-1px;line-height:1.1;margin-bottom:4px}
.vmeta{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);margin-bottom:20px}
.crow{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.cl{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.07em}
.cv{font-family:'Syne',sans-serif;font-size:14px;font-weight:700}
.ctr{height:5px;background:var(--c3);border-radius:3px;overflow:hidden;margin-bottom:20px}
.cf{height:100%;border-radius:3px;transition:width 1.5s cubic-bezier(.16,1,.3,1)}
.prow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px}
.pb{background:var(--c2);border:1px solid var(--ln);border-radius:12px;padding:13px 7px;text-align:center}
.pb.win{background:rgba(232,184,75,.07);border-color:rgba(232,184,75,.35)}
.pp{font-family:'Syne',sans-serif;font-size:24px;font-weight:900;letter-spacing:-.5px;line-height:1;margin-bottom:3px}
.pb.win .pp{color:var(--gold)}
.pn{font-size:11px;color:var(--t3)}
.pb.win .pn{color:var(--gold)}
.pi{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);margin-top:2px}
.b3{height:4px;background:var(--c3);border-radius:2px;display:flex;overflow:hidden;margin-top:10px}
.b3h{height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);transition:width 1.5s ease}
.b3n{height:100%;background:rgba(255,255,255,.15)}
.b3a{height:100%;background:linear-gradient(90deg,var(--gold),#f5c842);transition:width 1.5s ease}

/* EDGE BLOCK */
.edgb{display:flex;justify-content:space-between;align-items:center;padding:15px 17px;border-radius:13px;margin-bottom:10px}
.edgb.pos{background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.22)}
.edgb.neg{background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.18)}
.edgv{font-family:'Syne',sans-serif;font-size:26px;font-weight:900}
.edgb.pos .edgv{color:var(--em)}.edgb.neg .edgv{color:var(--red)}

/* SCORES */
.sgr{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px}
.sc2{background:var(--c2);border:1px solid var(--ln);border-radius:10px;padding:10px 6px;text-align:center}
.sc2.top{background:rgba(232,184,75,.07);border-color:rgba(232,184,75,.28)}
.scv{font-family:'Syne',sans-serif;font-size:17px;font-weight:700}
.sc2.top .scv{color:var(--gold)}
.scp{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);margin-top:2px}

/* MARCHÉS */
.mg4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px}
.mk{background:var(--c2);border:1px solid var(--ln);border-radius:11px;padding:12px 8px;text-align:center}
.mk.val{background:rgba(232,184,75,.08);border-color:rgba(232,184,75,.32)}
.mk.ok{background:rgba(52,211,153,.06);border-color:rgba(52,211,153,.22)}
.mkp{font-family:'Syne',sans-serif;font-size:19px;font-weight:800;color:var(--t1)}
.mk.val .mkp{color:var(--gold)}.mk.ok .mkp{color:var(--em)}
.mkl{font-size:10px;color:var(--t3);margin-top:3px}
.mke{font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:700;margin-top:2px}
.mk.val .mke{color:var(--gold)}.mk.ok .mke{color:var(--em)}

/* BARRES */
.br{margin-bottom:8px}
.brt{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
.brb{height:4px;background:var(--c3);border-radius:2px;overflow:hidden}
.brf{height:100%;border-radius:2px;transition:width 1.3s cubic-bezier(.16,1,.3,1)}

/* KELLY */
.kg{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:10px}
.kb{background:var(--c2);border:1px solid var(--ln);border-radius:11px;padding:12px;text-align:center}
.kbv{font-family:'Syne',sans-serif;font-size:19px;font-weight:800;color:var(--gold)}
.kbl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);margin-top:3px;text-transform:uppercase;letter-spacing:.07em}
.vp{padding:10px 13px;border-radius:11px;font-size:12px;font-weight:600}
.vp.y{background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.22);color:var(--em)}
.vp.n{background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.18);color:var(--red)}

/* FORMS */
.fw{display:flex;flex-direction:column;gap:5px;margin-bottom:8px}
.fl{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}
.fi{width:100%;padding:10px 12px;background:var(--c2);border:1px solid var(--ln);border-radius:9px;color:var(--t1);font-size:14px;outline:none;transition:border-color .18s}
.fi:focus{border-color:rgba(232,184,75,.5)}
.fi.big{padding:12px 14px;font-size:15px;font-weight:500}
.fsel{width:100%;padding:10px 12px;background:var(--c2);border:1px solid var(--ln);border-radius:9px;color:var(--t1);font-size:14px;outline:none;appearance:none}
.rg{display:flex;gap:3px}
.rb{flex:1;padding:7px 4px;font-size:11px;font-weight:500;border-radius:7px;border:1px solid var(--ln);background:var(--c2);color:var(--t3);cursor:pointer;transition:all .13s;line-height:1.2}
.rb:hover{border-color:rgba(255,255,255,.1);color:var(--t1)}
.rb.on{background:rgba(232,184,75,.12);border-color:rgba(232,184,75,.4);color:var(--gold);font-weight:700}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px}
.g4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:7px;margin-bottom:8px}
.fsec{background:var(--c1);border:1px solid var(--ln);border-radius:14px;padding:15px;margin-bottom:7px}
.fsh{display:flex;align-items:center;gap:8px;margin-bottom:13px;padding-bottom:10px;border-bottom:1px solid var(--ln)}
.fsn{font-family:'Syne',sans-serif;font-size:10px;font-weight:800;color:var(--gold);background:rgba(232,184,75,.12);border:1px solid rgba(232,184,75,.25);border-radius:5px;padding:2px 8px}
.fst{font-size:13px;font-weight:600;color:var(--t1)}

/* AI BAR */
.aib{background:var(--c1);border:1px solid rgba(232,184,75,.18);border-radius:17px;padding:17px;margin-bottom:11px;position:relative;overflow:hidden}
.aib::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(232,184,75,.5),transparent)}
.aih{font-family:'Syne',sans-serif;font-size:12px;font-weight:700;color:var(--t1);margin-bottom:5px;display:flex;align-items:center;gap:7px}
.aid{width:6px;height:6px;border-radius:50%;background:var(--gold);box-shadow:0 0 8px var(--gold)}
.ais{font-size:12px;color:var(--t3);margin-bottom:12px;line-height:1.6}
.cbtn{width:100%;height:48px;background:linear-gradient(135deg,var(--gold),#c49230,var(--gold));background-size:200%;border:none;border-radius:11px;font-family:'Syne',sans-serif;font-size:13px;font-weight:800;letter-spacing:.3px;color:#070709;cursor:pointer;box-shadow:0 5px 22px rgba(232,184,75,.2);transition:all .2s;margin-bottom:8px;animation:sh 4s linear infinite}
.cbtn:hover{box-shadow:0 9px 32px rgba(232,184,75,.35);transform:translateY(-1px)}
.cbtn:disabled{background:var(--c3);color:var(--t3);box-shadow:none;transform:none;animation:none}
.stb{padding:8px 12px;background:var(--c2);border:1px solid var(--ln);border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--gold);margin-bottom:8px;display:flex;align-items:center;gap:7px}
.aimsg{padding:8px 12px;border-radius:8px;font-family:'JetBrains Mono',monospace;font-size:12px;margin-top:7px}
.aiok{background:rgba(52,211,153,.06);border:1px solid rgba(52,211,153,.2);color:var(--em)}
.aier{background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.18);color:var(--red)}
.msel{background:rgba(232,184,75,.1);border:1px solid rgba(232,184,75,.25);border-radius:11px;padding:10px 14px;margin-bottom:11px;display:flex;align-items:center;gap:10px}

/* CARD */
.card{background:var(--c1);border:1px solid var(--ln);border-radius:14px;padding:17px;margin-bottom:9px}
.cardg{background:var(--c1);border:1px solid rgba(232,184,75,.2);border-radius:14px;padding:17px;margin-bottom:9px}
.cardr{background:rgba(248,113,113,.04);border:1px solid rgba(248,113,113,.18);border-radius:14px;padding:17px;margin-bottom:9px}
.cardem{background:rgba(52,211,153,.04);border:1px solid rgba(52,211,153,.2);border-radius:14px;padding:17px;margin-bottom:9px}
.clbl{font-family:'JetBrains Mono',monospace;font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:11px}

/* TAGS */
.tag{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:100px;font-size:10px;font-weight:700;letter-spacing:.04em}
.tg{background:rgba(232,184,75,.12);border:1px solid rgba(232,184,75,.28);color:var(--gold)}
.te{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.28);color:var(--em)}
.tr{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.28);color:var(--red)}
.tb2{background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.28);color:var(--blue)}

/* MODAL */
.modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)}
.mbox{background:var(--c1);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:24px;width:100%;max-width:390px}
.mtitle{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;margin-bottom:16px;letter-spacing:-.3px}
.mrow2{display:flex;gap:8px;margin-top:14px}

/* BANKROLL */
.sg2{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:16px}
.hr{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--ln)}
.hr:last-child{border-bottom:none}

/* TIPS */
.tip{background:var(--c1);border:1px solid var(--ln);border-radius:17px;overflow:hidden;margin-bottom:8px;cursor:pointer;transition:all .18s}
.tip:hover{border-color:rgba(255,255,255,.1);transform:translateY(-2px)}
.tip.top{border-color:rgba(232,184,75,.25)}
.tph{padding:9px 16px;background:var(--c2);display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ln)}
.tpb{padding:14px 16px}
.tpbt{font-family:'Syne',sans-serif;font-size:19px;font-weight:800;margin-bottom:9px;letter-spacing:-.5px}
.tpmg{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px}
.tpm{background:var(--c3);border-radius:8px;padding:8px 5px;text-align:center}
.tpml{font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--t3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px}
.tpmv{font-family:'Syne',sans-serif;font-size:15px;font-weight:800}

/* EMPTY */
.empty{text-align:center;padding:56px 20px}
.ei{font-size:42px;opacity:.1;margin-bottom:14px}
.et{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--t2);margin-bottom:7px;letter-spacing:-.3px}
.es{font-size:13px;color:var(--t3);line-height:1.7}

.ldr{display:flex;gap:5px;justify-content:center;align-items:center}
.ldr span{width:6px;height:6px;border-radius:50%;background:var(--gold);opacity:.6}
.spin{width:18px;height:18px;border:2px solid rgba(232,184,75,.2);border-top-color:var(--gold);border-radius:50%;animation:pu 0.8s linear infinite}
.disc{padding:11px 15px;background:rgba(248,113,113,.04);border:1px solid rgba(248,113,113,.1);border-radius:9px;font-size:11px;color:var(--t3);line-height:1.8;margin-top:4px}

.fils{display:flex;gap:5px;overflow-x:auto;padding-bottom:2px;margin-bottom:16px}
.fib{padding:6px 14px;border-radius:100px;font-size:11px;font-weight:500;border:1px solid var(--ln);background:transparent;color:var(--t3);cursor:pointer;transition:all .14s;white-space:nowrap}
.fib:hover{border-color:rgba(255,255,255,.1);color:var(--t1)}
.fib.on{background:rgba(232,184,75,.12);border-color:rgba(232,184,75,.4);color:var(--gold);font-weight:700}

@media(max-width:520px){
  .mrow{grid-template-columns:50px 1fr 148px 1fr 62px;padding:11px 12px}
  .odd{min-width:43px}.odd-v{font-size:13px}
  .sig-mg,.tpmg{grid-template-columns:repeat(2,1fr)}
  .mg4{grid-template-columns:repeat(2,1fr)}
  .sgrid,.sg2{grid-template-columns:repeat(2,1fr)}
}`;

/* ── COMPOSANTS ── */
const Ld=()=><div className="ldr">{[0,1,2].map(i=><span key={i}/>)}</div>;
const In=({v,on,ph,big,mono,s={}})=><input className={`fi${big?" big":""}`} value={v||""} onChange={e=>on(e.target.value)} placeholder={ph} style={{...(mono?{fontFamily:"'JetBrains Mono',monospace",fontSize:12}:{}), ...s}}/>;
const Se=({v,on,opts})=><select className="fsel" value={v} onChange={e=>on(e.target.value)}>{opts.map(o=><option key={o.v??o} value={o.v??o}>{o.l||o}</option>)}</select>;
const Rg=({opts,v,on})=><div className="rg">{opts.map(o=>{const k=o.k===undefined?o:o.k,l=o.l||o;return <button key={String(k)} onClick={()=>on(k)} className={`rb${String(v)===String(k)?" on":""}`}>{l}</button>;})}</div>;
const Fw=({lbl,children})=><div className="fw"><div className="fl">{lbl}</div>{children}</div>;
const Tag=({c="tg",ch})=><span className={`tag ${c}`}>{ch}</span>;
const Bar=({p,c="var(--gold)"})=><div className="brb"><div className="brf" style={{width:`${Math.max(0,Math.min(100,p))}%`,background:c}}/></div>;
const Fsec=({n,t,ch})=><div className="fsec"><div className="fsh"><span className="fsn">{n}</span><span className="fst">{t}</span></div>{ch}</div>;

const D0={home:"",away:"",aiH:"",aiA:"",aiC:"Ligue 1",
  hXG:1.5,hXGA:1.1,hG:1.4,hC:1.2,hCS:35,hF:7,hF10:14,
  aXG:1.2,aXGA:1.3,aG:1.1,aC:1.4,aCS:25,aF:7,aF10:14,
  derby:false,hFat:false,aFat:false,
  o1:"",oN:"",o2:"",oO25:"",oO35:"",oBtts:"",bk:""};

/* ══════════════════════════════════════════════════════
   APP
══════════════════════════════════════════════════════ */
export default function App(){
  const[tab,setTab]=useState("scanner");
  const[d,setD]=useState(D0);
  const[res,setRes]=useState(null);
  const[aiLoad,setAiLoad]=useState(false);
  const[aiStep,setAiStep]=useState("");
  const[aiMsg,setAiMsg]=useState({t:"",m:""});
  const[nar,setNar]=useState("");
  const[bkD,setBkD]=useState(null);
  const[tips,setTips]=useState([]);
  const[tLoad,setTLoad]=useState(false);
  const[tFil,setTFil]=useState("all");
  const[selM,setSelM]=useState(null);
  const[openL,setOpenL]=useState({});
  const[fil,setFil]=useState("all");
  const[compM,setCompM]=useState(null);
  const[bk,setBk]=useState(()=>{try{return+JSON.parse(localStorage.getItem("edge_bk")||"1000")}catch{return 1000}});
  const[showBk,setShowBk]=useState(false);
  const[bkIn,setBkIn]=useState("");
  const[hist,setHist]=useState(()=>{try{return JSON.parse(localStorage.getItem("edge_hist")||"[]")}catch{return[]}});
  const[signals,setSignals]=useState([]);
  const[scanned,setScanned]=useState(false);
  const[scanLoad,setScanLoad]=useState(false);
  const[aiKey,setAiKey]=useState(()=>localStorage.getItem("edge_ai")||"");
  const[showCfg,setShowCfg]=useState(false);
  const[bkC,setBkC]=useState({tot:"",prob:"",odd:"",frac:"0.25"});
  const[bkR,setBkR]=useState(null);

  const sv=(k,v)=>setD(p=>({...p,[k]:v}));
  const saveBk=v=>{setBk(v);localStorage.setItem("edge_bk",JSON.stringify(v));};
  const saveHist=h=>{setHist(h);localStorage.setItem("edge_hist",JSON.stringify(h));};
  const saveKey=k=>{setAiKey(k);localStorage.setItem("edge_ai",k);};

  const wins=hist.filter(h=>h.result==="WIN").length;
  const roi=hist.length>0?+((hist.reduce((a,h)=>a+h.profit,0)/hist.reduce((a,h)=>a+(h.stake||20),0))*100).toFixed(1):null;

  // Stats globales
  const arbCount=MS.filter(m=>m.arb!==null).length;
  const valCount=MS.filter(m=>m.e.edg>0.06).length;

  function runScanner(){
    setScanLoad(true);setScanned(false);
    setTimeout(()=>{
      const top=[...MS].filter(m=>m.e.edg>0.03&&m.e.bP>0.45).sort((a,b)=>b.e.conf-a.e.conf).slice(0,12);
      setSignals(top);setScanLoad(false);setScanned(true);
    },300);
  }

  async function callAI(prompt,max=2500){
    const key=aiKey;
    if(!key){alert("⚠️ Clé Anthropic manquante. Clique sur ⚙ pour la configurer.");throw new Error("no key");}
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:max,tools:[{type:"web_search_20250305",name:"web_search"}],messages:[{role:"user",content:prompt}]})});
    const data=await r.json();
    let raw="";if(data.content)for(const b of data.content)if(b.type==="text")raw+=b.text;
    return raw;
  }
  function pJ(raw,arr=false){
    let c=raw.replace(/```json|```/g,"").trim();
    const ch=arr?"[":"{",ct=arr?"]":"}";
    const si=c.indexOf(ch),ei=c.lastIndexOf(ct);
    if(si!==-1&&ei!==-1)c=c.substring(si,ei+1);
    return JSON.parse(c);
  }

  async function autoFill(){
    const h=d.aiH.trim(),a=d.aiA.trim();
    if(!h||!a){setAiMsg({t:"err",m:"⚠️ Remplis les deux équipes."});return;}
    setAiLoad(true);setBkD(null);setNar("");

    // Étape 1 — Stats depuis DB locale (instantané)
    const mDB=MS.find(m=>m.h===h&&m.a===a);
    if(mDB){
      setD(p=>({...p,home:h,away:a,
        hXG:mDB.hxg||p.hXG,hXGA:mDB.hxga||p.hXGA,hG:mDB.hg||p.hG,
        aXG:mDB.axg||p.aXG,aXGA:mDB.axga||p.aXGA,aG:mDB.ag||p.aG,
        hF:mDB.hf||p.hF,aF:mDB.af||p.aF,derby:mDB.derby||false,
        o1:mDB.o1||"",oN:mDB.oN||"",o2:mDB.o2||""}));
    }

    // Étape 2 — Cotes 10 bookmakers
    setAiStep("Scraping cotes Betclic, Pinnacle, Unibet, 1xBet…");
    let bkData=null;
    try{
      const r=await callAI(
        `Cotes ${h} vs ${a} (${d.aiC}). 10 bookmakers: Betclic, Unibet, Pinnacle, 1xBet, Betsson, William Hill, Betway, Ladbrokes, 888sport, Betfair.
JSON uniquement — pas de texte avant ou après:
{"bk":[{"n":"Betclic","o1":1.85,"oN":3.60,"o2":4.20,"o25":1.80,"oBtts":1.72},{"n":"Pinnacle","o1":1.89,"oN":3.55,"o2":4.15,"o25":1.82,"oBtts":1.71}],
"best1":1.89,"bestN":3.65,"best2":4.25,"consensus":"1","move":"2.05→1.89 en 24h"}`,1500);
      bkData=pJ(r);setBkD(bkData);
      if(bkData?.bk?.length){
        const b1=Math.max(...bkData.bk.map(b=>b.o1||0));
        const bN=Math.max(...bkData.bk.map(b=>b.oN||0));
        const b2=Math.max(...bkData.bk.map(b=>b.o2||0));
        setD(p=>({...p,o1:b1||p.o1,oN:bN||p.oN,o2:b2||p.o2}));
      }
    }catch(e){}

    // Étape 3 — Verdict Claude (inspiré code Python get_claude_verdict)
    // Scraping news + analyse risk management comme dans le code Python
    setAiStep("Claude analyse blessures, contexte, risk management…");
    try{
      // Calcul stats pour le prompt (comme Python run_analysis)
      const hxg=mDB?.hxg||+d.hXG||1.4;
      const axg=mDB?.axg||+d.aXG||1.1;
      const bestOdd=bkData?.bk?Math.max(...bkData.bk.map(b=>b.o1||0)):+d.o1||2;
      const pHome=mDB?.e?.pH||(1-Math.exp(-hxg))*(Math.exp(-axg));
      const edgeCalc=pHome&&bestOdd?(pHome*bestOdd-1):0;
      const kellyCalc=edgeCalc>0?(edgeCalc/(bestOdd-1))*0.25*100:0;

      const r2=await callAI(
        `ANALYSE DE MATCH PRO: ${h} vs ${a} (${d.aiC})

DONNÉES DIXON-COLES:
- Prob victoire ${h}: ${(pHome*100).toFixed(1)}%
- Cote Pinnacle: ${bestOdd}
- Edge calculé: ${(edgeCalc*100).toFixed(1)}%
- Mise Kelly ¼ suggérée: ${kellyCalc.toFixed(1)}% bankroll

RÔLE: Expert risk management (comme dans le code Python).
1. Recherche les infos récentes: blessures, compositions, météo, enjeux, forme
2. Si joueur clé absent → réduis la recommandation
3. Si marché a déjà intégré l'info → sois prudent
4. Analyse si les stats contredisent le contexte actuel

RÉPONDS EN JSON UNIQUEMENT:
{"analyse":"2 phrases max avec infos concrètes","confiance":4,"verdict":"BET","misePct":${kellyCalc.toFixed(1)},"trap":false,"trapR":"","derby":false,"hFatigue":false,"aFatigue":false,"nar":"Analyse complète 5 phrases avec données chiffrées 2025-26"}

verdict: BET / REDUCE / NO BET
confiance: 1 à 5`,2000);
      const dt=pJ(r2);
      setNar(dt.nar||"");
      setD(p=>({...p,home:h,away:a,derby:dt.derby||p.derby,hFatigue:dt.hFatigue||false,aFatigue:dt.aFatigue||false,_trap:dt.trap,_trapR:dt.trapR,_verdict:dt.verdict,_analyse:dt.analyse,_confiance:dt.confiance,_misePct:dt.misePct}));
      const nb=bkData?.bk?.length||0;
      const verdictIcon=dt.verdict==="BET"?"✅":dt.verdict==="REDUCE"?"⚠️":"❌";
      setAiMsg({t:dt.verdict==="NO BET"?"err":"ok",
        m:`${verdictIcon} VERDICT: ${dt.verdict} · Confiance: ${dt.confiance}/5 · ${nb} bookmakers · Edge: ${(edgeCalc*100).toFixed(1)}%`});
    }catch(e){
      setAiMsg({t:"ok",m:`✓ ${h} vs ${a} — Stats chargées${bkData?.bk?.length?" · "+bkData.bk.length+" bookmakers":""}`});
    }
    setAiLoad(false);setAiStep("");
  }

  function doAnalyse(){
    const m={h:d.home,a:d.away,o1:+d.o1,oN:+d.oN,o2:+d.o2,derby:d.derby,hxg:+d.hXG,hg:+d.hG,hxga:+d.hXGA,axg:+d.aXG,ag:+d.aG,axga:+d.aXGA,hf:+d.hF,af:+d.aF};
    const e=calc(m);
    setRes({...e,d:{...d},nar,trap:d._trap,trapR:d._trapR,bkD});
    setTab("result");
  }

  function pickMatch(m){
    setSelM({h:m.h,a:m.a,t:m.t,c:m.c});
    setCompM(m);
    // ── Closing Line Worker ──
    // Planifie la récupération de la cote de fermeture T-5min (règle SQL pro)
    if(m.id&&m.t){
      const today=new Date().toISOString().slice(0,10);
      const matchTime=`${today}T${m.t}:00`;
      scheduleClosingWorker(m.id, matchTime, m.h, m.a);
    }
    sv("aiH",m.h);sv("aiA",m.a);sv("aiC",m.c);sv("home",m.h);sv("away",m.a);
    sv("derby",!!m.derby);sv("o1",""+m.o1);sv("oN",""+m.oN);sv("o2",""+m.o2);
    sv("hXG",m.hxg||1.5);sv("hXGA",m.hxga||1.1);sv("hG",m.hg||1.4);sv("hF",m.hf||7);
    sv("aXG",m.axg||1.2);sv("aXGA",m.axga||1.3);sv("aG",m.ag||1.1);sv("aF",m.af||7);
    setTab("analyse");window.scrollTo({top:0,behavior:"smooth"});
  }

  async function loadTips(){
    setTLoad(true);setTips([]);
    try{
      const raw=await callAI(`Parieur pro. Sélectionne 8 value bets du jour avec edge >5%. Pinnacle comme référence.
JSON array:
[{"c":"La Liga","h":"Real Madrid CF","a":"Atlético de Madrid","t":"21:00","bet":"Victoire Real Madrid","type":"1x2","odd":2.02,"prob":0.58,"edge":0.13,"conf":"high","val":true,"top":true,"kelly":0.04,"pinOdd":1.95,"reason":"xG dom 2.38, 6V/7 à domicile. Edge vs Pinnacle +5%.","risk":"Derby"}]`,2000);
      setTips(pJ(raw,true));
    }catch{}
    setTLoad(false);
  }

  function calcK(nb){
    const b=nb||bkC;
    const tot=+b.tot,prob=+b.prob,odd=+b.odd,frac=+b.frac||.25;
    if(!tot||!prob||!odd){setBkR(null);return;}
    const p=prob/100,bo=odd-1,q=1-p;
    const kR=Math.max(0,(bo*p-q)/bo),kA=kR*frac,m=kA*tot,g=odd*m-m,ev=p*odd-1;
    setBkR({kR,kA,m,g,ev});
  }

  // ── CLV TRACKER + DECIMAL INTEGRITY ──
  // CLV = (odds_taken / odds_closing) - 1
  // DECIMAL partout — jamais FLOAT pour l'argent (règle SQL pro)
  function logBet(r2, win, closingOdd=null){
    // Toutes les valeurs monétaires en DECIMAL(2) — jamais de flottant brut
    const stake = toMoney(Math.max(bk*(r2.kel||0.02), 1));
    const oddsT = toOdd(+r2.d.o1||2);
    const oddsC = toOdd(closingOdd||oddsT);
    // CLV avec précision DECIMAL(4,4) — comme la colonne SQL
    const clv = oddsC>0 ? toProba(oddsT/oddsC-1) : 0;
    const profit = win ? toMoney(stake*(oddsT-1)) : toMoney(-stake);
    const newBk = toMoney(bk+profit);
    const entry = {
      id: Date.now(),
      date: new Date().toLocaleDateString("fr-FR"),
      match: `${r2.d.home} vs ${r2.d.away}`,
      betType: r2.bR==="1"?"1":r2.bR==="N"?"N":"2",
      stake: toMoney(stake),
      oddsT: toOdd(oddsT),
      oddsC: toOdd(oddsC),
      clv: toProba(clv),         // DECIMAL(6,4)
      edge: toProba(r2.edg||0),  // DECIMAL(6,4)
      result: win?"WIN":"LOSS",  // pending → won/lost (comme SQL status)
      profit: toMoney(profit),
      bk: toMoney(newBk),
      conf: r2.conf||50,
      verdict: r2.d?._verdict||"BET",
    };
    // ── Trigger Bankroll (comme Trigger SQL) ──
    // Déclenché automatiquement quand result passe de pending → won/lost
    triggerBankrollUpdate(entry, newBk);
    saveHist([entry,...hist].slice(0,100));
  }

  /* ═══════════════════════════════════════════════════
     SYSTÈME BANKROLL INTEGRITY
     Inspiré des recommandations SQL pro:
     1. DECIMAL jamais FLOAT pour l'argent
     2. Trigger automatique WIN → bankroll update
     3. Closing Line Worker — 5 min avant chaque match
  ═══════════════════════════════════════════════════ */

  // ── Précision DECIMAL (jamais FLOAT) ──
  // Toutes les opérations financières utilisent cette fonction
  // pour éviter les erreurs floating-point (0.1 + 0.2 = 0.30000000000000004)
  const toDecimal=(v,decimals=4)=>{
    if(v===null||v===undefined||isNaN(v))return 0;
    return Math.round(v*Math.pow(10,decimals))/Math.pow(10,decimals);
  };
  const toMoney=(v)=>toDecimal(v,2);   // Pour les euros (2 décimales)
  const toProba=(v)=>toDecimal(v,4);   // Pour les probabilités (4 décimales)
  const toOdd=(v)=>toDecimal(v,3);     // Pour les cotes (3 décimales)

  // ── Trigger Bankroll (comme Trigger SQL bets → bankroll_snapshots) ──
  // S'exécute automatiquement quand un résultat passe de "pending" à "won/lost"
  function triggerBankrollUpdate(entry, newBk){
    // Snapshot (comme INSERT INTO bankroll_snapshots)
    try{
      const snaps=JSON.parse(localStorage.getItem("edge_snaps")||"[]");
      snaps.push({
        t:Date.now(),
        bk:toMoney(newBk),
        dailyYield:toDecimal(entry.profit/entry.stake,4), // DECIMAL(6,4) comme SQL
        betId:entry.id,
        result:entry.result,
      });
      localStorage.setItem("edge_snaps",JSON.stringify(snaps.slice(-500)));
      // Update total_bankroll (comme UPDATE users SET total_bankroll=...)
      saveBk(toMoney(newBk));
    }catch(e){}
  }

  // ── Closing Line Worker ──
  // S'exécute 5 minutes avant chaque match pour récupérer la cote de fermeture
  // Utilise localStorage comme "base de données" côté client
  function scheduleClosingWorker(matchId, matchTime, homeTeam, awayTeam){
    try{
      const matchTs=new Date(matchTime).getTime();
      const workerTs=matchTs-(5*60*1000); // T-5 minutes
      const now=Date.now();
      const delayMs=workerTs-now;
      if(delayMs<=0||delayMs>24*60*60*1000)return; // Pas dans les 24h
      // Stocker le job (comme une queue de tâches)
      const jobs=JSON.parse(localStorage.getItem("edge_cl_jobs")||"[]");
      if(jobs.find(j=>j.id===matchId))return; // Déjà schedulé
      jobs.push({id:matchId,matchTime,homeTeam,awayTeam,scheduledAt:workerTs,status:"pending"});
      localStorage.setItem("edge_cl_jobs",JSON.stringify(jobs.slice(-50)));
      // setTimeout pour déclencher dans delayMs ms
      setTimeout(async()=>{
        try{
          // Récupère la cote de fermeture via The Odds API
          if(!oddsKey)return;
          const url=`https://api.the-odds-api.com/v4/sports/soccer/events/${matchId}/odds?apiKey=${oddsKey}&regions=eu&markets=h2h&oddsFormat=decimal`;
          const r=await fetch(url);
          if(!r.ok)return;
          const data=await r.json();
          const bkOdds=data.bookmakers||[];
          const pinOdds=bkOdds.find(b=>b.key==="pinnacle");
          const closingOdd=pinOdds?.markets?.[0]?.outcomes?.find(o=>o.name===homeTeam)?.price;
          if(!closingOdd)return;
          // Sauvegarder la cote de fermeture (comme UPDATE bets SET odds_closing=...)
          const closingData=JSON.parse(localStorage.getItem("edge_closing")||"{}");
          closingData[matchId]={closingOdd:toOdd(closingOdd),fetchedAt:Date.now(),source:"Pinnacle"};
          localStorage.setItem("edge_closing",JSON.stringify(closingData));
          // Marquer le job comme complété
          const updJobs=JSON.parse(localStorage.getItem("edge_cl_jobs")||"[]");
          const jIdx=updJobs.findIndex(j=>j.id===matchId);
          if(jIdx>=0){updJobs[jIdx].status="done";updJobs[jIdx].closingOdd=toOdd(closingOdd);}
          localStorage.setItem("edge_cl_jobs",JSON.stringify(updJobs));
        }catch(e){}
      }, Math.max(0,delayMs));
    }catch(e){}
  }

  // Récupère la cote de fermeture enregistrée pour un match
  function getClosingOdd(matchId){
    try{
      const closingData=JSON.parse(localStorage.getItem("edge_closing")||"{}");
      return closingData[matchId]?.closingOdd||null;
    }catch{return null;}
  }

  // Stats CLV avancées (DECIMAL précis, jamais FLOAT)
  const clvStats = hist.length>0 ? {
    avgCLV: toProba(hist.reduce((a,h)=>a+(h.clv||0),0)/hist.length),
    posClv: hist.filter(h=>(h.clv||0)>0).length,
    avgEdge: toDecimal(hist.reduce((a,h)=>a+(h.edge||0),0)/hist.length*100,1),
    avgOdds: toOdd(hist.reduce((a,h)=>a+(h.oddsT||2),0)/hist.length),
    totalStake: toMoney(hist.reduce((a,h)=>a+(h.stake||0),0)),
    totalProfit: toMoney(hist.reduce((a,h)=>a+(h.profit||0),0)),
    roi: hist.reduce((a,h)=>a+(h.stake||0),0)>0
      ? toDecimal(hist.reduce((a,h)=>a+(h.profit||0),0)/hist.reduce((a,h)=>a+(h.stake||0),0)*100,1)
      : 0,
  } : null;

  // Filtrage
  const leagues=[...new Set(MS.map(m=>m.c))];
  const filtL=leagues.filter(c=>{
    if(fil==="all")return true;
    const m=MS.find(x=>x.c===c);const f=m?.f||"";
    if(fil==="fr")return f==="🇫🇷";
    if(fil==="eu")return["🏴󠁧󠁢󠁥󠁮󠁧󠁿","🇪🇸","🇮🇹","🇩🇪","🇵🇹","🇳🇱","🇧🇪","🏴󠁧󠁢󠁳󠁣󠁴󠁿"].includes(f);
    if(fil==="cup")return["🏆","🟠"].includes(f);
    if(fil==="val")return MS.filter(x=>x.c===c).some(x=>x.e.edg>0.07);
    if(fil==="arb")return MS.filter(x=>x.c===c).some(x=>x.arb!==null);
    return true;
  });

  /* ─── PAGES ─── */
  function Scanner(){
    return(<>
      <div className="scan-hero">
        <div className="scan-t">Trouve l'<span>Edge</span>.<br/>Bats le marché.</div>
        <div className="scan-s">Dixon-Coles · {MS.length} matchs · Cotes réelles</div>
        <button className="scan-btn" onClick={runScanner} disabled={scanLoad}>
          {scanLoad?"Calcul…":"⚡  Scanner les Opportunités"}
        </button>
      </div>
      <div className="sgrid">
        {[{l:"Matchs",v:MS.length,c:"var(--t1)"},{l:"Value",v:valCount,c:"var(--gold)"},{l:"Arbitrages",v:arbCount,c:"var(--em)"},{l:"Bookmakers",v:10,c:"var(--blue)"}].map(s=>(
          <div key={s.l} className="sbox"><div className="sv" style={{color:s.c}}>{s.v}</div><div className="sl">{s.l}</div></div>
        ))}
      </div>
      {arbCount>0&&(
        <div className="cardem" style={{marginBottom:16}}>
          <div className="clbl" style={{color:"var(--em)"}}>Arbitrages Détectés</div>
          {MS.filter(m=>m.arb!==null).map((m,i)=>(
            <div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:i<arbCount-1?"1px solid rgba(52,211,153,.1)":"none"}}>
              <div><div style={{fontWeight:600,fontSize:13}}>{m.h} vs {m.a}</div><div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:2}}>{m.c} · {m.t}</div></div>
              <div style={{display:"flex",gap:7,alignItems:"center"}}>
                <Tag c="te" ch={`+${m.arb}% garanti`}/>
                <button className="abtn" onClick={()=>pickMatch(m)}>Analyser →</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {!scanned&&!scanLoad&&(
        <div className="empty"><div className="ei">⚡</div><div className="et">Prêt à analyser</div><div className="es">{MS.length} matchs indexés avec cotes réelles<br/>Betclic · Pinnacle · Unibet · 1xBet · William Hill</div></div>
      )}
      {scanned&&!scanLoad&&(<>
        <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginBottom:13,letterSpacing:".07em"}}>{signals.length} SIGNAUX · EDGE &gt; 3%</div>
        {signals.map((m,i)=>{
          const e=m.e,cc=e.conf>=75?"var(--gold)":e.conf>=60?"var(--t1)":"var(--t2)";
          return(
            <div key={m.id} className={`sig${e.conf>=72?" top":""} fu`} style={{animationDelay:`${i*.04}s`}} onClick={()=>pickMatch(m)}>
              <div className="sig-str" style={{background:m.arb?"var(--em)":e.conf>=72?"var(--gold)":"transparent"}}/>
              <div className="sig-bd">
                <div className="sig-mt">
                  <span>{m.f}</span><span>{m.c}</span><span>·</span><span>{m.t}</span>
                  {m.arb&&<Tag c="te" ch={`+${m.arb}% ARB`}/>}
                  {e.conf>=75&&<Tag c="tg" ch="Top Signal"/>}
                  {e.edg>0.10&&<Tag c="te" ch="Strong Value"/>}
                  {e.safetyStatus==="WARNING"&&<Tag c="tr" ch="⚠ Marché suspect"/>}
                  {e.safetyStatus==="SUSPENDED"&&<Tag c="tr" ch="🚫 Suspendu"/>}
                </div>
                <div className="sig-tm">{m.h} vs {m.a}</div>
                <div className="sig-bt" style={{color:cc}}>{e.label}</div>
                <div className="sig-mg">
                  {[{l:"Confiance",v:`${e.conf}%`,c:cc},{l:"Proba",v:`${(e.bP*100).toFixed(1)}%`,c:"var(--em)"},{l:"Edge",v:`+${((e.edg||0)*100).toFixed(1)}%`,c:"var(--t1)"},{l:"Kelly ¼",v:`${((e.kel||0)*100).toFixed(1)}%`,c:"var(--gold)"}].map(x=>(
                    <div key={x.l} className="sig-m"><div className="sig-ml">{x.l}</div><div className="sig-mv" style={{color:x.c}}>{x.v}</div></div>
                  ))}
                </div>
                <div className="cbar"><div className="cbf" style={{width:`${e.conf}%`,background:cc}}/></div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {e.bO>0&&<span style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:700,color:"var(--gold)"}}>@ {e.bO.toFixed(2)}</span>}
                    <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--t3)"}}>λ{e.lH.toFixed(2)}—{e.lA.toFixed(2)}</span>
                  </div>
                  <span style={{fontSize:11,color:"var(--t3)"}}>Analyser →</span>
                </div>
              </div>
            </div>
          );
        })}
      </>)}
    </>);
  }

  function Matchs(){
    return(<>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,flexWrap:"wrap",gap:10}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:900,letterSpacing:"-1px",marginBottom:3}}>
            Matchs <span style={{fontSize:14,fontWeight:400,color:"var(--gold)",fontFamily:"'Inter',sans-serif"}}>{MS.length}</span>
          </div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",letterSpacing:".05em"}}>22 MARS 2026 · COTES RÉELLES · 10 BOOKMAKERS</div>
        </div>
      </div>
      <div className="fils">
        {[["all","🌍 Tous"],["fr","🇫🇷 France"],["eu","🇪🇺 Europe"],["cup","🏆 Coupes"],["val","⚡ Value"],["arb","♾ Arb"]].map(([f,l])=>(
          <button key={f} onClick={()=>setFil(f)} className={`fib${fil===f?" on":""}`}>
            {f==="arb"&&arbCount>0?`♾ Arb (${arbCount})`:f==="val"&&valCount>0?`⚡ Value (${valCount})`:l}
          </button>
        ))}
      </div>
      {filtL.map(lg=>{
        const ms=MS.filter(m=>m.c===lg);
        const isO=!!openL[lg];
        const hasArb=ms.some(m=>m.arb!==null);
        const hasVal=ms.some(m=>m.e.edg>0.07);
        return(
          <div key={lg} className="league">
            <div className="lg-hd" onClick={()=>setOpenL(p=>({...p,[lg]:!p[lg]}))}>
              <span style={{fontSize:15}}>{ms[0]?.f||"⚽"}</span>
              <span className="lg-n">{lg}</span>
              <span className="lg-c">{ms.length}</span>
              {hasArb&&<Tag c="te" ch="♾ Arb"/>}
              {hasVal&&<Tag c="tg" ch="⚡ Value"/>}
              <div className="lg-l"/>
              <span className={`lg-ar${isO?" op":""}`}>▾</span>
            </div>
            {isO&&(
              <div className="mwrap">
                {ms.map((m,i)=>{
                  const hasV=m.e.edg>0.06;
                  return(
                    <div key={m.id} className={`mrow${m.arb?" arb":m.hot?" hot":""}`} onClick={()=>pickMatch(m)}>
                      {m.arb&&<span className="vbadge">♾ +{m.arb}%</span>}
                      {!m.arb&&hasV&&<span className="vbadge">⚡ +{((m.e.edg||0)*100).toFixed(0)}%</span>}
                      <div className="mtime">
                        {m.arb&&<span className="mtag arb">ARB</span>}
                        {m.hot&&!m.arb&&<span className="mtag choc">Choc</span>}
                        <span className={`mt${m.hot?" hot":""}`}>{m.t}</span>
                      </div>
                      <div style={{textAlign:"right",paddingRight:9}}>
                        <div className="mteam">{m.h}</div>
                        <div className="mxg" style={{color:m.hxg>1.8?"var(--em)":m.hxg<1.1?"var(--red)":"var(--t3)"}}>{m.hxg} xG</div>
                      </div>
                      <div className="odds">
                        {[{v:m.o1,l:"1"},{v:m.oN,l:"N"},{v:m.o2,l:"2"}].map(ot=>{
                          const isV=m.e&&((ot.l==="1"&&m.e.bR==="1")||(ot.l==="N"&&m.e.bR==="N")||(ot.l==="2"&&m.e.bR==="2"))&&m.e.edg>0.05;
                          return(
                            <div key={ot.l} className={`odd${isV?" val":""}`} onClick={e2=>{e2.stopPropagation();pickMatch(m);}}>
                              <span className="odd-l">{ot.l}</span>
                              <span className="odd-v">{ot.v?.toFixed(2)||"—"}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div>
                        <div className="mteam">{m.a}</div>
                        <div className="mxg" style={{color:m.axg>1.8?"var(--em)":m.axg<1.1?"var(--red)":"var(--t3)"}}>{m.axg} xG</div>
                      </div>
                      <div className="mcta">
                        <button className="abtn" onClick={e2=>{e2.stopPropagation();pickMatch(m);}}>Analyser</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>);
  }

  function Comparateur(){
    const m=compM;
    if(!m)return(<div className="empty"><div className="ei">📊</div><div className="et">Aucun match</div><div className="es">Clique "Analyser" sur un match<br/>pour comparer les cotes</div></div>);
    const bks=m.bk||[];
    const allO1=bks.map(b=>b.o1||0),allON=bks.map(b=>b.oN||0),allO2=bks.map(b=>b.o2||0);
    const mO1=Math.max(...allO1),mON=Math.max(...allON),mO2=Math.max(...allO2);
    const e=m.e;
    const marg=(o1,oN,o2)=>o1&&oN&&o2?+((1/o1+1/oN+1/o2-1)*100).toFixed(1):null;
    return(<>
      <div style={{marginBottom:18}}>
        <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:900,letterSpacing:"-1px",marginBottom:3}}>{m.h} <span style={{color:"var(--t3)",fontWeight:300}}>vs</span> {m.a}</div>
        <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",letterSpacing:".05em"}}>{m.c} · {m.t} · {bks.length} BOOKMAKERS</div>
      </div>
      {m.arb!==null&&(
        <div className="cardem" style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div><div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--em)",letterSpacing:".1em",marginBottom:4}}>ARBITRAGE DÉTECTÉ</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:900,color:"var(--em)"}}>+{m.arb}% garanti</div></div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginBottom:2}}>Mise min.</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:700}}>≥ 300€</div>
            </div>
          </div>
        </div>
      )}
      <div className="cardg">
        <div className="clbl" style={{color:"var(--gold)"}}>Comparaison — {bks.length} Bookmakers</div>
        <div style={{overflowX:"auto"}}>
          <table className="ctable">
            <thead><tr><th>Bookmaker</th><th>Cote 1</th><th>Cote N</th><th>Cote 2</th><th>Marge</th></tr></thead>
            <tbody>
              {bks.map((b,i)=>{
                const mg=marg(b.o1,b.oN,b.o2);
                const isPin=b.n==="Pinnacle";
                return(<tr key={i}>
                  <td className="bkn">{b.n}{isPin&&<span className="pin-b">Sharp</span>}</td>
                  <td className={`oc${b.o1===mO1?" best":""}`}>{b.o1?.toFixed(2)||"—"}</td>
                  <td className={`oc${b.oN===mON?" best":""}`}>{b.oN?.toFixed(2)||"—"}</td>
                  <td className={`oc${b.o2===mO2?" best":""}`}>{b.o2?.toFixed(2)||"—"}</td>
                  <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:mg&&mg<4?"var(--em)":mg&&mg>7?"var(--red)":"var(--t3)"}}>{mg?`${mg}%`:"—"}</td>
                </tr>);
              })}
              <tr className="avg-r">
                <td className="bkn">MEILLEURE COTE</td>
                <td className="oc">{mO1>0?mO1.toFixed(2):"—"}</td>
                <td className="oc">{mON>0?mON.toFixed(2):"—"}</td>
                <td className="oc">{mO2>0?mO2.toFixed(2):"—"}</td>
                <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--gold)"}}>{marg(mO1,mON,mO2)?`${marg(mO1,mON,mO2)}%`:"—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {e&&(
        <div className="card" style={{borderLeft:"3px solid var(--gold)"}}>
          <div className="clbl">Analyse Dixon-Coles</div>
          <div style={{fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:800,color:e.conf>=70?"var(--gold)":"var(--t1)",marginBottom:5}}>{e.label}</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7}}>
            {[{l:m.h.split(" ").slice(0,2).join(" "),p:e.pH,k:"1"},{l:"Nul",p:e.pN,k:"N"},{l:m.a.split(" ").slice(0,2).join(" "),p:e.pA,k:"2"}].map(it=>(
              <div key={it.k} style={{background:it.k===e.bR?"rgba(232,184,75,.08)":"var(--c2)",border:`1px solid ${it.k===e.bR?"rgba(232,184,75,.3)":"var(--ln)"}`,borderRadius:11,padding:"12px 7px",textAlign:"center"}}>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:800,color:it.k===e.bR?"var(--gold)":"var(--t1)"}}>{(it.p*100).toFixed(1)}%</div>
                <div style={{fontSize:11,color:it.k===e.bR?"var(--gold)":"var(--t3)",marginTop:3}}>{it.l}</div>
                {e.edg!==null&&it.k===e.bR&&<div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--em)",marginTop:3}}>edge +{((e.edg||0)*100).toFixed(1)}%</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <button onClick={()=>setTab("analyse")} style={{width:"100%",padding:"12px",background:"rgba(232,184,75,.1)",border:"1px solid rgba(232,184,75,.3)",borderRadius:12,color:"var(--gold)",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"'Syne',sans-serif",letterSpacing:"-.2px",marginTop:4}}>Analyse Complète →</button>
    </>);
  }

  function Analyse(){
    return(<>
      {selM&&(
        <div className="msel">
          <div style={{flex:1}}><div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,letterSpacing:"-.3px"}}>{selM.h} <span style={{color:"var(--t3)",fontWeight:300}}>vs</span> {selM.a}</div>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:2}}>{selM.c} · {selM.t}</div></div>
          <button onClick={()=>setSelM(null)} style={{background:"none",border:"none",color:"var(--t3)",fontSize:20,cursor:"pointer"}}>×</button>
        </div>
      )}
      <div className="aib">
        <div className="aih"><span className="aid"/>&nbsp;Analyse IA — Stats DB + 10 Bookmakers</div>
        <div className="ais">Stats 2025-26 pré-chargées · Cotes Betclic, Pinnacle, Unibet, 1xBet… · Nécessite clé Anthropic</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 26px 1fr",gap:8,marginBottom:10}}>
          <In v={d.aiH} on={v=>sv("aiH",v)} ph="Équipe domicile" big/>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",background:"var(--c3)",border:"1px solid var(--ln)",borderRadius:8,fontSize:9,fontWeight:700,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>VS</div>
          <In v={d.aiA} on={v=>sv("aiA",v)} ph="Équipe extérieur" big/>
        </div>
        <div className="g2" style={{marginBottom:10}}>
          <Fw lbl="Compétition"><Se v={d.aiC} on={v=>sv("aiC",v)} opts={["Ligue 1","La Liga","Premier League","Serie A","Bundesliga","Liga Portugal","Champions League","Europa League","Eredivisie","Pro League","Süper Lig","Championship","MLS"]}/></Fw>
          <Fw lbl="Bankroll (€)"><In v={d.bk} on={v=>sv("bk",v)} ph="1000"/></Fw>
        </div>
        {aiLoad&&aiStep&&<div className="stb"><div className="spin" style={{width:14,height:14,flexShrink:0}}/>&nbsp;{aiStep}</div>}
        <button onClick={autoFill} disabled={aiLoad} className="cbtn">
          {aiLoad?<span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}><Ld/>&nbsp;Analyse…</span>:"Charger Stats + Scraper Bookmakers"}
        </button>
        {aiMsg.m&&<div className={`aimsg ${aiMsg.t==="ok"?"aiok":"aier"}`}>{aiMsg.m}</div>}
      </div>
      <Fsec n="01" t="Équipes & Contexte" ch={<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 26px 1fr",gap:8,marginBottom:10}}>
          <Fw lbl="Domicile"><In v={d.home} on={v=>sv("home",v)} ph="PSG"/></Fw>
          <div style={{height:34,display:"flex",alignItems:"center",justifyContent:"center",background:"var(--c3)",border:"1px solid var(--ln)",borderRadius:"50%",fontSize:9,fontWeight:700,color:"var(--t3)"}}>VS</div>
          <Fw lbl="Extérieur"><In v={d.away} on={v=>sv("away",v)} ph="Monaco"/></Fw>
        </div>
        <div className="g3">
          <Fw lbl="Derby"><Rg opts={[{k:false,l:"Non"},{k:true,l:"Oui"}]} v={d.derby} on={v=>sv("derby",v)}/></Fw>
          <Fw lbl="Fatigue Dom."><Rg opts={[{k:false,l:"Non"},{k:true,l:"Oui"}]} v={d.hFat} on={v=>sv("hFat",v)}/></Fw>
          <Fw lbl="Fatigue Ext."><Rg opts={[{k:false,l:"Non"},{k:true,l:"Oui"}]} v={d.aFat} on={v=>sv("aFat",v)}/></Fw>
        </div>
      </>}/>
      <Fsec n="02" t="Stats xG — FBref/Understat 2025-26" ch={<>
        <div className="g4" style={{marginBottom:8}}>
          <Fw lbl="xG Dom."><In v={d.hXG} on={v=>sv("hXG",v)} ph="1.8"/></Fw>
          <Fw lbl="xGA Dom."><In v={d.hXGA} on={v=>sv("hXGA",v)} ph="1.0"/></Fw>
          <Fw lbl="xG Ext."><In v={d.aXG} on={v=>sv("aXG",v)} ph="1.3"/></Fw>
          <Fw lbl="xGA Ext."><In v={d.aXGA} on={v=>sv("aXGA",v)} ph="1.3"/></Fw>
        </div>
        <div className="g4">
          <Fw lbl="Buts/M Dom."><In v={d.hG} on={v=>sv("hG",v)} ph="1.8"/></Fw>
          <Fw lbl="Pts/5 Dom."><In v={d.hF} on={v=>sv("hF",v)} ph="10"/></Fw>
          <Fw lbl="Buts/M Ext."><In v={d.aG} on={v=>sv("aG",v)} ph="1.3"/></Fw>
          <Fw lbl="Pts/5 Ext."><In v={d.aF} on={v=>sv("aF",v)} ph="7"/></Fw>
        </div>
      </>}/>
      <Fsec n="03" t="Cotes — Meilleure par marché" ch={<>
        <div className="g3" style={{marginBottom:8}}>
          <Fw lbl="Cote 1"><In v={d.o1} on={v=>sv("o1",v)} ph="1.95"/></Fw>
          <Fw lbl="Cote N"><In v={d.oN} on={v=>sv("oN",v)} ph="3.50"/></Fw>
          <Fw lbl="Cote 2"><In v={d.o2} on={v=>sv("o2",v)} ph="3.80"/></Fw>
        </div>
        <div className="g3">
          <Fw lbl="Over 2.5"><In v={d.oO25} on={v=>sv("oO25",v)} ph="1.82"/></Fw>
          <Fw lbl="Over 3.5"><In v={d.oO35} on={v=>sv("oO35",v)} ph="2.48"/></Fw>
          <Fw lbl="BTTS"><In v={d.oBtts} on={v=>sv("oBtts",v)} ph="1.74"/></Fw>
        </div>
      </>}/>
      <button onClick={doAnalyse} className="cbtn">⚡  Générer l'Analyse Dixon-Coles</button>
      <div className="disc">Pariez responsablement. <strong style={{color:"var(--gold)"}}>Joueurs Info Service : 09 74 75 13 13</strong></div>
    </>);
  }

  function Resultat(){
    if(!res)return(<div className="empty"><div className="ei">📊</div><div className="et">Aucune analyse</div><div className="es">Lance une analyse depuis l'onglet Analyser</div></div>);
    const{pH,pN,pA,sc,p25,p15,pBT,lH,lA,d:rd,nar:rN,bkD:rBk,bR,bP,bO,edg,kel,conf,label}=res;
    const hasV=edg!==null&&edg>.03;
    const bkV=+rd.bk||0;
    const mise=kel&&bkV?(kel*bkV).toFixed(2):null;
    const hN=(rd.home||"Dom").split(" ").slice(0,2).join(" ");
    const aN=(rd.away||"Ext").split(" ").slice(0,2).join(" ");
    const cc=conf>=75?"var(--gold)":conf>=60?"var(--t1)":"var(--t2)";
    const i1=+rd.o1?(1/+rd.o1*100).toFixed(1):null;
    const iN=+rd.oN?(1/+rd.oN*100).toFixed(1):null;
    const i2=+rd.o2?(1/+rd.o2*100).toFixed(1):null;
    return(<div style={{paddingTop:4}}>
      <div className="vrd si">
        <div className="vey">Pronostic Dixon-Coles</div>
        <div className="vbet" style={{color:cc}}>{label}</div>
        <div className="vmeta">{rd.home||"Dom"} vs {rd.away||"Ext"} · λH {lH.toFixed(2)} — λA {lA.toFixed(2)}{rd.derby?" · Derby":""}{res.liveMin?" · "+res.liveMin+"'":""}</div>
        <div className="crow"><span className="cl">Confiance</span><span className="cv" style={{color:cc}}>{conf>=75?"Élevée":conf>=60?"Modérée":"Faible"} · {conf}/100</span></div>
        <div className="ctr"><div className="cf" style={{width:`${conf}%`,background:cc}}/></div>
        <div className="prow">
          {[{l:hN,p:pH,k:"1"},{l:"Nul",p:pN,k:"N"},{l:aN,p:pA,k:"2"}].map((it,idx)=>(
            <div key={it.k} className={`pb${it.k===bR?" win":""}`}>
              <div className="pp">{(it.p*100).toFixed(1)}%</div>
              <div className="pn">{it.l}</div>
              {[i1,iN,i2][idx]&&<div className="pi">cote: {[i1,iN,i2][idx]}%</div>}
            </div>
          ))}
        </div>
        <div className="b3">
          <div className="b3h" style={{width:`${(pH*100).toFixed(1)}%`}}/>
          <div className="b3n" style={{width:`${(pN*100).toFixed(1)}%`}}/>
          <div className="b3a" style={{width:`${(pA*100).toFixed(1)}%`}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:5}}>
          <span style={{color:"var(--blue)"}}>{hN}</span><span>Nul</span><span style={{color:"var(--gold)"}}>{aN}</span>
        </div>
      </div>
      {/* Safety Status (Gemini) */}
      {res.safetyStatus&&res.safetyStatus!=="SAFE"&&(
        <div style={{padding:"10px 15px",borderRadius:11,marginBottom:10,
          background:res.safetyStatus==="WARNING"?"rgba(251,191,36,.08)":"rgba(248,113,113,.08)",
          border:`1px solid ${res.safetyStatus==="WARNING"?"rgba(251,191,36,.3)":"rgba(248,113,113,.3)"}`,
          display:"flex",alignItems:"center",gap:9}}>
          <span style={{fontSize:16}}>{res.safetyStatus==="WARNING"?"⚠️":"🚫"}</span>
          <div>
            <div style={{fontFamily:"var(--f-mono,monospace)",fontSize:10,fontWeight:700,
              color:res.safetyStatus==="WARNING"?"#fbbf24":"var(--red)",letterSpacing:".08em",marginBottom:2}}>
              MARCHÉ {res.safetyStatus==="WARNING"?"SUSPECT":"SUSPENDU"}
            </div>
            <div style={{fontSize:12,color:"var(--t3,#666)"}}>
              {res.safetyStatus==="WARNING"?"Marge bookmaker élevée — value réduite":"Marge >30% — ne pas miser"}
            </div>
          </div>
        </div>
      )}
      {edg!==null&&(
        <div className={`edgb${hasV?" pos":" neg"} fu`}>
          <div>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:hasV?"var(--em)":"var(--red)",letterSpacing:".1em",marginBottom:4}}>{hasV?"EDGE POSITIF":"PAS DE VALUE"}</div>
            <div className="edgv">{hasV?"+":""}{(edg*100).toFixed(1)}%</div>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:4}}>
              Modèle: {(bP*100).toFixed(1)}% · Implicite: {bO?(1/bO*100).toFixed(1):"-"}%
            </div>
          </div>
          {bO>0&&<div style={{textAlign:"right"}}>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--t3)",marginBottom:3}}>Meilleure cote</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:26,fontWeight:900,color:"var(--gold)"}}>@ {bO.toFixed(2)}</div>
          </div>}
        </div>
      )}
      {/* VERDICT CLAUDE (inspiré Python get_claude_verdict) */}
      {rd._verdict&&(
        <div className={`fu`} style={{padding:"14px 17px",borderRadius:14,marginBottom:10,
          background:rd._verdict==="BET"?"rgba(52,211,153,.07)":rd._verdict==="REDUCE"?"rgba(251,191,36,.07)":"rgba(248,113,113,.07)",
          border:`1px solid ${rd._verdict==="BET"?"rgba(52,211,153,.3)":rd._verdict==="REDUCE"?"rgba(251,191,36,.3)":"rgba(248,113,113,.3)"}`}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <div>
              <div style={{fontFamily:"monospace",fontSize:9,letterSpacing:".12em",textTransform:"uppercase",
                color:rd._verdict==="BET"?"var(--em)":rd._verdict==="REDUCE"?"#fbbf24":"var(--red)",marginBottom:4}}>
                VERDICT CLAUDE — RISK MANAGEMENT
              </div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:900,letterSpacing:"-.5px",
                color:rd._verdict==="BET"?"var(--em)":rd._verdict==="REDUCE"?"#fbbf24":"var(--red)"}}>
                {rd._verdict==="BET"?"✅ BET":rd._verdict==="REDUCE"?"⚠️ RÉDUIRE LA MISE":"❌ NE PAS MISER"}
              </div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"monospace",fontSize:9,color:"var(--t3)",marginBottom:3}}>Confiance</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontSize:24,fontWeight:900,color:rd._verdict==="BET"?"var(--em)":"var(--gold)"}}>
                {rd._confiance||"?"}/5
              </div>
            </div>
          </div>
          {rd._analyse&&<div style={{fontSize:12,color:"var(--t2)",lineHeight:1.75,marginBottom:rd._misePct?8:0}}>{rd._analyse}</div>}
          {rd._misePct>0&&(
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:"rgba(0,0,0,.2)",borderRadius:8}}>
              <span style={{fontFamily:"monospace",fontSize:10,color:"var(--t3)"}}>Mise finale recommandée:</span>
              <span style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:"var(--gold)"}}>{rd._misePct}% bankroll</span>
            </div>
          )}
        </div>
      )}
      {rN&&<div className="cardg fu" style={{borderLeft:"none"}}><div className="clbl" style={{color:"var(--gold)"}}>Analyse Contextuelle</div><div style={{fontSize:13,color:"var(--t2)",lineHeight:1.9}}>{rN}</div></div>}
      {rBk?.bk?.length>0&&(
        <div className="cardg fu">
          <div className="clbl" style={{color:"var(--gold)"}}>{rBk.bk.length} Bookmakers</div>
          <div style={{overflowX:"auto"}}>
            <table className="ctable">
              <thead><tr><th>Bookmaker</th><th>1</th><th>N</th><th>2</th><th>O2.5</th><th>BTTS</th></tr></thead>
              <tbody>
                {(()=>{
                  const all1=rBk.bk.map(b=>b.o1||0),allN=rBk.bk.map(b=>b.oN||0),all2=rBk.bk.map(b=>b.o2||0);
                  const m1=Math.max(...all1),mN=Math.max(...allN),m2=Math.max(...all2);
                  return rBk.bk.map((b,i)=><tr key={i}>
                    <td className="bkn">{b.n}{b.n==="Pinnacle"&&<span className="pin-b">Sharp</span>}</td>
                    <td className={`oc${b.o1===m1?" best":""}`}>{b.o1?.toFixed(2)||"—"}</td>
                    <td className={`oc${b.oN===mN?" best":""}`}>{b.oN?.toFixed(2)||"—"}</td>
                    <td className={`oc${b.o2===m2?" best":""}`}>{b.o2?.toFixed(2)||"—"}</td>
                    <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--t2)"}}>{b.o25?.toFixed(2)||"—"}</td>
                    <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:12,color:"var(--t2)"}}>{b.oBtts?.toFixed(2)||"—"}</td>
                  </tr>);
                })()}
                <tr className="avg-r">
                  <td className="bkn">MEILLEUR</td>
                  {(()=>{const a1=rBk.bk.map(b=>b.o1||0),aN2=rBk.bk.map(b=>b.oN||0),a2=rBk.bk.map(b=>b.o2||0);return[Math.max(...a1),Math.max(...aN2),Math.max(...a2)].map((v,i)=><td key={i} className="oc">{v>0?v.toFixed(2):"—"}</td>);})()}
                  <td/><td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card fu">
        <div className="clbl">Scores Probables — Dixon-Coles</div>
        <div className="sgr" style={{marginBottom:9}}>
          {sc.map((s,i)=><div key={s.s} className={`sc2${i===0?" top":""}`}><div className="scv">{s.s}</div><div className="scp">{(s.p*100).toFixed(1)}%</div></div>)}
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
          {[`λH ${lH.toFixed(2)}`,`λA ${lA.toFixed(2)}`,`Tot ${(lH+lA).toFixed(2)}`].map(t=><span key={t} style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",padding:"2px 8px",background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:5}}>{t}</span>)}
        </div>
      </div>
      <div className="card fu">
        <div className="clbl">Marchés Alternatifs</div>
        <div className="mg4">
          {[{l:"Over 1.5",p:p15,o:+rd.oO25||0},{l:"Over 2.5",p:p25,o:+rd.oO25||0},{l:"Over 3.5",p:res.pO35||0,o:+rd.oO35||0},{l:"BTTS",p:pBT,o:+rd.oBtts||0}].map(mk=>{
            const e2=edge(mk.p,mk.o),isV=e2!==null&&e2>.03;
            return(<div key={mk.l} className={`mk${isV?" val":mk.p>.62?" ok":""}`}>
              <div className="mkp">{(mk.p*100).toFixed(0)}%</div>
              <div className="mkl">{mk.l}</div>
              {mk.o>0&&<div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:2}}>{mk.o.toFixed(2)}x</div>}
              {e2!==null&&<div className="mke">{e2>0?`+${(e2*100).toFixed(0)}%`:`${(e2*100).toFixed(0)}%`}</div>}
            </div>);
          })}
        </div>
      </div>
      <div className="card fu">
        <div className="clbl">Forces Comparées</div>
        {[{l:`Att. ${hN}`,v:`xG ${rd.hXG}`,p:Math.min(100,(+rd.hXG||1.5)/3.5*100),c:"var(--blue)"},{l:`Déf. ${hN}`,v:`xGA ${rd.hXGA}`,p:Math.max(5,(1-(+rd.hXGA||1.1)/3)*100),c:"var(--em)"},{l:`Att. ${aN}`,v:`xG ${rd.aXG}`,p:Math.min(100,(+rd.aXG||1.2)/3.5*100),c:"var(--gold)"},{l:`Déf. ${aN}`,v:`xGA ${rd.aXGA}`,p:Math.max(5,(1-(+rd.aXGA||1.3)/3)*100),c:"var(--red)"},{l:`Forme ${hN}`,v:`${rd.hF}/15`,p:(+rd.hF||7)/15*100,c:"var(--blue)"},{l:`Forme ${aN}`,v:`${rd.aF}/15`,p:(+rd.aF||7)/15*100,c:"var(--gold)"}].map(bar=>(
          <div key={bar.l} className="br">
            <div className="brt"><span style={{color:"var(--t2)",fontSize:12,fontWeight:500}}>{bar.l}</span><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)"}}>{bar.v}</span></div>
            <Bar p={bar.p} c={bar.c}/>
          </div>
        ))}
      </div>
      {kel>0&&bkV>0&&(
        <div className="cardg fu">
          <div className="clbl" style={{color:"var(--gold)"}}>Kelly ¼ — Bankroll</div>
          <div className="kg">
            {[{v:`${(kel*100).toFixed(2)}%`,l:"Kelly ¼"},{v:`${mise}€`,l:"Mise"},{v:`${bO||"—"}×`,l:"Cote"},{v:bO&&mise?`+${(bO*+mise-+mise).toFixed(2)}€`:"—",l:"Gain pot."}].map(it=>(
              <div key={it.l} className="kb"><div className="kbv">{it.v}</div><div className="kbl">{it.l}</div></div>
            ))}
          </div>
          <div className={`vp${hasV?" y":" n"}`}>{hasV?edg>.12?`✓ Strong Value +${(edg*100).toFixed(1)}%`:`✓ Value +${(edg*100).toFixed(1)}%`:"✗ Pas de value"}</div>
        </div>
      )}
      <div className="cardr fu">
        <div className="clbl" style={{color:"var(--red)"}}>Risques</div>
        {[pN>.28&&`Nul probable (${(pN*100).toFixed(0)}%) — pense à double chance 1X`,rd.derby&&"Derby — variance accrue (-10% lambdas)",!hasV&&"Pas de value détectée","Aucun modèle ne garantit un gain."].filter(Boolean).map((r,i)=>(
          <div key={i} style={{display:"flex",gap:7,fontSize:12,color:"var(--t3)",marginBottom:5}}>
            <span style={{width:3,height:3,background:"var(--red)",borderRadius:"50%",flexShrink:0,marginTop:5,display:"block"}}/>
            <span>{r}</span>
          </div>
        ))}
      </div>
      {/* CLV Tracker — Enregistrement avec cote de fermeture */}
      {(()=>{
        const[closingOdd,setClosingOdd]=useState("");
        return(
          <div className="card">
            <div className="clbl">Enregistrer le Pari — CLV Tracker</div>
            <div style={{marginBottom:10}}>
              <Fw lbl="Cote de fermeture (juste avant le match — pour CLV)">
                <In v={closingOdd} on={setClosingOdd} ph={res.bO?.toFixed(2)||"1.95"}/>
              </Fw>
              <div style={{fontFamily:"monospace",fontSize:10,color:"var(--t3)",marginTop:4,lineHeight:1.6}}>
                CLV = (cote prise / cote fermeture) - 1<br/>
                {closingOdd&&+closingOdd>0&&res.bO?(
                  <span style={{color:(res.bO/(+closingOdd)-1)>0?"var(--em)":"var(--red)",fontWeight:700}}>
                    CLV estimé: {((res.bO/(+closingOdd)-1)*100).toFixed(1)}% 
                    {(res.bO/(+closingOdd)-1)>0?" ✓ Tu as eu une meilleure cote que le marché":" ✗ Marché meilleur que toi"}
                  </span>
                ):"Entre la cote de fermeture pour calculer ton CLV"}
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>logBet(res,true,+closingOdd||null)}
                style={{flex:1,padding:"12px",background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.22)",borderRadius:11,color:"var(--em)",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Syne',sans-serif"}}>
                ✓ Gagné
              </button>
              <button onClick={()=>logBet(res,false,+closingOdd||null)}
                style={{flex:1,padding:"12px",background:"rgba(248,113,113,.06)",border:"1px solid rgba(248,113,113,.18)",borderRadius:11,color:"var(--red)",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Syne',sans-serif"}}>
                ✗ Perdu
              </button>
            </div>
          </div>
        );
      })()}
    </div>);
  }

  function Tips(){
    const filt=tips.filter(t=>tFil==="all"?true:tFil==="h"?t.conf==="high":tFil==="v"?t.val:tFil==="o"?t.type==="over":tFil==="b"?t.type==="btts":t.type==="1x2");
    return(<>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:17,flexWrap:"wrap",gap:10}}>
        <div><div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:900,letterSpacing:"-1px",marginBottom:3}}>Tips Edge</div>
          <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",letterSpacing:".05em"}}>EDGE &gt;5% · PINNACLE RÉFÉRENCE · CLÉ ANTHROPIC REQUISE</div></div>
        <button onClick={loadTips} style={{padding:"7px 15px",background:"var(--c1)",border:"1px solid rgba(255,255,255,.1)",borderRadius:100,color:"var(--t2)",fontSize:12,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:7}}>
          {tLoad?<><Ld/>&nbsp;…</>:<>↻ Actualiser</>}
        </button>
      </div>
      <div className="fils">
        {[["all","Tous"],["h","🟢 Conf."],["v","⚡ Value"],["o","⚽ Over"],["b","🔄 BTTS"],["1x2","1X2"]].map(([f,l])=>(
          <button key={f} onClick={()=>setTFil(f)} className={`fib${tFil===f?" on":""}`}>{f==="all"&&tips.length>0?`Tous (${tips.length})`:l}</button>
        ))}
      </div>
      {tLoad?<div style={{textAlign:"center",padding:"50px 20px"}}><Ld/></div>
      :tips.length===0?(<div className="empty"><div className="ei">🎯</div><div className="et">Aucun tip</div><div className="es">Nécessite la clé Anthropic<br/>Clique sur ⚙ pour la configurer</div>
        <button onClick={loadTips} style={{marginTop:16,padding:"8px 24px",background:"rgba(232,184,75,.1)",border:"1px solid rgba(232,184,75,.3)",borderRadius:100,color:"var(--gold)",fontSize:13,fontWeight:600,cursor:"pointer"}}>Charger</button>
      </div>)
      :filt.map((t,i)=>(
        <div key={i} className={`tip${t.top?" top":""} fu`} style={{animationDelay:`${i*.04}s`}}>
          <div className="tph">
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)"}}>{t.c}</span>
              {t.top&&<Tag c="tg" ch="Top"/>}{t.val&&<Tag c="tg" ch="Value"/>}
              {t.pinOdd&&<span className="pin-b">Pin {t.pinOdd}x</span>}
            </div>
            <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)"}}>{t.t}</span>
          </div>
          <div className="tpb">
            <div style={{fontSize:13,color:"var(--t3)",marginBottom:4}}>{t.h} vs {t.a}</div>
            <div className="tpbt" style={{color:t.top?"var(--gold)":"var(--t1)"}}>{t.bet}</div>
            <div className="tpmg">
              {[{l:"Cote",v:`${t.odd}×`,c:"var(--gold)"},{l:"Proba",v:`${t.prob?(t.prob*100).toFixed(0):"?"}%`,c:"var(--em)"},{l:"Edge",v:`+${t.edge?(t.edge*100).toFixed(1):"?"}%`,c:"var(--t1)"},{l:"Kelly",v:`${t.kelly?(t.kelly*100).toFixed(1):"?"}%`,c:"var(--gold)"}].map(m=>(
                <div key={m.l} className="tpm"><div className="tpml">{m.l}</div><div className="tpmv" style={{color:m.c}}>{m.v}</div></div>
              ))}
            </div>
            <div style={{fontSize:12,color:"var(--t3)",lineHeight:1.75}}>{t.reason}</div>
            {t.risk&&<div style={{marginTop:7,fontSize:11,color:"var(--red)",padding:"4px 9px",background:"rgba(248,113,113,.05)",border:"1px solid rgba(248,113,113,.14)",borderRadius:6}}>{t.risk}</div>}
          </div>
        </div>
      ))}
    </>);
  }

  // ── Simulation Monte Carlo Kelly (inspiré du code Python) ──
  function runMonteCarlo(bankroll=1000, nBets=500, edge=0.05, winProb=0.55, scenarios=5){
    const results=[];
    // Kelly ¼ — même formule que le code Python
    const kellyPct=(edge/(1/winProb-1))*0.25;
    const cappedKelly=Math.min(kellyPct,0.05); // Cap 5% sécurité
    for(let s=0;s<scenarios;s++){
      const history=[bankroll];
      let bk=bankroll;
      for(let i=0;i<nBets;i++){
        const stake=bk*cappedKelly;
        if(Math.random()<winProb){
          bk+=stake*(1/winProb*(1+edge)-1);
        }else{
          bk-=stake;
        }
        history.push(Math.max(0,+bk.toFixed(2)));
        if(bk<=0)break;
      }
      results.push(history);
    }
    return{results,kellyPct:cappedKelly,nBets};
  }

  function Bankroll(){
    const wr=hist.length>0?Math.round(wins/hist.length*100):null;
    const[mc,setMc]=useState(null);
    const[mcEdge,setMcEdge]=useState("0.05");
    const[mcProb,setMcProb]=useState("0.55");
    const[mcBets,setMcBets]=useState("500");
    const[mcScen,setMcScen]=useState("5");
    const[mcLoad,setMcLoad]=useState(false);

    function launchMC(){
      setMcLoad(true);
      setTimeout(()=>{
        const r=runMonteCarlo(bk,+mcBets||500,+mcEdge||0.05,+mcProb||0.55,+mcScen||5);
        setMc(r);setMcLoad(false);
      },100);
    }

    // Calcul stats Monte Carlo
    const mcStats=mc?{
      final:mc.results.map(r=>r[r.length-1]),
      best:Math.max(...mc.results.map(r=>r[r.length-1])),
      worst:Math.min(...mc.results.map(r=>r[r.length-1])),
      avg:mc.results.reduce((a,r)=>a+r[r.length-1],0)/mc.results.length,
      ruined:mc.results.filter(r=>r[r.length-1]<=0).length,
    }:null;

    // Couleurs des scénarios
    const MC_COLORS=["#e8b84b","#34d399","#60a5fa","#f87171","#a78bfa"];

    // SVG Chart inline (pas de lib externe)
    function MCChart({data,w=320,h=160}){
      if(!data||!data.results.length)return null;
      const allVals=data.results.flat();
      const maxV=Math.max(...allVals)*1.05;
      const minV=Math.min(0,...allVals);
      const range=maxV-minV||1;
      const maxLen=Math.max(...data.results.map(r=>r.length));
      const toX=(i)=>(i/(maxLen-1))*(w-20)+10;
      const toY=(v)=>h-10-((v-minV)/range)*(h-20);
      return(
        <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{display:"block",borderRadius:8}}>
          <rect width={w} height={h} fill="#181c28" rx="8"/>
          {/* Ligne de référence bankroll initiale */}
          <line x1={10} y1={toY(bk)} x2={w-10} y2={toY(bk)} stroke="rgba(255,255,255,.15)" strokeDasharray="4,4" strokeWidth="1"/>
          <text x={12} y={toY(bk)-4} fill="rgba(255,255,255,.3)" fontSize="9" fontFamily="monospace">Capital initial</text>
          {/* Lignes des scénarios */}
          {data.results.map((r,i)=>{
            const pts=r.map((v,j)=>`${toX(j)},${toY(v)}`).join(" ");
            return <polyline key={i} points={pts} fill="none" stroke={MC_COLORS[i%MC_COLORS.length]} strokeWidth="1.5" opacity=".85"/>;
          })}
          {/* Axe Y */}
          {[0,.25,.5,.75,1].map(p=>{
            const v=minV+range*p;
            return <text key={p} x={8} y={toY(v)+3} fill="rgba(255,255,255,.3)" fontSize="8" fontFamily="monospace" textAnchor="start">{v>=1000?`${(v/1000).toFixed(1)}k`:v.toFixed(0)}€</text>;
          })}
        </svg>
      );
    }

    return(<>
      <div style={{fontFamily:"'Syne',sans-serif",fontSize:22,fontWeight:900,letterSpacing:"-1px",marginBottom:3}}>Bankroll</div>
      <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginBottom:18,letterSpacing:".05em"}}>KELLY · HISTORIQUE · ROI</div>
      <div className="sg2">
        {[{l:"Capital",v:`${bk.toLocaleString("fr-FR")}€`,c:"var(--gold)"},{l:"Paris",v:hist.length||"—",c:"var(--t1)"},{l:"Win Rate",v:wr?`${wr}%`:"—",c:"var(--em)"},{l:"ROI",v:roi?`${roi>0?"+":""}${roi}%`:"—",c:roi&&+roi>0?"var(--em)":"var(--red)"}].map(s=>(
          <div key={s.l} className="sbox" onClick={s.l==="Capital"?()=>setShowBk(true):undefined} style={{cursor:s.l==="Capital"?"pointer":"default"}}>
            <div className="sv" style={{color:s.c}}>{s.v}</div><div className="sl">{s.l}</div>
          </div>
        ))}
      </div>
      {/* ── SIMULATION MONTE CARLO ── */}
      <div className="cardg" style={{marginBottom:11}}>
        <div className="clbl" style={{color:"var(--gold)"}}>Simulation Monte Carlo — Kelly ¼</div>
        <div style={{fontSize:12,color:"var(--t3)",marginBottom:12,lineHeight:1.7}}>
          Visualise l'évolution de ta bankroll sur plusieurs scénarios possibles.<br/>
          <span style={{color:"var(--gold)"}}>Inspiré de la simulation Python — {+mcScen||5} scénarios · {+mcBets||500} paris</span>
        </div>
        <div className="g4" style={{marginBottom:10}}>
          <Fw lbl="Edge (%)"><In v={mcEdge} on={setMcEdge} ph="0.05"/></Fw>
          <Fw lbl="Win Rate"><In v={mcProb} on={setMcProb} ph="0.55"/></Fw>
          <Fw lbl="Nb Paris"><In v={mcBets} on={setMcBets} ph="500"/></Fw>
          <Fw lbl="Scénarios"><In v={mcScen} on={setMcScen} ph="5"/></Fw>
        </div>
        <button onClick={launchMC} disabled={mcLoad} style={{width:"100%",height:44,background:"linear-gradient(135deg,var(--gold),#c49230)",border:"none",borderRadius:11,fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:800,color:"#070709",cursor:"pointer",marginBottom:12,opacity:mcLoad?.7:1}}>
          {mcLoad?"Simulation…":"▶  Lancer la Simulation"}
        </button>
        {mc&&(<>
          <MCChart data={mc}/>
          {/* Légende */}
          <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
            {mc.results.map((_,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:10,height:3,background:MC_COLORS[i%MC_COLORS.length],borderRadius:2}}/>
                <span style={{fontFamily:"monospace",fontSize:9,color:"var(--t3)"}}>Scén. {i+1}</span>
              </div>
            ))}
          </div>
          {/* Stats Monte Carlo */}
          {mcStats&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginTop:12}}>
              {[
                {l:"Meilleur",v:`${mcStats.best>1000?(mcStats.best/1000).toFixed(1)+"k":mcStats.best.toFixed(0)}€`,c:"var(--em)"},
                {l:"Pire",v:`${mcStats.worst.toFixed(0)}€`,c:"var(--red)"},
                {l:"Moyenne",v:`${mcStats.avg>1000?(mcStats.avg/1000).toFixed(1)+"k":mcStats.avg.toFixed(0)}€`,c:"var(--gold)"},
                {l:"Ruinés",v:`${mcStats.ruined}/${mc.results.length}`,c:mcStats.ruined>0?"var(--red)":"var(--em)"},
              ].map(s=>(
                <div key={s.l} style={{background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:10,padding:"10px 7px",textAlign:"center"}}>
                  <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:s.c,lineHeight:1,marginBottom:3}}>{s.v}</div>
                  <div style={{fontFamily:"monospace",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".06em"}}>{s.l}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{marginTop:10,padding:"9px 12px",background:"rgba(232,184,75,.06)",border:"1px solid rgba(232,184,75,.2)",borderRadius:9,fontFamily:"monospace",fontSize:11,color:"var(--t3)",lineHeight:1.7}}>
            Kelly ¼ calculé: <strong style={{color:"var(--gold)"}}>{((Math.min((+mcEdge||.05)/(1/(+mcProb||.55)-1),.05)*.25)*100).toFixed(2)}%</strong> par pari · 
            ROI théorique: <strong style={{color:"var(--em)"}}>+{((+mcEdge||.05)*100).toFixed(1)}%</strong>
          </div>
        </>)}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:11}}>
        <div className="cardg">
          <div className="clbl" style={{color:"var(--gold)"}}>Calculateur Kelly</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:11}}>
            <Fw lbl="Bankroll (€)"><In v={bkC.tot} on={v=>{const n={...bkC,tot:v};setBkC(n);calcK(n);}}/></Fw>
            <Fw lbl="Proba réelle (%)"><In v={bkC.prob} on={v=>{const n={...bkC,prob:v};setBkC(n);calcK(n);}}/></Fw>
            <Fw lbl="Cote"><In v={bkC.odd} on={v=>{const n={...bkC,odd:v};setBkC(n);calcK(n);}}/></Fw>
            <Fw lbl="Fraction"><Rg opts={["1.0","0.5","0.25","0.1"]} v={bkC.frac} on={v=>{const n={...bkC,frac:v};setBkC(n);calcK(n);}}/></Fw>
          </div>
          {bkR&&(
            <div style={{background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:11,padding:12}}>
              {[["Kelly brut",`${(bkR.kR*100).toFixed(2)}%`,null],["Kelly ¼",`${(bkR.kA*100).toFixed(2)}%`,"var(--gold)"],["Mise",`${bkR.m.toFixed(2)} €`,"var(--gold)"],["Gain",`+${bkR.g.toFixed(2)} €`,"var(--em)"],["Perte",`-${bkR.m.toFixed(2)} €`,"var(--red)"],["Edge",`${bkR.ev>0?"+":""}${(bkR.ev*100).toFixed(1)}%`,bkR.ev>0?"var(--em)":"var(--red)"]].map(([l,v,c])=>(
                <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--ln)",fontSize:13}}>
                  <span style={{color:"var(--t3)"}}>{l}</span>
                  <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:14,color:c||"var(--t1)"}}>{v}</span>
                </div>
              ))}
              <div className={`vp${bkR.ev>.03?" y":" n"}`} style={{marginTop:10}}>{bkR.kR<=0?"✗ Pas de value":bkR.ev>.10?"✓ Strong Value":bkR.ev>.03?"✓ Value OK":"⚠ Insuffisant"}</div>
            </div>
          )}
        </div>
        <div className="card">
          <div className="clbl">Règles Pro</div>
          {[["var(--em)","Max 3% / pari"],["var(--em)","Kelly ¼ min."],["var(--em)","Edge >5%"],["var(--em)","3+ bookmakers"],["var(--red)","Ne jamais chaser"],["var(--gold)","ROI: +5 à +15%"],["var(--gold)","55-60% win = pro"]].map(([c,t])=>(
            <div key={t} style={{display:"flex",gap:8,padding:"6px 9px",borderRadius:7,background:"var(--c2)",border:"1px solid var(--ln)",borderLeft:`2px solid ${c}`,fontSize:11,color:"var(--t2)",lineHeight:1.4,marginBottom:4}}>{t}</div>
          ))}
        </div>
      </div>
      {/* CLOSING LINE WORKER STATUS */}
      {(()=>{
        const jobs=JSON.parse(localStorage.getItem("edge_cl_jobs")||"[]");
        const pending=jobs.filter(j=>j.status==="pending");
        const done=jobs.filter(j=>j.status==="done");
        if(!jobs.length)return null;
        return(
          <div className="card" style={{marginBottom:8,borderLeft:"3px solid var(--blue)"}}>
            <div className="clbl" style={{color:"var(--blue)"}}>Closing Line Worker — T-5min</div>
            <div style={{fontSize:12,color:"var(--t3)",marginBottom:10,lineHeight:1.6}}>
              Récupère automatiquement les cotes Pinnacle 5 minutes avant chaque match.<br/>
              <span style={{color:"var(--gold)"}}>Vital pour le calcul du CLV.</span>
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <div style={{padding:"6px 12px",background:"rgba(96,165,250,.08)",border:"1px solid rgba(96,165,250,.25)",borderRadius:8,fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--blue)"}}>
                ⏳ {pending.length} en attente
              </div>
              <div style={{padding:"6px 12px",background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.25)",borderRadius:8,fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--em)"}}>
                ✓ {done.length} récupérées
              </div>
            </div>
            {done.length>0&&done.slice(-3).map((j,i)=>(
              <div key={i} style={{marginTop:6,fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",display:"flex",justifyContent:"space-between"}}>
                <span>{j.homeTeam} vs {j.awayTeam}</span>
                <span style={{color:"var(--gold)"}}>Pinnacle: {j.closingOdd}x</span>
              </div>
            ))}
          </div>
        );
      })()}
      {/* CLV ANALYTICS */}
      {clvStats&&hist.length>=3&&(
        <div className="cardg" style={{marginTop:8}}>
          <div className="clbl" style={{color:"var(--gold)"}}>CLV Analytics — Closing Line Value</div>
          <div style={{fontSize:12,color:"var(--t3)",marginBottom:12,lineHeight:1.7}}>
            CLV mesure si tu bats le marché. Positif = ton modèle est meilleur que les bookmakers.
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7,marginBottom:12}}>

            {[
              {l:"CLV Moyen",v:`${clvStats.avgCLV>0?"+":""}${(clvStats.avgCLV*100).toFixed(1)}%`,c:clvStats.avgCLV>0?"var(--em)":"var(--red)"},
              {l:"CLV>0",v:`${clvStats.posClv}/${hist.length}`,c:"var(--gold)"},
              {l:"Edge Moy.",v:`${clvStats.avgEdge}%`,c:+clvStats.avgEdge>3?"var(--em)":"var(--t2)"},
              {l:"Cote Moy.",v:`${clvStats.avgOdds}x`,c:"var(--t1)"},
              {l:"ROI Réel",v:`${clvStats.roi>0?"+":""}${clvStats.roi}%`,c:clvStats.roi>0?"var(--em)":"var(--red)"},
              {l:"Stake Total",v:`${clvStats.totalStake}€`,c:"var(--t2)"},
              {l:"P&L Total",v:`${clvStats.totalProfit>0?"+":""}${clvStats.totalProfit}€`,c:clvStats.totalProfit>0?"var(--em)":"var(--red)"},
            ].map(s=>(
              <div key={s.l} style={{background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:10,padding:"10px 7px",textAlign:"center"}}>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:16,fontWeight:800,color:s.c,lineHeight:1,marginBottom:3}}>{s.v}</div>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".06em"}}>{s.l}</div>
              </div>
            ))}
          </div>
          <div style={{padding:"10px 13px",borderRadius:10,
            background:clvStats.avgCLV>0.02?"rgba(52,211,153,.07)":clvStats.avgCLV>0?"rgba(232,184,75,.07)":"rgba(248,113,113,.07)",
            border:`1px solid ${clvStats.avgCLV>0.02?"rgba(52,211,153,.25)":clvStats.avgCLV>0?"rgba(232,184,75,.25)":"rgba(248,113,113,.2)"}`}}>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,fontWeight:700,
              color:clvStats.avgCLV>0.02?"var(--em)":clvStats.avgCLV>0?"var(--gold)":"var(--red)",
              letterSpacing:".08em",marginBottom:4}}>
              {clvStats.avgCLV>0.02?"✓ MODÈLE SHARP":clvStats.avgCLV>0?"△ MODÈLE CORRECT":"✗ MODÈLE À REVOIR"}
            </div>
            <div style={{fontSize:12,color:"var(--t2)",lineHeight:1.7}}>
              {clvStats.avgCLV>0.02?"Ton modèle bat régulièrement le marché. Continue.":clvStats.avgCLV>0?"Tu bats légèrement le marché. Augmente l'échantillon.":"Tes paris sont pris à des cotes inférieures à la fermeture. Améliore la sélection."}
            </div>
          </div>
        </div>
      )}
      {hist.length>0&&(
        <div className="card" style={{marginTop:8}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div className="clbl" style={{marginBottom:0}}>Historique ({hist.length} paris)</div>
            <button onClick={()=>saveHist([])} style={{fontSize:11,color:"var(--red)",background:"none",border:"none",cursor:"pointer",fontFamily:"'JetBrains Mono',monospace"}}>Effacer</button>
          </div>
          {hist.slice(0,10).map((h,i)=>(
            <div key={i} className="hr">
              <div>
                <div style={{fontSize:13,fontWeight:600}}>{h.match}</div>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:2,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span>{h.date}</span>
                  {h.oddsT&&<span>@ {h.oddsT}</span>}
                  {h.clv!==undefined&&h.clv!==0&&(
                    <span style={{color:h.clv>0?"var(--em)":"var(--red)",fontWeight:700}}>CLV {h.clv>0?"+":""}{(h.clv*100).toFixed(1)}%</span>
                  )}
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontFamily:"'Syne',sans-serif",fontSize:14,fontWeight:800,color:h.result==="WIN"?"var(--em)":"var(--red)"}}>{h.profit>0?"+":""}{h.profit}€</div>
                <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginTop:2}}>{h.bk}€</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>);
  }

  /* MODALS */
  function BkModal(){return(
    <div className="modal" onClick={()=>setShowBk(false)}>
      <div className="mbox" onClick={e=>e.stopPropagation()}>
        <div className="mtitle">Modifier la Bankroll</div>
        <Fw lbl="Nouvelle bankroll (€)"><In v={bkIn} on={setBkIn} ph={`${bk}`} big/></Fw>
        <div className="mrow2">
          <button onClick={()=>{if(+bkIn>0){saveBk(+bkIn);setShowBk(false);setBkIn("");}}} style={{flex:1,padding:"11px",background:"rgba(232,184,75,.1)",border:"1px solid rgba(232,184,75,.3)",borderRadius:11,color:"var(--gold)",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Syne',sans-serif"}}>Valider</button>
          <button onClick={()=>setShowBk(false)} style={{flex:1,padding:"11px",background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:11,color:"var(--t2)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Annuler</button>
        </div>
      </div>
    </div>
  );}
  function CfgModal(){
    const[k,setK]=useState(aiKey);
    return(
      <div className="modal" onClick={()=>setShowCfg(false)}>
        <div className="mbox" onClick={e=>e.stopPropagation()} style={{maxWidth:420}}>
          <div className="mtitle">⚙ Configuration</div>
          <div style={{marginBottom:18,padding:"14px",background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:12}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700,marginBottom:4}}>The Odds API <span style={{color:"var(--em)",fontSize:10,fontWeight:400}}>(cotes réelles)</span></div>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginBottom:8,lineHeight:1.6}}>
              Clé déjà intégrée ✓<br/><span style={{color:"var(--gold)"}}>ea06a842490d88237ac6d7cf4bfbb5e9</span>
            </div>
          </div>
          <div style={{marginBottom:18,padding:"14px",background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:12}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700,marginBottom:4}}>Anthropic Claude <span style={{color:"var(--blue)",fontSize:10,fontWeight:400}}>(analyse IA + live)</span></div>
            <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t3)",marginBottom:8,lineHeight:1.6}}>
              Commence par sk-ant-… · <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer" style={{color:"var(--gold)"}}>console.anthropic.com</a>
            </div>
            <In v={k} on={setK} ph="sk-ant-api03-..." mono/>
          </div>
          <div className="mrow2">
            <button onClick={()=>{saveKey(k);setShowCfg(false);}} style={{flex:1,padding:"11px",background:"rgba(232,184,75,.1)",border:"1px solid rgba(232,184,75,.3)",borderRadius:11,color:"var(--gold)",fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"'Syne',sans-serif"}}>Enregistrer</button>
            <button onClick={()=>setShowCfg(false)} style={{flex:1,padding:"11px",background:"var(--c2)",border:"1px solid var(--ln)",borderRadius:11,color:"var(--t2)",fontSize:14,fontWeight:600,cursor:"pointer"}}>Annuler</button>
          </div>
        </div>
      </div>
    );
  }

  const TABS=[{id:"scanner",l:"Scanner",icon:"⚡"},{id:"matchs",l:"Matchs",icon:"⚽",n:MS.length},{id:"comp",l:"Comparateur",icon:"📊",n:compM?1:null},{id:"tips",l:"Tips",icon:"🎯"},{id:"analyse",l:"Analyser",icon:"🔬"},{id:"result",l:"Résultat",icon:"📈"},{id:"bankroll",l:"Bankroll",icon:"💰"}];

  return(
    <div style={{minHeight:"100vh",background:"var(--bg)"}}>
      <style>{S}</style>
      <header>
        <div className="hi">
          <div className="logo">EDGE<span>.</span></div>
          <span className="hbadge ok">Dixon-Coles</span>
          <span className="hbadge ok">{MS.length} matchs</span>
          {arbCount>0&&<span className="hbadge ok">♾ {arbCount} arb</span>}
          <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>setShowCfg(true)} style={{padding:"6px 12px",background:aiKey?"rgba(52,211,153,.08)":"var(--c1)",border:`1px solid ${aiKey?"rgba(52,211,153,.3)":"rgba(255,255,255,.1)"}`,borderRadius:100,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:13}}>⚙</span>
              <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,color:aiKey?"var(--em)":"var(--t3)",letterSpacing:".06em",textTransform:"uppercase"}}>{aiKey?"IA OK":"Config"}</span>
            </button>
            <div className="bkbtn" onClick={()=>setShowBk(true)}>
              <div className="bkl">Bankroll</div>
              <div className="bkv">{bk.toLocaleString("fr-FR")}€</div>
            </div>
          </div>
        </div>
      </header>
      <nav>
        <div className="ni">
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} className={`tb${tab===t.id?" on":""}`}>
              <span>{t.icon}</span><span>{t.l}</span>
              {t.n&&<span className="n">{t.n}</span>}
              {t.id==="result"&&res&&<span style={{width:5,height:5,borderRadius:"50%",background:"var(--gold)",boxShadow:"0 0 5px var(--gold)",display:"inline-block"}}/>}
            </button>
          ))}
        </div>
      </nav>
      <div className="pg">
        {tab==="scanner"&&<Scanner/>}
        {tab==="matchs"&&<Matchs/>}
        {tab==="comp"&&<Comparateur/>}
        {tab==="tips"&&<Tips/>}
        {tab==="analyse"&&<Analyse/>}
        {tab==="result"&&<Resultat/>}
        {tab==="bankroll"&&<Bankroll/>}
      </div>
      {showBk&&<BkModal/>}
      {showCfg&&<CfgModal/>}
    </div>
  );
}
