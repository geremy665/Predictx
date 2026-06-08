// EDGE — api/scan.js v8 — Fast first, then enrich
function toNum(val, dec) {
  if(val===null||val===undefined||isNaN(+val)) return 0;
  return Math.round(+val * Math.pow(10, dec||3)) / Math.pow(10, dec||3);
}

const LEAGUES = new Set([61,140,39,135,78,2,3,94,88,144,203,179,848,113,200,10,667,4,5,6,7,9,15,1,34]);
const FLAG={61:"FR",140:"ES",39:"ENG",135:"IT",78:"DE",2:"UCL",3:"UEL",94:"PT",88:"NL",144:"BE",203:"TR",179:"SCO",848:"UECL",113:"SE",200:"MA",10:"INT",667:"AMI",4:"EUR",5:"UNL",6:"CAN",7:"ASI",9:"CAM",15:"WC",1:"WCQ",34:"WCQ"};
const LNAME={61:"Ligue 1",140:"La Liga",39:"Premier League",135:"Serie A",78:"Bundesliga",2:"Champions League",3:"Europa League",94:"Liga Portugal",88:"Eredivisie",144:"Pro League",203:"Süper Lig",179:"Premiership",848:"Conference League",113:"Allsvenskan",200:"Botola Pro",10:"Amicaux Nations",667:"Amicaux Clubs",4:"Euro",5:"UEFA Nations League",6:"Africa Cup",7:"Asian Cup",9:"Copa America",15:"Coupe du Monde",1:"Qualif. Mondial",34:"Qualif. Mondial"};
const DONE=new Set(["FT","AET","PEN","AWD","WO","ABD","CANC","SUSP","PST","TBD"]);
const LIVE=new Set(["1H","2H","HT","ET","BT","P","LIVE"]);

async function apiFetch(url, key, ms) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), ms||8000);
    const r = await fetch(`https://v3.football.api-sports.io${url}`, {
      headers:{"x-apisports-key":key,"Accept":"application/json"},
      signal:ctrl.signal
    });
    clearTimeout(t);
    if(!r.ok) return null;
    const d = await r.json();
    return d.response||null;
  } catch(e){ return null; }
}

async function getOdds(fId, key) {
  try {
    const data = await apiFetch(`/odds?fixture=${fId}`, key, 5000);
    if(!data?.length) return {};
    let r={}, sharp=false;
    const bks=[];
    for(const item of data) for(const bk of (item.bookmakers||[])) bks.push(bk);
    bks.sort((a,b)=>{const ia=[8,6,1,2,3].indexOf(a.id),ib=[8,6,1,2,3].indexOf(b.id);return(ia<0?99:ia)-(ib<0?99:ib);});
    for(const bk of bks){
      const bets=bk.bets||[];
      const mw=bets.find(b=>b.id===1||b.name==="Match Winner");
      if(mw?.values?.length>=3&&!r.o1){
        const h=mw.values.find(v=>v.value==="Home"),d=mw.values.find(v=>v.value==="Draw"),a=mw.values.find(v=>v.value==="Away");
        if(h&&d&&a){r.o1=+h.odd;r.on=+d.odd;r.o2=+a.odd;r.pinnacle=bk.id===8;if(r.pinnacle)sharp=true;}
      }
      const ou=bets.find(b=>b.id===3||b.name==="Goals Over/Under");
      if(ou?.values) ou.values.forEach(v=>{const m=v.value.match(/(Over|Under)\s+([\d.]+)/i);if(m){const k=(m[1].toLowerCase()==="over"?"over":"under")+m[2].replace(".","_");if(!r[k])r[k]=+v.odd;}});
      const bt=bets.find(b=>b.id===5||b.name==="Both Teams Score");
      if(bt?.values&&!r.bttsY){const y=bt.values.find(v=>v.value==="Yes"),n=bt.values.find(v=>v.value==="No");if(y)r.bttsY=+y.odd;if(n)r.bttsN=+n.odd;}
      if(r.o1&&sharp) break;
    }
    return r;
  } catch(e){ return {}; }
}

function buildMatch(f, odds) {
  const st = f.fixture?.status?.short||"NS";
  const lgId = f.league?.id;
  const o={};
  const o1=odds?.o1||1.90, on=odds?.on||3.40, o2=odds?.o2||3.80;
  const mg=1/o1+1/on+1/o2;
  const mp1=(1/o1)/mg, mp2=(1/o2)/mg;
  const hxg=toNum(1.20+mp1*0.90,2);
  const axg=toNum(1.20+mp2*0.90,2);
  return {
    id:f.fixture?.id,
    leagueName:LNAME[lgId]||f.league?.name||"",
    leagueId:lgId,
    c:LNAME[lgId]||f.league?.name||"",
    f:FLAG[lgId]||"INT",
    league:"l"+lgId,
    home:f.teams?.home?.name||"", away:f.teams?.away?.name||"",
    h:f.teams?.home?.name||"",   a:f.teams?.away?.name||"",
    homeId:f.teams?.home?.id,    awayId:f.teams?.away?.id,
    time:f.fixture?.date||"",    t:f.fixture?.date||"",
    status:st, isLive:LIVE.has(st),
    goalsH:f.goals?.home??null,  goalsA:f.goals?.away??null,
    o1,on,o2,
    hasRealOdds:!!(odds?.o1), hasPinnacle:!!(odds?.pinnacle),
    dc1x:odds?.dc1x||null, dc12:odds?.dc12||null, dcx2:odds?.dcx2||null,
    over25:odds?.over2_5||null, under25:odds?.under2_5||null,
    over35:odds?.over3_5||null, over15:odds?.over1_5||null,
    bttsY:odds?.bttsY||null, bttsN:odds?.bttsN||null,
    hxg,axg,
    hxga:toNum(axg*0.85,2), axga:toNum(hxg*0.85,2),
    hg:toNum(hxg*0.90,2),   ag:toNum(axg*0.90,2),
    hsh:Math.round(hxg*2.9),ash:Math.round(axg*2.9),
    hf:Math.round(mp1*15),  af:Math.round(mp2*15),
    hcs:Math.round(mp1*30), acs:Math.round(mp2*30),
    hFormScore:toNum(mp1*0.8,3), aFormScore:toNum(mp2*0.8,3),
    hWinRate:toNum(mp1*0.9,3),   aWinRate:toNum(mp2*0.9,3),
    hMatchesPlayed:10, aMatchesPlayed:10,
    hForm:"", aForm:"",
    h2h:[], dataQuality:"odds_derived",
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Cache-Control","s-maxage=180,stale-while-revalidate=300");
  if(req.method==="OPTIONS") return res.status(200).end();

  const KEY=process.env.FOOTBALL_API_KEY||"";
  if(!KEY) return res.status(200).json({matches:[],error:"no_key"});

  try {
    const now=new Date();
    // Fetch today + tomorrow only for speed
    const days=[0,1,2,3].map(i=>new Date(now.getTime()+i*86400000).toISOString().split("T")[0]);

    const results = await Promise.all(days.map(d=>apiFetch(`/fixtures?date=${d}`,KEY,6000)));
    const all = results.flat().filter(Boolean)
      .filter(f=>LEAGUES.has(f.league?.id))
      .filter(f=>!DONE.has(f.fixture?.status?.short||"NS"));

    const fixtures = all.slice(0,20);
    const today=days[0], tomorrow=days[1];

    // Fetch odds only for today + tomorrow matches
    const oddsArr = await Promise.all(fixtures.map(f=>{
      const d=f.fixture?.date?.split("T")[0];
      const st=f.fixture?.status?.short||"NS";
      if(LIVE.has(st)||!(d===today||d===tomorrow)) return Promise.resolve({});
      return getOdds(f.fixture?.id,KEY);
    }));

    const matches = fixtures.map((f,i)=>buildMatch(f,oddsArr[i]));

    matches.sort((a,b)=>{
      if(a.isLive&&!b.isLive) return -1;
      if(!a.isLive&&b.isLive) return 1;
      return (a.time||"")<(b.time||"")?-1:1;
    });

    return res.status(200).json({
      matches,
      count:matches.length,
      withOdds:matches.filter(m=>m.hasRealOdds).length,
      withPinnacle:matches.filter(m=>m.hasPinnacle).length,
      updated:now.toISOString(),
      source:"EDGE Scan v8",
    });
  } catch(e){
    return res.status(200).json({matches:[],error:e.message});
  }
};
