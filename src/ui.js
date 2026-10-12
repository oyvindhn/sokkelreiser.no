/* Sokkelreiser UI — state, Sodir client, chart engine, views. */
(function(){
"use strict";
const C=window.OK;
const $=id=>document.getElementById(id);
const h=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ================= storage (browser only) ================= */
const PFX="sokkelreise:";
try{ // flytt data lagret under det gamle navnet (Offshorekart)
  if(!Object.keys(localStorage).some(k=>k.startsWith(PFX)))
    for(const k of Object.keys(localStorage))if(k.startsWith("okart:")){localStorage.setItem(PFX+k.slice(6),localStorage.getItem(k));localStorage.removeItem(k)}
}catch(_){}
const store={
  get(k,d){try{const v=localStorage.getItem(PFX+k);return v?JSON.parse(v):d}catch(_){return d}},
  set(k,v){try{localStorage.setItem(PFX+k,JSON.stringify(v));return true}catch(_){return false}},
  del(k){try{localStorage.removeItem(PFX+k)}catch(_){}},
  keys(){try{return Object.keys(localStorage).filter(k=>k.startsWith(PFX)).map(k=>k.slice(PFX.length))}catch(_){return []}}
};

/* ================= state ================= */
const S={
  legs:store.get("legs",[]),
  sourceName:store.get("sourceName",""),
  places:store.get("places",{}),          // key -> {key,raw,label,kind,link,auto,rows,guess}
  manual:store.get("manual",[]),          // manual stays
  overrides:store.get("overrides",{}),
  accepted:store.get("accepted",{}),
  flotelAt:store.get("flotelAt",{}),      // stayId -> {felt,inst}: brukeren har oppgitt hvor flotellen lå      // stayId -> true: opphold over 5 uker som brukeren har godtatt    // stayId -> {lat,lon,label}
  ui:{tab:"stays",year:null,sel:null,rig:null,rigDate:"",rigSel:null,openPlace:null,pick:null},
};
function persist(){
  store.set("legs",S.legs);store.set("sourceName",S.sourceName);store.set("places",S.places);
  store.set("manual",S.manual);store.set("overrides",S.overrides);store.set("accepted",S.accepted);store.set("flotelAt",S.flotelAt);
}

/* ================= Sodir data ================= */
const SODIR="https://factmaps.sodir.no/api/rest/services/DataService/Data/FeatureServer/";
const FAC_FIELDS="fclNpdidFacility,fclName,fclKind,fclFixedOrMoveable,fclPhase,fclFunctions,fclBelongsToName,fclCurrentOperatorName,fclCurrentRespCompanyName,fclFactPageUrl";
const WB_FIELDS="wlbWellboreName,wlbWell,wlbEntryDate,wlbCompletionDate,wlbField,wlbDiscovery,wlbPurpose,wlbWellType,wlbStatus,wlbContent,wlbWaterDepth,wlbMainArea,wlbFactPageUrl,wlbDrillingFacility,fclNpdidFacilityDrilling,wlbDrillingFacilityFixedOrMove,wlbFacilityTypeDrilling,wlbNsDecDeg,wlbEwDecDeg";
const CACHE_DAYS=14;
const D={
  status:"none",       // none | loading | live | cache | file | err
  stamp:null,
  facilities:[],facById:new Map(),
  fileWellbores:null,  // Map facId -> [wb] when loaded from a Sodir file
  wellbores:new Map(), // facId -> [wb]
  timelines:new Map(), // facId -> timeline
  aliases:new Map(),   // facId -> tidligere navn (fra Sodirs brønnregister)
  activity:null,       // facId -> perioder riggen boret (brukes til automatisk kobling)
  idf:null,
  pending:new Map(),
};
async function arcQuery(layer,params){
  const all=[];let offset=0;
  for(let guard=0;guard<40;guard++){
    const u=new URL(SODIR+layer+"/query");
    const p={f:"json",outSR:"4326",resultOffset:offset,resultRecordCount:2000,...params};
    for(const k in p)u.searchParams.set(k,p[k]);
    const r=await fetch(u.toString(),{mode:"cors"});
    if(!r.ok)throw new Error("Sodir svarte "+r.status);
    const j=await r.json();
    if(j.error)throw new Error(j.error.message||"Sodir-feil");
    const f=j.features||[];all.push(...f);
    if(!j.exceededTransferLimit||!f.length)break;
    offset+=f.length;
  }
  return all;
}
function setFacilities(list,status,stamp){
  D.facilities=list.filter(f=>f.name);D.facById=new Map(D.facilities.map(f=>[f.id,f]));
  D.idf=C.buildIdf(D.facilities.map(f=>f.name));
  D.status=status;D.stamp=stamp||null;renderSource();
}
function namesOf(f){return [f.name,...(D.aliases.get(f.id)||[])]}
/* Tidligere navn: Sodir registrerer navnet riggen hadde da brønnen ble boret. Henter alle forskjellige navn i ett kall. */
async function loadAliases(force){
  try{
    let list=null;const cached=store.get("sodir:alias",null);
    if(!force&&cached&&Date.now()-cached.ts<CACHE_DAYS*864e5)list=cached.list;
    else{
      const feats=await arcQuery(5000,{where:"wlbDrillingFacility IS NOT NULL",outFields:"wlbDrillingFacility,fclNpdidFacilityDrilling",returnDistinctValues:"true",returnGeometry:"false"});
      list=feats.map(f=>f.attributes||{}).filter(a=>a.wlbDrillingFacility&&a.fclNpdidFacilityDrilling!=null).map(a=>[String(a.fclNpdidFacilityDrilling),C.clean(a.wlbDrillingFacility)]);
      if(list.length)store.set("sodir:alias",{ts:Date.now(),list});
    }
    const m=new Map();
    for(const [id,name] of list||[]){
      const f=D.facById.get(id);if(!f||C.normName(f.name)===C.normName(name))continue;
      if(!m.has(id))m.set(id,[]);if(!m.get(id).some(n=>C.normName(n)===C.normName(name)))m.get(id).push(name);
    }
    D.aliases=m;return m.size;
  }catch(e){console.warn("Sodir tidligere navn",e);return 0}
}
/* Når boret hver rigg? Ett samlet kall for perioden loggen dekker. Brukes til å skille rigger med like koder. */
const num=v=>v==null||v===""||isNaN(+v)?null:+v;
function firstLegYear(){let y=9999;for(const l of S.legs)if(l.date)y=Math.min(y,+l.date.slice(0,4));return y===9999?null:y}
async function loadActivity(force){
  const y0=firstLegYear();if(!y0)return false;const from=y0-1;
  try{
    let rows=null;const cached=store.get("sodir:act",null);
    if(!force&&cached&&cached.v===2&&cached.from<=from&&Date.now()-cached.ts<CACHE_DAYS*864e5)rows=cached.rows;
    else{
      const q=where=>arcQuery(5000,{where,outFields:"fclNpdidFacilityDrilling,wlbEntryDate,wlbCompletionDate,wlbNsDecDeg,wlbEwDecDeg",returnGeometry:"false"});
      let feats;
      try{feats=await q(`fclNpdidFacilityDrilling IS NOT NULL AND wlbEntryDate >= DATE '${from}-01-01'`)}
      catch(_){feats=await q("fclNpdidFacilityDrilling IS NOT NULL")}
      rows=feats.map(f=>f.attributes||{}).map(a=>[String(a.fclNpdidFacilityDrilling),C.parseDate(a.wlbEntryDate),C.parseDate(a.wlbCompletionDate),num(a.wlbNsDecDeg),num(a.wlbEwDecDeg)]).filter(r=>r[1]&&r[1]>=from+"-01-01");
      if(rows.length)try{store.set("sodir:act",{v:2,ts:Date.now(),from,rows})}catch(_){}
    }
    D.activity=C.activityByFacility(rows.map(([id,entry,comp])=>({id,entry,comp})));
    D.actRows=new Map();
    for(const [id,entry,comp,lat,lon] of rows){if(lat==null||lon==null)continue;if(!D.actRows.has(id))D.actRows.set(id,[]);D.actRows.get(id).push({s:C.toDay(entry),e:comp?C.toDay(comp):C.toDay(entry)+60,lat,lon})}
    return true;
  }catch(e){console.warn("Sodir boreaktivitet",e);return false}
}
/* Prospektnavn fra Sodirs brønnhistorikk (tabell 5050, fritekst). Bare for brønner du faktisk har vært ved, ett kall, lagres i 14 dager. */
async function loadProspects(sites){
  const todo=new Map();   // npdid -> [site]
  for(const s of sites){
    if(s.prospect!==undefined)continue;   // allerede vurdert (navn eller null)
    const ids=s.wells.slice(0,4).map(w=>w.npdid).filter(Boolean);
    if(!ids.length){s.prospect=null;continue}
    let found=null,missing=[];
    for(const id of ids){const c=store.get("sodir:pros:"+id,null);if(c&&Date.now()-c.ts<CACHE_DAYS*864e5){if(c.name&&!found)found=c}else missing.push(id)}
    if(found){s.prospect=found.name;s.prospectText=found.sentence;C.nameSite(s);continue}
    if(!missing.length){s.prospect=null;continue}
    for(const id of missing){if(!todo.has(id))todo.set(id,[]);todo.get(id).push(s)}
    s.prospect=undefined;
  }
  if(!todo.size)return false;
  let changed=false;
  try{
    const ids=[...todo.keys()];
    for(let i=0;i<ids.length;i+=40){
      const part=ids.slice(i,i+40);
      const feats=await arcQuery(5050,{where:`wlbNpdidWellbore IN (${part.join(",")})`,outFields:"wlbNpdidWellbore,wlbHistory",returnGeometry:"false"});
      const got=new Map();for(const f of feats){const a=f.attributes||{};got.set(String(a.wlbNpdidWellbore),C.prospectFromHistory(a.wlbHistory))}
      for(const id of part){
        const r=got.get(id)||null;
        try{store.set("sodir:pros:"+id,{ts:Date.now(),name:r?r.name:"",sentence:r?r.sentence:""})}catch(_){}
        for(const s of todo.get(id)){if(r&&!s.prospect){s.prospect=r.name;s.prospectText=r.sentence;C.nameSite(s);changed=true}}
      }
    }
  }catch(e){console.warn("Sodir brønnhistorikk",e);for(const l of todo.values())for(const s of l)if(s.prospect===undefined)s.prospect=null;return changed}
  for(const l of todo.values())for(const s of l)if(s.prospect===undefined)s.prospect=null;
  return changed;
}
async function loadFacilities(force){
  const cached=store.get("sodir:fac",null);
  if(!force&&cached&&Date.now()-cached.ts<CACHE_DAYS*864e5){setFacilities(cached.list,"cache",cached.ts);return true}
  D.status="loading";renderSource();
  try{
    const feats=await arcQuery(6000,{where:"fclSurface='Y' OR fclFixedOrMoveable='MOVEABLE'",outFields:FAC_FIELDS,returnGeometry:"true"});
    const list=feats.map(f=>C.normFacility(f.attributes||{},f.geometry));
    if(!list.length)throw new Error("Tomt svar");
    store.set("sodir:fac",{ts:Date.now(),list});
    setFacilities(list,"live",Date.now());
    if(force){for(const k of store.keys())if(k.startsWith("sodir:wb")||k.startsWith("sodir:pros:")||k==="sodir:alias")store.del(k);D.wellbores.clear();D.timelines.clear()}
    return true;
  }catch(e){
    console.warn("Sodir facilities",e);
    if(cached){setFacilities(cached.list,"cache",cached.ts);toast("Fikk ikke kontakt med Sodir. Bruker lagret kopi.");return true}
    if(D.fileWellbores){D.status="file";renderSource();return true}
    D.status="err";renderSource();return false;
  }
}
async function getWellbores(facId){
  if(D.wellbores.has(facId))return D.wellbores.get(facId);
  if(D.fileWellbores){const l=D.fileWellbores.get(facId)||[];D.wellbores.set(facId,l);return l}
  const cached=store.get("sodir:wb2:"+facId,null);
  if(cached&&Date.now()-cached.ts<CACHE_DAYS*864e5){D.wellbores.set(facId,cached.list);return cached.list}
  if(D.pending.has(facId))return D.pending.get(facId);
  const fac=D.facById.get(facId);
  const where=/^\d+$/.test(facId)?`fclNpdidFacilityDrilling=${facId}`:`wlbDrillingFacility='${(fac?fac.name:"").replace(/'/g,"''")}'`;
  const q=fields=>arcQuery(5000,{where,outFields:fields,returnGeometry:"true",orderByFields:"wlbEntryDate"});
  const pr=q("*").catch(()=>q(WB_FIELDS))
    .then(feats=>{const list=feats.map(f=>C.normWellbore(f.attributes||{},f.geometry));store.set("sodir:wb2:"+facId,{ts:Date.now(),list});D.wellbores.set(facId,list);return list})
    .catch(e=>{console.warn("Sodir wellbores",e);if(cached){D.wellbores.set(facId,cached.list);return cached.list}return null})
    .finally(()=>D.pending.delete(facId));
  D.pending.set(facId,pr);return pr;
}
async function timelineFor(facId){
  if(D.timelines.has(facId))return D.timelines.get(facId);
  const wbs=await getWellbores(facId);if(!wbs)return null;
  const tl=C.rigTimeline(facId,wbs);D.timelines.set(facId,tl);return tl;
}
function ingestSodirFile(kind,headers,body){
  const objs=C.rowsToObjects(headers,body);
  if(kind==="sodir-facility"){
    const list=objs.map(o=>C.normFacility(o,null));
    const merged=new Map(D.facilities.map(f=>[f.id,f]));for(const f of list)merged.set(f.id,{...merged.get(f.id),...f});
    setFacilities([...merged.values()],D.fileWellbores?"file":(D.status==="live"||D.status==="cache"?D.status:"file"),Date.now());
    store.set("sodir:facfile",{ts:Date.now(),list});
    return `${list.length} innretninger`;
  }
  const wbs=objs.map(o=>C.normWellbore(o,null)).filter(w=>w.name);
  const by=D.fileWellbores||new Map();
  for(const w of wbs){if(!by.has(w.facilityId))by.set(w.facilityId,[]);by.get(w.facilityId).push(w)}
  D.fileWellbores=by;D.wellbores.clear();D.timelines.clear();
  // derive rigs we may not know yet
  const known=new Map(D.facilities.map(f=>[f.id,f]));
  for(const [id,l] of by){if(!known.has(id)&&l[0].facility)known.set(id,{id,name:l[0].facility,kind:l[0].facilityKind,moveable:l[0].moveable,lat:null,lon:null,url:""})}
  setFacilities([...known.values()],"file",Date.now());
  try{const compact=[];for(const l of by.values())compact.push(...l);store.set("sodir:wbfile",{ts:Date.now(),list:compact})}catch(_){}
  return `${wbs.length} brønnbaner`;
}
function restoreSodirFile(){
  const f=store.get("sodir:wbfile",null);
  if(f&&f.list){const by=new Map();for(const w of f.list){if(!by.has(w.facilityId))by.set(w.facilityId,[]);by.get(w.facilityId).push(w)}D.fileWellbores=by}
}

/* ================= places & matching ================= */
function syncPlaces(){
  const derived=C.derivePlaces(S.legs);
  const next={};
  // koder som flys direkte til/fra en kjent heliport, er installasjoner
  const nearPort=new Set();for(const l of S.legs){if(!l.from||!l.to)continue;if(C.heliport(l.from))nearPort.add(C.placeKey(l.to));if(C.heliport(l.to))nearPort.add(C.placeKey(l.from))}
  for(const d of derived){
    const old=S.places[d.key];
    const port=!!C.heliport(d.raw);   // kjent heliport er alltid en landbase
    const auto=port?"base":nearPort.has(d.key)?"installation":d.guess;
    const kind=old?(old.kindEdited?old.kind:(port||nearPort.has(d.key)?auto:old.kind)):auto;
    const autoLabel=kind==="installation"?(d.nameHint||d.raw):d.raw;
    next[d.key]=old?{...old,kind,link:kind==="base"?null:old.link,rows:d.rows,raw:d.raw,nameHint:d.nameHint,guess:d.guess,label:old.labelEdited?old.label:(kind==="installation"&&old.link&&old.link.type==="sodir"&&old.link.label?old.link.label:kind==="installation"&&old.link&&old.link.type==="sodir"&&D.facById.get(old.link.id)?C.titleCase(D.facById.get(old.link.id).name):kind==="installation"&&old.link&&old.link.type==="flotel"?C.titleCase(old.link.name):kind==="installation"&&old.link&&old.link.type==="follow"?old.label:autoLabel)}
                   :{key:d.key,raw:d.raw,label:autoLabel,nameHint:d.nameHint,kind,guess:d.guess,link:null,auto:false,rows:d.rows};
  }
  for(const m of S.manual){if(S.places[m.key])next[m.key]={...S.places[m.key],manualOnly:!next[m.key]}}
  for(const k in S.places)if(!next[k]&&(S.places[k].link||S.places[k].kind!==S.places[k].guess))next[k]={...S.places[k],rows:0};
  S.places=next;
}
function candidates(place,limit=6){
  const q=[place.nameHint,place.label,place.raw].filter(Boolean);
  const res=[];
  for(const f of D.facilities){
    if(!C.isFlyable(f))continue;   // ingen helidekk å lande på: kan aldri ha vært et reisemål
    let sc=0,via="";
    for(const nm of namesOf(f)){
      let s2=0;for(const s of q)s2=Math.max(s2,C.nameScore(s,nm),C.idfScore(s,nm,D.idf));
      s2=Math.max(s2,C.codeScore(place.raw,nm)*(f.moveable||f.phase==="IN SERVICE"?1:.9));
      if(s2>sc){sc=s2;via=nm===f.name?"":nm}
    }
    if(sc>=.45)res.push({f,sc,via});
  }
  res.sort((a,b)=>b.sc-a.sc||(a.f.phase==="IN SERVICE"?-1:1));
  return res.slice(0,limit);
}
/* Automatisk kobling. Navnet/koden gir kandidatene; datoene og naboene avgjør:
   - en flyttbar rigg som ikke boret noe sted da du var der, faller ut
   - en rigg som boret akkurat de periodene du var der, styrkes
   - ligger kandidaten nær en installasjon du fløy direkte til/fra, styrkes den */
function placePos(key,depth=0){
  const p=S.places[key];if(!p||!p.link||depth>3)return null;const l=p.link;
  if(l.type==="manual")return [l.lat,l.lon];
  if(l.type==="follow")return placePos(l.key,depth+1);
  const f=D.facById.get(l.id);return f&&!f.moveable&&f.lat!=null?[f.lat,f.lon]:null;
}
/* Hvor boret riggen da du var der? Posisjonen til brønnen nærmest i tid. */
function rigPosFor(id,stays){
  const rows=D.actRows&&D.actRows.get(id);if(!rows)return null;
  for(const st of stays){if(!st.start)continue;const a=C.toDay(st.start),b=C.toDay(st.end||st.start);
    const w=rows.find(r=>a<=r.e+21&&b>=r.s-21);if(w)return [w.lat,w.lon]}
  return null;
}
const isAccommodation=f=>/ACCOMMODATION|FLOTEL|BOLIG/i.test(f.kind+" "+f.functions)||/^FLOATEL\b/i.test(f.name);
/* Kandidater med bevis. sc = poeng, ev = antall uavhengige bevis (flytid, boreperiode, nabo).
   En kode som bare ligner et navn, kobles aldri uten minst ett bevis. */
function scoredCandidates(p,stays,neigh){
  const mine=stays.filter(s=>s.key===p.key);
  const nbKeys=[...((neigh.get(p.key))||new Map()).keys()];
  const near=nbKeys.map(k=>placePos(k)).filter(Boolean);
  const hints=C.flightHints(S.legs,p.key);
  return candidates(p,10).map(c=>{
    let sc=c.sc,ev=0;const f=c.f,name=c.sc>=.9;
    if(f.moveable&&D.activity&&mine.length){
      const fit=D.activity.has(f.id)?C.dateFit(D.activity.get(f.id),mine):0;
      if(fit>=.7){sc+=.12;ev++}
      else if(isAccommodation(f)){if(nbKeys.some(k=>S.places[k]&&S.places[k].link)){ev++}}   // boligrigg: borer aldri selv
      else if(fit<.3)sc-=name?.1:.4;   // rigg/fartøy som ikke boret noe sted da du var der
    }
    const pos=f.moveable?rigPosFor(f.id,mine):(f.lat!=null?[f.lat,f.lon]:null);
    const ff=C.flightFit(pos,hints);if(ff>0){sc+=.12;ev++}else if(ff<0)sc-=.35;
    if(near.length&&f.lat!=null&&!f.moveable){
      const d=Math.min(...near.map(q=>C.haversineKm(q,[f.lat,f.lon])));
      if(d<=40){sc+=.1;ev++}else if(d>=200)sc-=.2;
    }
    return {...c,sc,ev,name,lat:f.moveable?null:f.lat,lon:f.moveable?null:f.lon};
  }).sort((a,b)=>b.sc-a.sc||b.ev-a.ev||(a.f.phase==="IN SERVICE"?-1:1));
}
function autoLink(){
  if(!D.facilities.length)return 0;let n=0;
  // automatiske koblinger vurderes på nytt hver gang (bekreftede og manuelle røres ikke)
  for(const p of Object.values(S.places))if(p.auto&&p.link&&p.link.type==="sodir"){p.link=null;p.auto=false;if(!p.labelEdited)p.label=p.nameHint||p.raw}
  const stays=C.buildStays(S.legs,kindOf),neigh=C.neighbours(S.legs,kindOf);
  for(let pass=0;pass<3;pass++){   // nye koblinger gir naboer til neste runde
    let got=0;
    for(const p of Object.values(S.places)){
      if(p.kind!=="installation"||p.link)continue;
      const pick=C.pickAuto(scoredCandidates(p,stays,neigh));
      if(!pick||!(pick.name||pick.ev>0))continue;
      p.link={type:"sodir",id:pick.f.id};p.auto=true;if(!p.labelEdited)p.label=C.titleCase(pick.f.name);got++;
    }
    n+=got;if(!got)break;
  }
  return n;
}
let NEIGH=new Map();
/* Koblinger som kan deles: kode -> Sodir-navn, eller «ligger ved» en annen kode. Kun koder, aldri reiser. */
function koderPayload(){
  const koder={};
  for(const p of Object.values(S.places)){
    if(!p.link||p.kind!=="installation")continue;
    if(p.link.type==="sodir"){const f=D.facById.get(p.link.id);if(!f)continue;const e={navn:f.name,sodirId:f.id};
      if(p.link.label)e.visning=p.link.label;
      if(p.link.periods)e.perioder=p.link.periods.map(q=>({...(q.fra?{fra:q.fra}:{}),...(q.til?{til:q.til}:{}),navn:(D.facById.get(q.id)||{}).name,sodirId:q.id,visning:q.label}));
      koder[p.raw]=e}
    else if(p.link.type==="follow"){const o=S.places[p.link.key];if(!o)continue;
      const per=(p.link.periods||[]).map(q=>{const t=S.places[q.key];return t?{ved:t.raw,...(q.fra?{fra:q.fra}:{}),...(q.til?{til:q.til}:{})}:null}).filter(Boolean);
      koder[p.raw]={navn:p.label,ved:per.length?per:o.raw}}
  }
  return koder;
}
/* Kodeliste: koder som tidligere er koblet (koder.json ligger ved siden av siden og kan utvides). */
let CODES={};
async function loadCodeList(){try{const r=await fetch("koder.json",{cache:"no-cache"});if(!r.ok)return;const j=await r.json();CODES=(j&&j.koder)||{}}catch(_){}}
/* «SKARV» i kodelisten skal treffe «SKARV FPSO» hos Sodir. Faste og i drift foretrekkes. */
function looseName(navn){
  const n=C.normName(navn||"");if(!n)return null;
  const hits=D.facilities.filter(f=>C.isFlyable(f)).filter(f=>{const m=C.normName(f.name);return m.startsWith(n+" ")||m.endsWith(" "+n)});
  hits.sort((a,b)=>(a.moveable-b.moveable)||((b.phase==="IN SERVICE")-(a.phase==="IN SERVICE"))||a.name.length-b.name.length);
  return hits[0]||null;
}
/* Navn fra kodelisten -> Sodir-innretning: dagens navn, tidligere navn (fra brønnregisteret), så løsere treff.
   «MÆRSK INSPIRER» finner «INSPIRER», «DRAUPNER S» finner «DRAUPNER …» hvis Sodir skriver navnet annerledes. */
function facilityByCodeName(navn,sodirId){
  if(sodirId&&D.facById.get(String(sodirId)))return D.facById.get(String(sodirId));
  const n=C.normName(navn||"");if(!n)return null;
  let f=D.facilities.find(x=>C.normName(x.name)===n);if(f)return f;
  for(const [id,names] of D.aliases||[])if(names.some(a=>C.normName(a)===n)&&D.facById.get(id))return D.facById.get(id);
  f=looseName(n);if(f)return f;
  const suf=D.facilities.filter(x=>C.isFlyable(x)).filter(x=>{const m=C.normName(x.name);return m.length>=5&&n.endsWith(" "+m)});
  suf.sort((a,b)=>(a.moveable-b.moveable)||((b.phase==="IN SERVICE")-(a.phase==="IN SERVICE"))||b.name.length-a.name.length);
  if(suf[0])return suf[0];
  const w=n.split(" ");return w.length>1?looseName(w.slice(0,-1).join(" ")):null;
}
/* Kode med «perioder»: samme kode har vært ulike innretninger eller hatt ulike navn over tid. */
function codeLink(e){
  const per=(e.perioder||[]).map(q=>{const f=facilityByCodeName(q.navn||e.navn,q.sodirId);return f?{id:f.id,fra:q.fra||"",til:q.til||"",label:q.visning||C.titleCase(f.name)}:null}).filter(Boolean);
  const main=facilityByCodeName(e.navn,e.sodirId)||(per.length?D.facById.get(per[per.length-1].id):null);
  if(!main)return null;
  const link={type:"sodir",id:main.id};if(e.visning)link.label=e.visning;
  if(per.length)link.periods=per;
  return link;
}
function periodAt(l,date){return (l.periods||[]).find(q=>(!q.fra||date>=q.fra)&&(!q.til||date<=q.til))||null}
function linkIds(l){return l&&l.type==="sodir"?[l.id,...(l.periods||[]).map(q=>q.id)]:[]}
/* «ved» kan være «SKV» eller en liste [{ved:"SKV",fra:"2019-05-01",til:"2019-09-30"}, …] for boligrigger som flytter. */
function codeVed(e){const v=e&&e.ved;if(!v)return [];
  return (Array.isArray(v)?v:[{ved:v}]).map(x=>typeof x==="string"?{ved:x}:x).filter(x=>x&&x.ved).map(x=>({ved:x.ved,fra:x.fra||"",til:x.til||""}))}
function followTarget(l,date){
  if(!l.periods||!l.periods.length)return l.key;
  const q=l.periods.find(x=>(!x.fra||date>=x.fra)&&(!x.til||date<=x.til));return q?q.key:null}
/* ---------- floteller ---------- */
const FLOT=new Map(Object.entries(((window.FLOTELLER||{}).floteller)||{}).map(([k,v])=>[C.normName(k),{name:k,entries:v}]));
let EVID=new Map();   // flotellkode -> [{date,key}] fra hjemreiser fra flotellen etter utreise til en annen installasjon
function flotelOf(key){
  const p=S.places[key];if(!p)return null;
  const names=[(CODES[p.raw]||{}).navn,p.label,p.link&&p.link.type==="flotel"?p.link.name:"",p.link&&p.link.type==="sodir"?(D.facById.get(p.link.id)||{}).name:""];
  for(const n of names){const f=n&&FLOT.get(C.normName(n));if(f)return f}
  return null;
}
function facilityFor(e){
  if(!D.facilities.length)return null;
  const byN=n=>n&&facilityByCodeName(n);
  let f=byN(e.inst);
  if(!f&&e.felt){const c=D.facilities.filter(f=>!f.moveable&&f.lat!=null&&C.normName(f.belongsTo||"")===C.normName(e.felt));
    c.sort((a,b)=>((b.phase==="IN SERVICE")-(a.phase==="IN SERVICE"))||a.name.length-b.name.length);f=c[0]||byN(e.felt)}
  return f&&f.lat!=null?f:null;
}
function flotelSite(e){const f=facilityFor(e);return f?fixedSite(f):null}
function resolveFlotel(stay,key,fl){
  const T=C.titleCase(fl.name);
  const rep=S.flotelAt[stay.id];
  if(rep){const site=flotelSite(rep);if(site)return [{site,start:stay.start,end:stay.end,conf:"manuell",flotel:fl,note:`Du har oppgitt at ${T} lå ved ${C.titleCase(rep.felt)}.`}]}
  const bases=[];for(const l of stay.legs||[])for(const x of [l&&l.from,l&&l.to])if(x&&kindOf(C.placeKey(x))==="base")bases.push(x);
  const cands=C.flotelCandidates(fl.entries,stay.start,bases,e=>{const s=flotelSite(e);return s?[s.lat,s.lon]:null}).filter(c=>c.pos);
  // bevis: du fløy hjem fra flotellen etter utreise til en installasjon, eller skyttel mellom dem
  const ev=[];for(const x of EVID.get(key)||[])if(x.date>=C.addDays(stay.start,-3)&&x.date<=C.addDays(stay.end||stay.start,3)){const pp=placePos(x.key);if(pp)ev.push(pp)}
  for(const k of (NEIGH.get(key)||new Map()).keys()){const pp=placePos(k);if(pp)ev.push(pp)}
  const near=c=>ev.some(p=>C.haversineKm(p,c.pos)<=15);
  const proven=cands.filter(near);
  const pick=proven[0]||cands.slice().sort((a,b)=>(b.from||"").localeCompare(a.from||""))[0];
  if(!pick)return null;
  const site={...flotelSite(pick),flotelSource:pick.kilde,flotelUrl:pick.url};
  const conf=proven.length?"sikker":cands.length===1?"trolig":"usikker";
  const others=[...new Set(cands.filter(c=>c!==pick).map(c=>C.titleCase(c.felt)))];
  const note=`${T} lå ${conf==="sikker"?"":"trolig "}ved ${C.titleCase(pick.felt)}${proven.length?", og flyreisene dine bekrefter det":""}.`+(others.length?` Kan også ha vært ${others.join(" eller ")}.`:"")+(bases.length&&!proven.length?` Flyreisen fra ${[...new Set(bases)].join("/")} passer med feltet.`:"");
  return [{site,start:stay.start,end:stay.end,conf,flotel:fl,note}];
}
/* Hvor lå flotellen da? Svarene brukeren har gitt, som kan deles (felt og måned, aldri dato eller reise). */
function flotelReports(){
  const out=[];const seen=new Set();
  for(const s of STAYS){const r=S.flotelAt[s.id];const fl=flotelOf(s.key);if(!r||!fl)continue;
    const o={flotell:fl.name,felt:r.felt,maned:s.start.slice(0,7),kilde:"rapportert"};const k=JSON.stringify(o);if(!seen.has(k)){seen.add(k);out.push(o)}}
  for(const [key,list] of EVID){const fl=flotelOf(key);if(!fl)continue;
    for(const x of list){const site=placePos(x.key);const p=S.places[x.key];if(!site||!p)continue;
      const o={flotell:fl.name,felt:p.label,maned:x.date.slice(0,7),kilde:"hjemreise fra flotell"};const k=JSON.stringify(o);if(!seen.has(k)){seen.add(k);out.push(o)}}}
  return out;
}
function applyCodeList(){
  if(!D.facilities.length)return 0;let n=0;
  // Kodelisten kan oppdateres: koblinger den selv har laget, legges på nytt. Det brukeren har valgt selv, røres ikke.
  const todo=p=>p&&(!p.link||p.auto||p.byCode)&&!(p.kindEdited&&p.kind==="base");
  for(const k in CODES){   // 1. koblinger til Sodir
    const p=S.places[C.placeKey(k)];if(!p)continue;
    const e=CODES[k]||{};if(codeVed(e).length&&!e.sodirId)continue;
    const link=codeLink(e);
    // eldre lagrede koblinger fra kodelisten (før byCode fantes): oppgrader hvis de peker på samme innretning
    const legacy=p.byCode===undefined&&p.link&&p.link.type==="sodir"&&!p.auto&&link&&linkIds(link).includes(p.link.id);
    if(!todo(p)&&!legacy)continue;
    if(!link){if(FLOT.has(C.normName(e.navn||""))){const was=JSON.stringify(p.link);p.link={type:"flotel",name:e.navn};p.auto=false;p.byCode=true;p.kind="installation";if(!p.labelEdited)p.label=C.titleCase(e.navn);if(was!==JSON.stringify(p.link))n++}continue}
    const was=JSON.stringify(p.link);
    p.link=link;p.auto=false;p.byCode=true;p.kind="installation";if(!p.labelEdited)p.label=link.label||C.titleCase(D.facById.get(link.id).name);
    if(was!==JSON.stringify(link))n++;
  }
  for(const k in CODES){   // 2. «ligger ved»: boligrigg uten egen posisjon
    const p=S.places[C.placeKey(k)],e=CODES[k]||{},vs=codeVed(e);if(!vs.length||!todo(p))continue;
    const periods=vs.map(v=>({key:C.placeKey(v.ved),fra:v.fra,til:v.til})).filter(v=>{const t=S.places[v.key];return t&&t.link&&t.key!==p.key});
    if(!periods.length)continue;
    p.link=periods.length===1&&!periods[0].fra&&!periods[0].til?{type:"follow",key:periods[0].key}:{type:"follow",key:periods[0].key,periods};p.auto=false;p.kind="installation";if(!p.labelEdited)p.label=e.navn?C.titleCase(e.navn):p.raw;n++;
  }
  return n;
}
function kindOf(key){const p=S.places[key];return p?p.kind:"base"}
function placeLinkText(p){
  const l=p.link;if(!l)return p.kind==="base"?"Landbase / heliport":"Ikke koblet";
  if(l.type==="sodir"){const f=D.facById.get(l.id);return f?`${C.titleCase(f.name)} · ${f.moveable?"flyttbar":"fast"}`:"Sodir-innretning (ikke lastet)"}
  if(l.type==="manual")return `Manuell posisjon ${fmtPos(l.lat,l.lon)}`;
  if(l.type==="follow"){const o=S.places[l.key];return `Følger ${o?o.label:l.key}`}
  if(l.type==="flotel")return "Flotell · plassering fra flotellregisteret";
  return "";
}

/* ================= stays & resolution ================= */
let STAYS=[];      // resolved stays
function allStays(){
  const s=C.buildStays(S.legs,kindOf);
  for(const m of S.manual){s.push({key:m.key,start:m.start,end:m.end,startKnown:true,endKnown:true,legs:[],days:Math.max(0,C.diffDays(m.start,m.end)),id:m.id,manual:true,long:false})}
  s.sort((a,b)=>a.start<b.start?-1:a.start>b.start?1:0);
  return s;
}
/* Blokknummer for et felt: det vanligste blant feltets brønner (ett kall per felt, lagres i 14 dager). */
const FB=new Map();
async function fieldBlock(field){
  const k=C.normName(field);if(!k||FB.has(k))return FB.get(k);
  const c=store.get("sodir:fb:"+k,null);if(c&&Date.now()-c.ts<CACHE_DAYS*864e5){FB.set(k,c.b);return c.b}
  try{
    const feats=await arcQuery(5000,{where:`wlbField='${String(field).replace(/'/g,"''")}'`,outFields:"wlbWellboreName",returnGeometry:"false"});
    const n=new Map();for(const ft of feats){const m=/^(\d+\/\d+)/.exec((ft.attributes||{}).wlbWellboreName||"");if(m)n.set(m[1],(n.get(m[1])||0)+1)}
    const b=[...n.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||"";FB.set(k,b);store.set("sodir:fb:"+k,{ts:Date.now(),b});return b;
  }catch(e){FB.set(k,"");return ""}
}
function fixedSite(f){
  const blk=f.belongsTo?FB.get(C.normName(f.belongsTo))||"":"";
  const place=f.belongsTo?C.fieldWord(f.belongsTo)+(blk?" – "+blk:""):"";
  return {id:"F"+f.id,lat:f.lat,lon:f.lon,name:C.titleCase(f.name),place,sub:f.kind?C.titleCase(f.kind):"",kind:"fixed",facilityId:f.id,url:f.url}}
/* Innretninger Sodir regner som faste, men som kan flyttes (f.eks. Mærsk Inspirer: Volve, så Yme). */
// NB: «JACK-UP», ikke «JACKET», som er faste stålplattformer
const MOVABLE_KIND=/JACK-?UP|MOPU|SEMISUB|VESSEL|SHIP|DRILL/i,FLOATING_KIND=/FPSO|FSO|FPU/i;
function hasHistory(f){return MOVABLE_KIND.test(f.kind)||FLOATING_KIND.test(f.kind)||!!(D.actRows&&D.actRows.has(f.id))}
async function prefetchForStays(stays){
  const ids=new Set();
  const want=(key,depth=0)=>{const p=S.places[key];if(!p||!p.link||depth>3)return;if(p.link.type==="sodir"){for(const id of linkIds(p.link)){const f=D.facById.get(id);if(f&&(f.moveable||hasHistory(f)))ids.add(f.id)}}if(p.link.type==="follow"){want(p.link.key,depth+1);for(const q of p.link.periods||[])want(q.key,depth+1)}};
  for(const s of stays)want(s.key);
  const fields=new Set();for(const p of Object.values(S.places))for(const id of linkIds(p.link)){const f=D.facById.get(id);if(f&&!f.moveable&&f.belongsTo)fields.add(f.belongsTo)}
  await Promise.all([...[...ids].map(id=>timelineFor(id)),...[...fields].map(fieldBlock)]);
}
function resolveStay(stay,key=stay.key,depth=0,facId){
  const ov=S.overrides[stay.id];
  if(ov&&depth===0)return [{site:{id:"O:"+stay.id,lat:ov.lat,lon:ov.lon,name:ov.label||labelOf(stay.key),kind:"manual"},start:stay.start,end:stay.end,conf:"manuell",note:"Posisjon satt manuelt for denne turen."}];
  if(depth===0&&!(S.places[key]&&S.places[key].link&&S.places[key].link.type==="follow")){const fl=flotelOf(key);if(fl){const r=resolveFlotel(stay,key,fl);if(r)return r}}
  if(stay.turnback&&depth===0)return [{site:null,start:stay.start,end:stay.end,conf:"avbrutt",note:`Helikopteret returnerte til ${stay.legs[0].from} uten å lande offshore (trolig vær). Ingen overnatting.`}];
  const p=S.places[key];
  if(p&&p.link&&p.link.type==="flotel")return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",flotel:flotelOf(key),note:"Flotellregisteret har ingen kjent plassering som passer med datoen og heliporten. Velg hvor du var under."}];
  if(!p||!p.link)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:"Installasjonen er ikke koblet til Sodir eller en posisjon ennå."}];
  const l=p.link;
  if(l.type==="manual")return [{site:{id:"P:"+key,lat:l.lat,lon:l.lon,name:p.label,kind:"manual"},start:stay.start,end:stay.end,conf:"manuell",note:"Fast posisjon du har satt for installasjonen."}];
  if(l.type==="follow"){
    if(depth>3)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:"Koblingen går i ring."}];
    const tk=followTarget(l,stay.start);
    if(!tk)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:"Ingen kjent plassering for denne boligriggen på denne datoen."}];
    return resolveStay(stay,tk,depth+1).map(s=>({...s,note:`Lå ved ${labelOf(tk)}. `+s.note}));
  }
  if(!facId&&l.periods&&l.periods.length){
    // samme kode, ulike innretninger eller navn over tid (f.eks. Mærsk Inspirer på Volve, senere Yme Inspirer)
    const per=periodAt(l,stay.start);
    if(per)return resolveStay(stay,key,depth,per.id).map(g=>g.site?{...g,thenName:per.label,site:g.site.kind==='fixed'&&per.label?{...g.site,name:per.label}:g.site}:g);
  }
  const f=D.facById.get(facId||l.id);
  if(!f)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:D.status==="err"?"Sodir-data er ikke tilgjengelig.":"Laster Sodir-data …"}];
  if(f.moveable){
    const tl=D.timelines.get(f.id);
    if(!tl)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:D.pending.has(f.id)?"Henter riggens brønnhistorikk …":"Fant ikke riggens brønnhistorikk hos Sodir."}];
    if(!tl.visits.length&&depth===0){
      // boligrigg uten egne brønner: bruk installasjonen du fløy direkte til/fra
      const nb=[...(NEIGH.get(key)||new Map()).entries()].sort((a,b)=>b[1]-a[1]).map(e=>e[0]).find(k=>S.places[k]&&S.places[k].link);
      if(nb){const r=resolveStay(stay,nb,depth+1);if(r.some(s=>s.site))return r.map(s=>({...s,conf:s.conf==="sikker"?"trolig":s.conf,note:`${C.titleCase(f.name)} har ingen egne brønner. Lå trolig ved ${labelOf(nb)}, som du fløy til og fra. `+s.note}))}
    }
    if(!tl.visits.length&&f.lat!=null)return [{site:fixedSite(f),start:stay.start,end:stay.end,conf:"usikker",note:"Riggen har ingen brønner hos Sodir. Viser sist registrerte posisjon."}];
    const thenName=C.nameAt(tl,stay.start);
    return C.locateOnRig(tl,stay.start,stay.end).map(s=>({...s,thenName,site:s.site?{...s.site,facilityName:f.name}:null,note:s.note}));
  }
  // «fast» innretning: har den boret brønner, viser brønnregisteret hvor den lå på den tiden
  const tl=D.timelines.get(f.id);
  if(tl&&tl.visits.length){
    const thenName=C.nameAt(tl,stay.start);
    const r=C.locateOnRig(tl,stay.start,stay.end);
    if(r.every(g=>g.site&&g.conf==="sikker"))return r.map(g=>({...g,thenName,site:{...g.site,facilityName:f.name,url:f.url},note:"Innretningen boret her i perioden."}));
    // mellom brønner: produksjonsenheten ligger der den sist boret, til den borer et annet sted
    let prev=null,next=null;for(const v of tl.visits){if(v.start<=stay.start)prev=v;else if(!next)next=v}
    const v=prev||next;
    if(v){const site=tl.siteById[v.site],far=f.lat!=null&&C.haversineKm([site.lat,site.lon],[f.lat,f.lon])>5;
      if(far||!prev)return [{site:{...site,facilityName:f.name,url:f.url},start:stay.start,end:stay.end,conf:prev?"trolig":"usikker",thenName,
        note:prev?`Innretningen boret sist her (${v.start.slice(0,4)}–${v.end.slice(0,4)}) og lå trolig her fortsatt. I dag ligger den et annet sted.`:`Første kjente brønn fra innretningen ble boret her i ${v.start.slice(0,4)}.`}];
      // boret her før turen og ligger her fortsatt i dag: har ikke flyttet seg i mellomtiden
      if(f.lat!=null)return [{site:{...fixedSite(f),facilityName:f.name},start:stay.start,end:stay.end,conf:"sikker",thenName,
        note:`Innretningen har ligget her siden den boret her i ${v.start.slice(0,4)}, og ligger her fortsatt.`}]}
  }
  if(f.lat==null)return [{site:null,start:stay.start,end:stay.end,conf:"ukjent",note:"Sodir har ingen posisjon for denne innretningen."}];
  if(MOVABLE_KIND.test(f.kind))return [{site:fixedSite(f),start:stay.start,end:stay.end,conf:"usikker",note:"Dagens posisjon. Innretningen kan flyttes, og Sodir har ingen brønner som viser hvor den lå da."}];
  return [{site:fixedSite(f),start:stay.start,end:stay.end,conf:"sikker",note:"Fast innretning."}];
}
function labelOf(key){const p=S.places[key];return p?p.label:key}
let recomputeSeq=0;
async function recompute(){
  const seq=++recomputeSeq;
  syncPlaces();
  NEIGH=C.neighbours(S.legs,kindOf);
  const stays=allStays();
  EVID=new Map();for(const s of stays)if(s.homeFrom){const k=C.placeKey(s.homeFrom);if(!EVID.has(k))EVID.set(k,[]);EVID.get(k).push({date:s.end,key:s.key})}
  STAYS=stays.map(s=>({...s,segs:resolveStay(s)}));
  renderAll();
  if(D.facilities.length){
    await prefetchForStays(stays);
    if(seq!==recomputeSeq)return;
    STAYS=stays.map(s=>({...s,segs:resolveStay(s)}));
    renderAll();
    const sites=[];for(const s of STAYS)for(const g of s.segs)if(g.site&&g.site.wells&&!sites.includes(g.site))sites.push(g.site);
    if(sites.length&&await loadProspects(sites)&&seq===recomputeSeq)renderAll();
  }
}

/* ================= formatting ================= */
function fmtPos(lat,lon){
  if(lat==null||lon==null)return "–";
  const f=(v,p,n)=>{const a=Math.abs(v),d=Math.floor(a),m=(a-d)*60;return `${d}°${m.toFixed(1).replace(".",",").padStart(4,"0")}′${v>=0?p:n}`};
  return f(lat,"N","S")+" "+f(lon,"Ø","V");
}
const CONF_TXT={sikker:"Sikker",trolig:"Trolig",usikker:"Usikker",ukjent:"Ukjent",manuell:"Manuell"};
const pill=c=>`<span class="pill ${c}">${CONF_TXT[c]||c}</span>`;
function plural(n,a,b){return n===1?a:b}
function toast(msg){const t=$("toast");t.textContent=msg;t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>t.hidden=true,3600)}

/* ================= chart engine ================= */
const LAND_RECT={s:55,n:72.5,w:-10,e:35};
const SEA_LABELS=[["NORDSJØEN",57.4,3.2],["NORSKEHAVET",67.2,3.5],["BARENTSHAVET",73.2,30],["SKAGERRAK",57.85,8.6],["SHETLAND",60.3,-1.3,1],["ATLANTERHAVET",59.5,-14]];
function wx(lon){return (lon+180)/360*256}
function wy(lat){const s=Math.sin(Math.max(-85,Math.min(85,lat))*Math.PI/180);return (0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*256}
function ilon(x){return x/256*360-180}
function ilat(y){const n=Math.PI-2*Math.PI*y/256;return 180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n)))}
class Chart{
  constructor(canvas){
    this.c=canvas;this.ctx=canvas.getContext("2d");this.cx=wx(4);this.cy=wy(61);this.z=4.6;
    this.items={markers:[],lines:[]};this.hits=[];this.pointers=new Map();this.cb={};
    const B=window.BASEMAP||{land:[],detail:[],borders:[]};
    const mk=(polys,close)=>{const p=new Path2D();for(const poly of polys){poly.forEach(([la,lo],i)=>i?p.lineTo(wx(lo),wy(la)):p.moveTo(wx(lo),wy(la)));if(close)p.closePath()}return p};
    this.pLand=mk(B.land,true);this.pDetail=mk(B.detail,true);this.pBorders=mk(B.borders,false);
    new ResizeObserver(()=>this.resize()).observe(canvas);this.resize();this.bind();
  }
  get s(){return Math.pow(2,this.z)}
  resize(){const r=this.c.getBoundingClientRect(),d=window.devicePixelRatio||1;this.W=r.width;this.H=r.height;this.dpr=d;this.c.width=Math.max(1,Math.round(r.width*d));this.c.height=Math.max(1,Math.round(r.height*d));this.draw()}
  toScreen(lat,lon){const s=this.s;return [(wx(lon)-this.cx)*s+this.W/2,(wy(lat)-this.cy)*s+this.H/2]}
  toGeo(x,y){const s=this.s;return [ilat((y-this.H/2)/s+this.cy),ilon((x-this.W/2)/s+this.cx)]}
  setItems(it){this.items=it;this.req()}
  req(){if(this.raf)return;this.raf=requestAnimationFrame(()=>{this.raf=0;this.draw()})}
  colors(){const cs=getComputedStyle(document.documentElement),g=n=>cs.getPropertyValue(n).trim();
    this.col={sea:g("--sea"),grid:g("--sea-grid"),land:g("--land"),coast:g("--coast"),border:g("--border-line"),ink:g("--ink"),muted:g("--muted"),accent:g("--accent"),halo:g("--label-halo"),trail:g("--trail"),route:g("--route"),panel:g("--panel"),mono:g("--f-mono"),body:g("--f-body")}}
  draw(){
    if(!this.W)return;if(!this.col)this.colors();
    const {ctx,dpr,W,H}=this,s=this.s,col=this.col;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=col.sea;ctx.fillRect(0,0,W,H);
    const tx=W/2-this.cx*s,ty=H/2-this.cy*s;
    const rx=wx(LAND_RECT.w),ry=wy(LAND_RECT.n),rw=wx(LAND_RECT.e)-rx,rh=wy(LAND_RECT.s)-ry;
    const lw=.9/s;
    ctx.save();ctx.setTransform(dpr*s,0,0,dpr*s,dpr*tx,dpr*ty);
    // coarse world outside the detailed Nordic box
    ctx.save();const outside=new Path2D();outside.rect(-10,-10,276,276);outside.rect(rx,ry,rw,rh);ctx.clip(outside,"evenodd");
    ctx.fillStyle=col.land;ctx.fill(this.pLand);ctx.strokeStyle=col.coast;ctx.lineWidth=lw;ctx.stroke(this.pLand);ctx.restore();
    // detailed Nordic coastline
    ctx.save();ctx.beginPath();ctx.rect(rx,ry,rw,rh);ctx.clip();ctx.fillStyle=col.land;ctx.fill(this.pDetail);ctx.restore();
    ctx.save();ctx.beginPath();const inset=.02;ctx.rect(rx-1,ry-1,rw+1-(wx(LAND_RECT.e)-wx(LAND_RECT.e-inset)),(wy(LAND_RECT.s+inset)-ry)+1);ctx.clip();
    ctx.strokeStyle=col.coast;ctx.lineWidth=lw;ctx.stroke(this.pDetail);
    ctx.setLineDash([3/s,2/s]);ctx.strokeStyle=col.border;ctx.lineWidth=.8/s;ctx.stroke(this.pBorders);ctx.setLineDash([]);ctx.restore();
    ctx.restore();
    this.drawGrid();this.drawSeaLabels();this.drawItems();
  }
  drawGrid(){
    const {ctx,W,H,col}=this;const [n,w]=this.toGeo(0,0),[sLat,e]=this.toGeo(W,H);
    const steps=[20,10,5,2,1,.5,.25];const pxPerDeg=this.s*256/360;
    const step=steps.find(st=>st*pxPerDeg<160&&st*pxPerDeg>=55)||steps.find(st=>st*pxPerDeg>=55)||.25;
    ctx.save();ctx.strokeStyle=col.grid;ctx.lineWidth=1;ctx.fillStyle=col.muted;ctx.font=`10px ${col.mono}`;
    ctx.beginPath();
    for(let lo=Math.ceil(w/step)*step;lo<=e;lo+=step){const [x]=this.toScreen(0,lo);ctx.moveTo(Math.round(x)+.5,0);ctx.lineTo(Math.round(x)+.5,H)}
    for(let la=Math.ceil(sLat/step)*step;la<=n;la+=step){const [,y]=this.toScreen(la,0);ctx.moveTo(0,Math.round(y)+.5);ctx.lineTo(W,Math.round(y)+.5)}
    ctx.stroke();ctx.globalAlpha=.85;
    const lab=v=>{const a=Math.abs(v);return (Number.isInteger(a)?a:a.toFixed(step<1?2:1).replace(".",","))+"°"};
    ctx.textBaseline="top";
    for(let lo=Math.ceil(w/step)*step;lo<=e;lo+=step){const [x]=this.toScreen(0,lo);if(x<60||x>W-60)continue;ctx.fillText(lab(lo)+(lo>=0?"Ø":"V"),x+3,H-16)}
    ctx.textBaseline="bottom";
    for(let la=Math.ceil(sLat/step)*step;la<=n;la+=step){const [,y]=this.toScreen(la,0);if(y<120||y>H-30)continue;ctx.fillText(lab(la)+"N",4,y-2)}
    ctx.restore();
  }
  drawSeaLabels(){
    const {ctx,col}=this;if(this.z<3.3)return;
    ctx.save();ctx.fillStyle=col.muted;ctx.globalAlpha=.55;ctx.textAlign="center";ctx.textBaseline="middle";
    for(const [t,la,lo,land] of SEA_LABELS){const [x,y]=this.toScreen(la,lo);ctx.font=`${land?"600 ":"italic 500 "}${this.z>6?13:11}px ${col.body}`;
      if("letterSpacing" in ctx)ctx.letterSpacing=land?"1px":"4px";ctx.fillText(t,x,y)}
    ctx.restore();
  }
  drawItems(){
    const {ctx,col}=this;const it=this.items;this.hits=[];
    ctx.save();
    // flyruter: buer som på et flykart, alltid samme bue begge veier
    for(const ln of (it.routes||[]).slice().sort((a,b)=>(a.hi?1:0)-(b.hi?1:0)||(a.dim?0:1)-(b.dim?0:1))){
      let [p1,p2]=ln.pts;if(p1[1]>p2[1]||(p1[1]===p2[1]&&p1[0]>p2[0]))[p1,p2]=[p2,p1];
      const [x1,y1]=this.toScreen(...p1),[x2,y2]=this.toScreen(...p2);const L=Math.hypot(x2-x1,y2-y1);if(L<2)continue;
      const k=Math.min(.18,40/Math.max(L,1)+.08),mx=(x1+x2)/2-(y2-y1)*k,my=(y1+y2)/2+(x2-x1)*k;
      ctx.beginPath();ctx.moveTo(x1,y1);ctx.quadraticCurveTo(mx,my,x2,y2);
      ctx.strokeStyle=ln.hi?col.accent:col.route;ctx.lineWidth=ln.hi?2.2:1.3;ctx.globalAlpha=ln.dim?.18:1;ctx.lineCap="round";ctx.stroke();ctx.globalAlpha=1;
    }
    for(const ln of it.lines||[]){
      if(ln.pts.length<2)continue;ctx.beginPath();
      ln.pts.forEach(([la,lo],i)=>{const [x,y]=this.toScreen(la,lo);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});
      ctx.strokeStyle=ln.hi?col.accent:col.trail;ctx.lineWidth=ln.hi?1.8:1.2;ctx.setLineDash([4,3.5]);ctx.globalAlpha=ln.dim?.35:1;ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    }
    const ms=(it.markers||[]).slice().sort((a,b)=>(a.sel?1:0)-(b.sel?1:0)||a.r-b.r);
    for(const m of ms){
      const [x,y]=this.toScreen(m.lat,m.lon);if(x<-30||y<-30||x>this.W+30||y>this.H+30)continue;
      const r=m.r;ctx.beginPath();ctx.globalAlpha=m.dim?.3:1;
      if(m.port){ctx.rect(x-r,y-r,r*2,r*2);ctx.fillStyle=col.ink;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle=col.panel;ctx.stroke()}
      else{
        if(m.fixed){const q=r*1.2;ctx.moveTo(x,y-q);ctx.lineTo(x+q*.95,y+q*.7);ctx.lineTo(x-q*.95,y+q*.7);ctx.closePath()}   // fast installasjon: trekant
        else ctx.arc(x,y,r,0,Math.PI*2);                                                                                  // flyttbar rigg: sirkel
        if(m.conf==="usikker"||m.conf==="ukjent"){ctx.fillStyle=col.halo;ctx.fill();ctx.setLineDash([2.5,2]);ctx.lineWidth=1.6;ctx.strokeStyle=m.muted?col.muted:col.accent;ctx.stroke();ctx.setLineDash([])}
        else{ctx.fillStyle=m.muted?col.muted:col.accent;ctx.fill();ctx.lineWidth=1.5;ctx.strokeStyle=col.panel;ctx.stroke()}
      }
      if(m.sel){ctx.beginPath();ctx.arc(x,y,r+5,0,Math.PI*2);ctx.lineWidth=2;ctx.strokeStyle=col.ink;ctx.stroke()}
      ctx.globalAlpha=1;
      this.hits.push({x,y,r:r+HIT_PAD,m});
    }
    // etiketter: kort kode (MGU, NIT) som standard; full tekst ved hover, på valgt punkt eller når «Fulle navn» er på
    const boxes=[];ctx.textBaseline="middle";const portFont=`500 10.5px ${col.mono}`,instFont=`600 11.5px ${col.body}`,tagFont=`600 11px ${col.mono}`;
    const full=m=>m.id===this.hoverId||m.sel||this.fullNames;
    const order=ms.slice().sort((a,b)=>(b.id===this.hoverId?1:0)-(a.id===this.hoverId?1:0)||(b.sel?1:0)-(a.sel?1:0)||(b.port?1:0)-(a.port?1:0)||(b.days||0)-(a.days||0));
    for(const m of order){
      const isFull=!m.port&&full(m),text=m.port?m.label:isFull?m.label:(m.short||m.label);
      if(!text||(m.dim&&!m.sel&&m.id!==this.hoverId))continue;
      if(!m.port&&!isFull&&this.z<4.2)continue;
      if(isFull&&this.z<5.2&&!m.sel&&m.id!==this.hoverId)continue;
      ctx.font=m.port?portFont:isFull?instFont:tagFont;const [x,y]=this.toScreen(m.lat,m.lon);
      const lines=isFull&&m.lines&&m.lines.length?m.lines:[text];
      const tw=Math.max(...lines.map(l=>ctx.measureText(l).width)),LH=15,bh=lines.length*LH+2;const bx=x+m.r+5,by=y-bh/2,bw=tw+8;
      const hot=m.id===this.hoverId;
      if(!hot&&boxes.some(b=>bx<b.x+b.w&&bx+bw>b.x&&by<b.y+b.h&&by+bh>b.y))continue;boxes.push({x:bx,y:by,w:bw,h:bh});
      ctx.fillStyle=col.halo;ctx.fillRect(bx-1,by,bw,bh);
      if(hot){ctx.strokeStyle=col.accent;ctx.lineWidth=1;ctx.strokeRect(bx-.5,by+.5,bw-1,bh-1)}
      lines.forEach((l,i)=>{ctx.fillStyle=m.dim?col.muted:(i>0&&lines.length>1?col.muted:col.ink);if(i===1&&lines.length>2)ctx.fillStyle=col.ink;ctx.fillText(l,bx+3,by+1+LH*i+LH/2)});
    }
    ctx.restore();
  }
  hit(x,y){let best=null,bd=1e9;for(const h of this.hits){const d=Math.hypot(h.x-x,h.y-y);if(d<=h.r&&d<bd){bd=d;best=h.m}}return best}
  zoomAt(f,x=this.W/2,y=this.H/2){const [la,lo]=this.toGeo(x,y);this.z=Math.max(1.6,Math.min(13,this.z+Math.log2(f)));const s=this.s;this.cx=wx(lo)-(x-this.W/2)/s;this.cy=wy(la)-(y-this.H/2)/s;this.req()}
  animateTo(cx,cy,z){
    const reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
    if(reduce){this.cx=cx;this.cy=cy;this.z=z;this.req();return}
    const a={cx:this.cx,cy:this.cy,z:this.z},t0=performance.now(),dur=520;cancelAnimationFrame(this.anim);
    const step=t=>{let k=Math.min(1,(t-t0)/dur);k=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;this.cx=a.cx+(cx-a.cx)*k;this.cy=a.cy+(cy-a.cy)*k;this.z=a.z+(z-a.z)*k;this.draw();if(k<1)this.anim=requestAnimationFrame(step)};
    this.anim=requestAnimationFrame(step);
  }
  fit(pts,maxZ=8.5){
    if(!pts.length)return;
    let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;for(const [la,lo] of pts){const x=wx(lo),y=wy(la);x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)}
    const inset=this.inset||0,pad=this.W<600?48:90,zw=Math.log2((this.W-pad*2)/Math.max(1e-6,x1-x0)),zh=Math.log2((this.H-inset-pad*2)/Math.max(1e-6,y1-y0));
    const z=Math.max(2,Math.min(maxZ,zw,zh));
    this.animateTo((x0+x1)/2,(y0+y1)/2+inset/2/Math.pow(2,z),z);
  }
  /* inset: hvor mange piksler nederst som dekkes av bunnarket på mobil. Punktet havner midt i det synlige kartet. */
  flyTo(lat,lon,z){z=z??Math.max(this.z,7);this.animateTo(wx(lon),wy(lat)+(this.inset||0)/2/Math.pow(2,z),z)}
  bind(){
    const c=this.c;let moved=false,last=null,pinch=null;
    c.addEventListener("pointerdown",e=>{c.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,[e.offsetX,e.offsetY]);moved=false;last=[e.offsetX,e.offsetY];
      if(this.pointers.size===2){const [a,b]=[...this.pointers.values()];pinch={d:Math.hypot(a[0]-b[0],a[1]-b[1])}}});
    c.addEventListener("pointermove",e=>{
      const p=[e.offsetX,e.offsetY];
      if(this.pointers.has(e.pointerId)){
        this.pointers.set(e.pointerId,p);
        if(this.pointers.size===2&&pinch){const [a,b]=[...this.pointers.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]);this.zoomAt(d/pinch.d,(a[0]+b[0])/2,(a[1]+b[1])/2);pinch.d=d;moved=true;return}
        const dx=p[0]-last[0],dy=p[1]-last[1];if(Math.abs(dx)+Math.abs(dy)>2||moved){moved=true;c.classList.add("dragging");this.cx-=dx/this.s;this.cy-=dy/this.s;last=p;this.req();this.cb.hover&&this.cb.hover(null,p)}
      }else{const m=this.hit(...p);this.cb.hover&&this.cb.hover(m,p,this.toGeo(...p))}
    });
    const up=e=>{const wasDown=this.pointers.has(e.pointerId);this.pointers.delete(e.pointerId);if(this.pointers.size<2)pinch=null;c.classList.remove("dragging");
      if(wasDown&&!moved&&e.type==="pointerup"){const p=[e.offsetX,e.offsetY];this.cb.click&&this.cb.click(this.hit(...p),this.toGeo(...p))}};
    c.addEventListener("pointerup",up);c.addEventListener("pointercancel",up);
    c.addEventListener("pointerleave",()=>this.cb.hover&&this.cb.hover(null,null));
    c.addEventListener("wheel",e=>{e.preventDefault();this.zoomAt(Math.exp(-e.deltaY*(e.deltaMode?0.05:0.0022)),e.offsetX,e.offsetY)},{passive:false});
    c.addEventListener("dblclick",e=>{e.preventDefault();this.zoomAt(2,e.offsetX,e.offsetY)});
  }
}

const HIT_PAD=matchMedia("(pointer:coarse)").matches?14:4;   // fingre trenger større treffflate enn mus

/* ================= map content ================= */
let chart;
/* Opphold over 5 uker teller ikke med i døgn før brukeren har godtatt dem. */
function countDays(s){return s.long&&!S.accepted[s.id]?0:s.days}
function inYear(s,y){return !y||(s.start.slice(0,4)<=String(y)&&s.end.slice(0,4)>=String(y))}
const MAPOPT=Object.assign({routes:true,drift:false,names:false},store.get("mapopt",{}));
const PIN=5.5;   // én størrelse for alle installasjoner
/* Hvor var en installasjon på en dato? Bruker oppholdet som dekker datoen. */
function siteAt(key,date){
  const p=S.places[key];if(!p)return null;
  if(p.kind==="base"){const hp=C.heliport(p.raw);return hp?{id:"H:"+key,lat:hp[0],lon:hp[1],name:p.raw,kind:"port"}:null}
  for(const st of STAYS){
    if(st.key!==key||date<st.start||date>(st.end||st.start))continue;
    const g=st.segs.find(g=>g.site&&g.start<=date&&date<=g.end)||st.segs.find(g=>g.site);
    if(g)return g.site;
  }
  if(flotelOf(key)){const legs=S.legs.filter(l=>l.date===date&&[l.from,l.to].some(x=>x&&C.placeKey(x)===key));const r=resolveStay({id:"x",key,start:date,end:date,legs},key,0);const g=r.find(g=>g.site);if(g)return g.site}
  return null;
}
function stayMapItems(){
  const y=S.ui.year;const agg=new Map();const lines=[];const rigSeq=new Map();
  const rank={sikker:4,manuell:3,trolig:2,usikker:1,ukjent:0};
  for(const st of STAYS){
    const dim=!inYear(st,y);
    for(const sg of st.segs){
      if(!sg.site)continue;
      const k=sg.site.id;if(!agg.has(k))agg.set(k,{site:sg.site,days:0,stays:new Set(),conf:"ukjent",dim:true,sel:false,rigs:new Map(),codes:new Map()});
      const a=agg.get(k);
      { // hvem lå her: riggens navn da (rigger) eller installasjonens navn (faste, boligrigger)
        const p=S.places[st.key],nm=sg.thenName?C.titleCase(sg.thenName):sg.site.kind==="fixed"&&p&&p.link&&p.link.type==="sodir"&&p.link.id===sg.site.facilityId?sg.site.name:p?p.label:st.key;
        if(!dim||!a.rigs.size)a.rigs.set(C.normName(nm),nm);
        const raw=p?p.raw:st.key;a.codes.set(C.normName(raw),raw);
      }if(!dim){a.days+=Math.max(1,C.diffDays(sg.start,sg.end));a.dim=false}a.stays.add(st.id);
      if(rank[sg.conf]>rank[a.conf])a.conf=sg.conf;
      if(S.ui.sel===st.id)a.sel=true;
      if(sg.site.kind==="mobile"&&!dim){const f=sg.site.facilityId;if(!rigSeq.has(f))rigSeq.set(f,[]);const arr=rigSeq.get(f);if(arr[arr.length-1]!==sg.site)arr.push(sg.site)}
    }
  }
  const selStay=STAYS.find(s=>s.id===S.ui.sel);
  if(MAPOPT.drift){
    const selFac=selStay&&selStay.segs.find(g=>g.site&&g.site.kind==="mobile")?.site.facilityId;
    for(const [f,arr] of rigSeq)if(arr.length>1)lines.push({pts:arr.map(s=>[s.lat,s.lon]),hi:f===selFac,dim:selFac&&f!==selFac});
  }
  // flyruter: én bue per strekning (heliport–installasjon og skytteltrafikk mellom installasjoner)
  const routes=new Map(),ports=new Map();
  if(MAPOPT.routes){
    for(const l of S.legs){
      if(l.cancelled||!l.from||!l.to||!l.date)continue;
      const a=siteAt(C.placeKey(l.from),l.date),b=siteAt(C.placeKey(l.to),l.date);
      if(!a||!b||a.id===b.id)continue;
      const dim=y&&l.date.slice(0,4)!==String(y);
      const hi=selStay&&l.date>=selStay.start&&l.date<=(selStay.end||selStay.start)&&[C.placeKey(l.from),C.placeKey(l.to)].includes(selStay.key);
      const k=[a.id,b.id].sort().join("|");
      const r=routes.get(k)||{pts:[[a.lat,a.lon],[b.lat,b.lon]],n:0,dim:true,hi:false};
      r.n++;if(!dim)r.dim=false;if(hi)r.hi=true;routes.set(k,r);
      for(const s of [a,b])if(s.kind==="port"){const pt=ports.get(s.id)||{site:s,n:0,dim:true};pt.n++;if(!dim)pt.dim=false;ports.set(s.id,pt)}
    }
  }
  // utvidet etikett i linjer: «Maersk Guardian» / «7/4-3 Brynhild» / «Lundin». Faste installasjoner: navnet (og boligrigg).
  const mapLines=a=>{const rigs=[...a.rigs.values()];
    if(a.site.kind==="fixed")return [[a.site.name,...rigs.filter(r=>C.normName(r)!==C.normName(a.site.name))].join(" / ")];
    return [rigs.join(" / "),a.site.name,a.site.operatorShort].filter(Boolean)};
  const markers=[...agg.values()].map(a=>({id:a.site.id,lat:a.site.lat,lon:a.site.lon,r:PIN,conf:a.conf,sel:a.sel,dim:a.dim,fixed:a.site.kind==='fixed',lines:mapLines(a),label:mapLines(a).join(" • "),short:[...a.codes.values()].join(" / "),days:a.days,data:a}));
  for(const pt of ports.values())markers.push({id:pt.site.id,lat:pt.site.lat,lon:pt.site.lon,r:4,port:true,dim:pt.dim,label:pt.site.name,data:{port:true,n:pt.n,site:pt.site}});
  return {markers,lines,routes:[...routes.values()]};
}
let RIG=null; // {fac, tl}
function rigMapItems(){
  if(!RIG)return {markers:[],lines:[]};
  const f0=RIG.fac;
  if(!RIG.tl||!RIG.tl.visits.length)  // fast installasjon (eller rigg uten brønner): vis posisjonen fra Sodir
    return f0.lat!=null?{markers:[{id:"F"+f0.id,lat:f0.lat,lon:f0.lon,r:PIN,conf:f0.moveable?"usikker":"sikker",fixed:!f0.moveable,sel:true,label:C.titleCase(f0.name)}],lines:[]}:{markers:[],lines:[]};
  const {tl}=RIG;const mine=mineSites();
  const markers=tl.sites.map(s=>{const days=s.wells.reduce((n,w)=>n+Math.max(1,C.diffDays(w.entry,w.comp||w.entry)),0);
    return {id:s.id,lat:s.lat,lon:s.lon,r:PIN,days,conf:"sikker",muted:!mine.has(s.id),sel:S.ui.rigSel===s.id,dim:false,label:s.name,data:{site:s,rig:true}}});
  const pts=[];for(const v of tl.visits){const s=tl.siteById[v.site];const l=pts[pts.length-1];if(!l||l[2]!==s.id)pts.push([s.lat,s.lon,s.id])}
  return {markers,lines:[{pts:pts.map(p=>[p[0],p[1]]),hi:false}]};
}
function mineSites(){const set=new Set();if(!RIG)return set;for(const st of STAYS)for(const g of st.segs)if(g.site&&g.site.facilityId===RIG.fac.id)set.add(g.site.id);return set}
function updateMap(){chart.setItems(S.ui.tab==="rig"?rigMapItems():stayMapItems())}
function fitToContent(){
  const it=S.ui.tab==="rig"?rigMapItems():stayMapItems();
  const pts=it.markers.filter(m=>!m.dim).map(m=>[m.lat,m.lon]);
  if(pts.length)chart.fit(pts,pts.length===1?7.5:8.5);else chart.animateTo(wx(4),wy(61.5),4.6);
}

/* ================= views ================= */
function renderAll(){renderStays();renderPlaces();if(S.ui.tab==="rig")renderRig();updateMap();renderPlaceCount()}
function renderPlaceCount(){
  const n=Object.values(S.places).filter(p=>p.kind==="installation"&&!p.link).length;
  const el=$("placeCount");el.hidden=!n;el.textContent=n;
}
function renderSource(){
  const el=$("source"),t=$("sourceText");el.className="ov source "+({live:"live",cache:"cache",file:"cache",err:"err"}[D.status]||"");
  const d=D.stamp?new Date(D.stamp).toLocaleDateString("nb-NO",{day:"numeric",month:"short",year:"numeric"}):"";
  t.innerHTML={none:"Sodir: ikke lastet",loading:"Henter data fra Sodir …",live:`Sodir · oppdatert ${h(d)}`,cache:`Sodir · lagret kopi ${h(d)}`,file:`Sodir · fra fil ${h(d)}`,
    err:`Sodir utilgjengelig (nettverket kan blokkere factmaps.sodir.no) · <button class="linkish" type="button" id="srcRetry">prøv igjen</button>`}[D.status]||"";
  const r=$("srcRetry");if(r)r.onclick=()=>loadFacilities(true).then(ok=>{if(ok){autoLink();persist();recompute()}});
}
function emptyState(){
  return `<div class="drop" id="drop">
    <h2>Finn tilbake til hvor du har vært offshore</h2>
    <ol>
      <li><span><b>Eksporter reisehistorikken</b> fra MinDaVinci til Excel.</span></li>
      <li><span><b>Slipp filen her.</b> Kolonnene gjenkjennes automatisk. Filen leses bare i nettleseren din og lastes ikke opp noe sted.</span></li>
      <li><span><b>Koble kodene til Sodir.</b> Appen foreslår innretning for hver kode, og du bekrefter med ett klikk. For flyttbare rigger slår kartet opp hvilken brønn riggen boret på da du var der.</span></li>
    </ol>
    <div class="actions">
      <button class="btn accent" type="button" data-act="pick">Velg fil</button>
      <button class="btn ghost" type="button" data-act="add">Legg inn et opphold</button>
    </div>
    <div class="privacy"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 5V3.5a3 3 0 0 1 6 0V5M2.5 5h7v5.5h-7z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
      <span>Ingen innlogging og ingen server. Dataene dine blir liggende i denne nettleseren til du sletter dem.</span></div>
  </div>
  <div class="card">
    <h3>Har du ingen fil for hånden?</h3>
    <p class="small muted" style="margin:0">Slå opp en rigg og se hvor den har boret, år for år. Skriv en dato for å se hvor den lå akkurat da.</p>
    <div><button class="btn ghost small" type="button" data-act="rigtab">Åpne rigghistorikk</button></div>
  </div>`;
}
function histogram(byYear,sel){
  const years=Object.keys(byYear).map(Number).sort((a,b)=>a-b);if(!years.length)return "";
  const all=[];for(let y=years[0];y<=years[years.length-1];y++)all.push(y);
  const max=Math.max(...all.map(y=>byYear[y]||0),1);
  const W=360,H=78,bw=Math.min(28,(W-4)/all.length-3),gap=(W-bw*all.length)/Math.max(1,all.length);
  const bars=all.map((y,i)=>{const v=byYear[y]||0,bh=Math.max(v?2:0,(H-26)*v/max),x=i*(bw+gap)+gap/2,yy=H-14-bh;
    return `<g><rect class="bar${sel===y?" on":""}" data-year="${y}" x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"><title>${y}: ${v} døgn</title></rect>
      ${v&&(all.length<=14||sel===y)?`<text class="val" x="${(x+bw/2).toFixed(1)}" y="${(yy-3).toFixed(1)}" text-anchor="middle">${v}</text>`:""}
      ${(all.length<=12||i%Math.ceil(all.length/10)===0||sel===y)?`<text x="${(x+bw/2).toFixed(1)}" y="${H-2}" text-anchor="middle">${all.length>8?"’"+String(y).slice(2):y}</text>`:""}</g>`}).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Døgn offshore per år"><line class="axis" x1="0" x2="${W}" y1="${H-13.5}" y2="${H-13.5}"/>${bars}</svg>`;
}
/* «Dine tall»: flytid og avstand fra loggen. Luftlinje mellom heliport og installasjon, så tallene er litt lave. */
const MOON_KM=384400,EQUATOR_KM=40075;
function flightStats(y){
  let min=0,timed=0,flights=0,km=0,measured=0,longest=null;
  for(const l of S.legs){
    if(l.cancelled||!l.date||!l.from||!l.to)continue;
    if(y&&l.date.slice(0,4)!==String(y))continue;
    flights++;
    const d=C.minutesOf?C.minutesOf(l.dep):null,r=C.minutesOf?C.minutesOf(l.arr):null;
    if(d!=null&&r!=null){let m=r-d;if(m<0)m+=1440;if(m>=5&&m<=300){min+=m;timed++}}
    const a=siteAt(C.placeKey(l.from),l.date),b=siteAt(C.placeKey(l.to),l.date);
    if(a&&b&&a.id!==b.id){const k=C.haversineKm([a.lat,a.lon],[b.lat,b.lon]);km+=k;measured++;if(!longest||k>longest.km)longest={km:k,from:a.name,to:b.name}}
  }
  return {hours:min/60,timed,flights,km,measured,longest};
}
const nf=(v,d=0)=>v.toLocaleString("nb-NO",{minimumFractionDigits:d,maximumFractionDigits:d});
const nameOf=x=>/^[A-ZÆØÅ0-9]{2,4}$/.test(String(x))?String(x):C.titleCase(String(x));
function funHtml(y){
  const f=flightStats(y);if(!f.flights||!f.measured)return "";
  const moon=f.km/MOON_KM,eq=f.km/EQUATOR_KM,laps=Math.floor(eq),part=eq-laps;
  const R=26,CIRC=2*Math.PI*R;
  const mx=14+Math.max(.02,Math.min(1,moon))*(286-28);
  const ring=`<svg class="fun-ring" viewBox="0 0 64 64" role="img" aria-label="${nf(eq,1)} ganger rundt ekvator"><circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--line)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${R}" fill="none" stroke="var(--accent)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(CIRC*(laps>0?part:Math.max(part,.02))).toFixed(1)} ${CIRC.toFixed(1)}" transform="rotate(-90 32 32)"/>
    <text x="32" y="${laps>0?31:35}" text-anchor="middle" class="fun-rt">${laps>0?laps+"×":nf(eq*100,0)+"%"}</text>${laps>0?`<text x="32" y="43" text-anchor="middle" class="fun-rs">+${nf(part*100,0)} %</text>`:""}</svg>`;
  const track=`<svg class="fun-moon" viewBox="0 0 300 44" role="img" aria-label="${nf(moon*100,1)} prosent av veien til månen">
    <circle cx="14" cy="22" r="9" fill="var(--accent)" opacity=".85"/><circle cx="286" cy="22" r="8" fill="var(--faint)"/><circle cx="283" cy="19" r="2" fill="var(--panel)" opacity=".5"/>
    <line x1="24" y1="22" x2="276" y2="22" stroke="var(--line)" stroke-width="2" stroke-dasharray="2 5" stroke-linecap="round"/>
    <line x1="24" y1="22" x2="${mx.toFixed(1)}" y2="22" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round"/>
    <polygon points="0,-6 13,0 0,6 3.5,0" fill="var(--ink)" stroke="var(--panel-2)" stroke-width="1.5" stroke-linejoin="round" transform="translate(${(mx-3).toFixed(1)} 22)"/></svg>`;
  return `<div class="fun"><p class="eyebrow"><span>Dine tall</span><span style="text-transform:none;letter-spacing:0">${y?y:"alle år"}</span></p>
    <div class="fun-grid">
      <div><b>${nf(f.hours,f.hours<100?1:0)}</b><span>timer i helikopter${f.timed<f.flights?` <small>(${f.timed} av ${f.flights} turer har tid)</small>`:""}</span></div>
      <div><b>${nf(f.flights)}</b><span>flyvninger</span></div>
      <div><b>${nf(f.km)}</b><span>km i luften <small>(minst)</small></span></div>
      ${f.longest?`<div><b>${nf(f.longest.km)}</b><span>km lengste flyging <small>${h(nameOf(f.longest.from))} – ${h(nameOf(f.longest.to))}</small></span></div>`:""}
    </div>
    <div class="fun-row">${track}<div class="fun-cap"><b>${nf(moon*100,moon<.1?2:1)} %</b> av veien til månen<small>${nf(MOON_KM-f.km)} km igjen</small></div></div>
    <div class="fun-row">${ring}<div class="fun-cap"><b>${nf(eq,1)} ganger</b> rundt ekvator<small>${laps?`${laps} hele runder`:"ikke en hel runde ennå"}</small></div></div>
  </div>`;
}
function renderStays(){
  const v=$("view-stays");
  if(!STAYS.length){v.innerHTML=emptyState();bindDrop($("drop"));return}
  const y=S.ui.year;const vis=STAYS.filter(s=>inYear(s,y));
  const byYear={};for(const s of STAYS){const yr=+s.start.slice(0,4);byYear[yr]=(byYear[yr]||0)+countDays(s)}
  const days=vis.reduce((n,s)=>n+countDays(s),0);const pending=vis.filter(s=>s.long&&!S.accepted[s.id]).length;
  const sites=new Set();const insts=new Set();for(const s of vis){if(!s.turnback)insts.add(s.key);for(const g of s.segs)if(g.site)sites.add(g.site.id)}
  const need=Object.values(S.places).filter(p=>p.kind==="installation"&&!p.link).length;
  const unknown=vis.filter(s=>!s.turnback&&s.segs.every(g=>!g.site)).length;const trips=vis.length;
  let html=`<div class="stats">
    <div class="stat"><b>${days}</b><span>døgn</span></div>
    <div class="stat"><b>${trips}</b><span>${plural(trips,"tur","turer")}</span></div>
    <div class="stat"><b>${insts.size}</b><span>${plural(insts.size,"innretning","innretninger")}</span></div>
    <div class="stat"><b>${sites.size}</b><span>${plural(sites.size,"lokasjon","lokasjoner")}</span></div></div>`;
  if(pending)html+=`<div class="answer">${pending} ${plural(pending,"opphold","opphold")} er over fem uker og telles ikke med i døgn før du har sjekket og godtatt ${pending>1?"dem":"det"}. Trolig mangler en reise i arket.</div>`;
  if(need)html+=`<div class="answer">${need} ${plural(need,"installasjon","installasjoner")} i loggen kunne ikke kobles sikkert automatisk.${D.status==="err"?" Sodir svarer ikke akkurat nå, men du kan plassere dem i kartet selv eller laste inn Sodir-data som fil.":""} <button class="linkish" type="button" data-act="placestab">Se forslag</button></div>`;
  else if(D.status==="err"&&unknown)html+=`<div class="answer">Fikk ikke kontakt med Sodir, så posisjonene til flyttbare rigger mangler. Prøv igjen senere, eller last inn Sodir sin brønnbanetabell som CSV via <b>Importer</b>.</div>`;
  html+=funHtml(y);
  html+=`<div class="hist"><p class="eyebrow"><span>Døgn offshore per år</span>${y?`<button class="linkish" type="button" data-act="allyears">Vis alle år</button>`:`<span style="text-transform:none;letter-spacing:0">Trykk på et år for å filtrere</span>`}</p>${histogram(byYear,y)}</div>`;
  const groups=new Map();for(const s of vis.slice().reverse()){const yr=s.start.slice(0,4);if(!groups.has(yr))groups.set(yr,[]);groups.get(yr).push(s)}
  for(const [yr,list] of groups){
    const d=list.reduce((n,s)=>n+countDays(s),0),nt=list.length,nb=list.filter(s=>s.turnback).length;
    html+=`<div class="year-group"><div class="year-head"><h3>${yr}</h3><span>${nt} ${plural(nt,"tur","turer")}${nb?` (${nb} snudd)`:""} · ${d} døgn</span></div>`;
    for(const s of list)html+=stayRow(s);
    html+=`</div>`;
  }
  v.innerHTML=html;
  v.querySelectorAll(".hist .bar").forEach(b=>b.addEventListener("click",()=>{const yy=+b.dataset.year;S.ui.year=S.ui.year===yy?null:yy;S.ui.sel=null;renderStays();updateMap();fitToContent()}));
  const sel=v.querySelector(".stay.sel");if(sel&&renderStays.scroll&&!isMobile()){sel.scrollIntoView({block:"nearest"});renderStays.scroll=false}
  renderMDetail();
}
/* Navnet installasjonen hadde da du var der, med dagens navn i parentes. */
function instTitle(s,p){
  const now=p?p.label:s.key,then=(s.segs.find(g=>g.thenName)||{}).thenName;
  if(then&&C.normName(then)!==C.normName(now)&&!(p&&p.labelEdited))return `${h(C.titleCase(then))} <span class="now">nå ${h(now)}</span>`;
  return h(now);
}
function stayRow(s){
  const sel=S.ui.sel===s.id;const p=S.places[s.key];
  const segs=s.segs;const first=segs.find(g=>g.site)||segs[0];
  // faste installasjoner: bare navnet (står allerede som tittel). Rigger: «Volvefeltet 15/9».
  const title=p?p.label:s.key;
  // egen fast installasjon: ingenting (navnet står som tittel). Lå ved en annen (boligrigg): «Skarvfeltet – 6507/5».
  const own=p&&p.link&&p.link.type==="sodir"?p.link.id:null;
  const where=segs.some(g=>g.site)?segs.filter(g=>g.site).map(g=>g.flotel?"ved "+g.site.name:g.site.kind==="fixed"?(g.site.facilityId===own?"":g.site.place||g.site.name):[g.site.name,g.site.operatorShort].filter(Boolean).join(" • ")).filter((x,i,a)=>x&&C.normName(x)!==C.normName(title)&&a.indexOf(x)===i).join(" → "):"Posisjon ukjent";
  const conf=segs.reduce((w,g)=>{const r={ukjent:0,usikker:1,trolig:2,manuell:3,sikker:4};return r[g.conf]<r[w]?g.conf:w},"sikker");
  if(s.turnback){const l=s.legs[0];
    return `<div class="stay turnback${sel?" sel":""}" role="button" tabindex="0" data-stay="${h(s.id)}" aria-expanded="${sel}">
    <div class="when">${C.fmtDate(s.start,false)}</div>
    <div class="what"><div class="inst">Snudde · ${h(l.from)}–${h(l.to)}</div><div class="where">${h([l.dep,l.route].filter(Boolean).join(" · ")||"Ingen landing offshore")}</div></div>
    <div class="days">0<small>døgn</small></div>${sel?stayDetail(s):""}</div>`}
  const when=`${C.fmtDate(s.start,false)}${s.startKnown?"":"?"}<br>${C.fmtDate(s.end,false)}${s.endKnown?"":"?"}`;
  let html=`<div class="stay${sel?" sel":""}" role="button" tabindex="0" data-stay="${h(s.id)}" aria-expanded="${sel}">
    <div class="when">${when}</div>
    <div class="what"><div class="inst">${instTitle(s,p)}</div><div class="where">${h(where)} ${pill(conf)}</div></div>
    <div class="days${s.long&&!S.accepted[s.id]?" long":s.over?" over":""}"${s.long&&!S.accepted[s.id]?' title="Over 5 uker: sjekk om en reise mangler i arket"':s.over?' title="Over 21 døgn"':""}>${s.days}<small>døgn${s.long&&!S.accepted[s.id]?" ?":""}</small></div>`;
  if(sel)html+=stayDetail(s);
  return html+`</div>`;
}
function stayDetail(s){
  let html=`<div class="detail" data-stop>`;
  for(const g of s.segs){
    html+=`<div class="seg">`;
    if(s.segs.length>1)html+=`<div class="small muted mono">${C.fmtDate(g.start)} – ${C.fmtDate(g.end)}</div>`;
    if(g.site){
      const st=g.site;
      html+=`<dl>
        <dt>Lokasjon</dt><dd><b>${h(st.name)}</b> ${pill(g.conf)}</dd>
        ${g.thenName&&C.normName(g.thenName)!==C.normName(st.facilityName||"")&&C.normName(g.thenName)!==C.normName(labelOf(s.key))?`<dt>Het da</dt><dd>${h(C.titleCase(g.thenName))} <span class="muted">(nå ${h(labelOf(s.key))})</span></dd>`:""}
        ${st.discovery?`<dt>Funn</dt><dd>${h(C.titleCase(st.discovery))}</dd>`:""}
        ${st.aliases&&st.aliases.length?`<dt>Alias hos Sodir</dt><dd>${st.aliases.map(x=>h(C.titleCase(x))).join(", ")}</dd>`:""}
        ${st.prospect?`<dt>Prospekt</dt><dd>${h(C.titleCase(st.prospect))}${st.prospectText?`<div class="small muted">Fra Sodirs brønnhistorikk: «${h(st.prospectText)}»</div>`:""}</dd>`:""}
        ${st.licence?`<dt>Lisens</dt><dd>PL ${h(st.licence.replace(/^PL\s*/i,""))}${st.operator?` · ${h(st.operator)}`:""}</dd>`:""}
        ${st.kind==="mobile"?`<dt>Brønn</dt><dd class="mono">${h((g.visit?g.visit.wells:st.wells).map(w=>w.name).slice(0,6).join(", "))}${(g.visit?g.visit.wells:st.wells).length>6?" …":""}</dd>`:""}
        ${st.kind==="mobile"&&st.area?`<dt>Område</dt><dd>${h(C.titleCase(st.area))}</dd>`:""}
        ${st.depth!=null?`<dt>Havdyp</dt><dd class="mono">${st.depth} m</dd>`:""}
        <dt>Posisjon</dt><dd class="mono">${fmtPos(st.lat,st.lon)}</dd>
      </dl>`;
    }else if(g.conf!=="avbrutt")html+=`<div><b>Posisjon ukjent</b> ${pill(g.conf)}</div>`;
    html+=`<div class="note">${h(g.note||"")}${s.homeFrom&&g===s.segs[s.segs.length-1]?` Reiste hjem fra ${h(labelOf(C.placeKey(s.homeFrom)))}.`:""}</div>`;
    const links=[];
    if(g.site&&g.site.kind==="mobile"){const w=(g.visit?g.visit.wells:g.site.wells)[0];if(w&&w.url)links.push(`<a href="${h(w.url)}" target="_blank" rel="noopener">Brønnen hos Sodir ↗</a>`)}
    if(g.site&&g.site.press)links.push(`<a href="${h(g.site.press)}" target="_blank" rel="noopener">Pressemelding fra Sodir ↗</a>`);
    if(g.site&&g.site.url)links.push(`<a href="${h(g.site.url)}" target="_blank" rel="noopener">Innretningen hos Sodir ↗</a>`);
    if(links.length)html+=`<div class="row small">${links.join(" · ")}</div>`;
    html+=`</div>`;
  }
  const legs=s.legs.filter(Boolean);
  if(legs.length){
    const then=(s.segs.find(g=>g.thenName)||{}).thenName,thenOk=then&&!(S.places[s.key]||{}).labelEdited;
    const nm=x=>{const k=C.placeKey(x),p=S.places[k];const lab=k===s.key&&thenOk?C.titleCase(then):p&&p.label;return lab&&C.normName(lab)!==C.normName(x)?`${lab} (${x})`:x};
    const line=l=>{
      const t=[l.dep,l.arr].filter(Boolean).join("–");
      const ci=l.checked?(/^\d{1,2}:\d{2}$/.test(l.checked)?"Sjekket inn "+l.checked:/^(nei|no|n|false|0)$/i.test(l.checked)?"Ikke sjekket inn":"Sjekket inn"):"";
      const sub=[l.company,ci].filter(Boolean);
      return `<div class="leg"><div class="mono">${C.fmtDate(l.date)}${t?" · "+h(t):""}${l.route?" · "+h(l.route):""}</div><div>${h(nm(l.from||""))}${l.from||l.to?" → ":""}${h(nm(l.to||l.inst))}</div>${sub.length?`<div class="muted">${sub.map(h).join(" · ")}</div>`:""}</div>`};
    html+=`<div class="small"><div class="muted" style="margin-bottom:3px">Reiser i loggen</div>${legs.map(line).join("")}</div>`;
  }
  if(!s.startKnown||!s.endKnown||s.over)html+=`<div class="note">${!s.startKnown?"Loggen mangler utreisen. ":""}${!s.endKnown?(s.ongoing?"Ingen hjemreise registrert ennå. ":"Loggen mangler hjemreisen. "):""}${s.long?(S.accepted[s.id]?"Over fem uker – du har godtatt oppholdet.":"Over fem uker offshore er svært uvanlig. Trolig mangler en hjemreise og en utreise i arket. Oppholdet telles ikke med i døgn før du godtar det."):s.over?"Lengre enn maks oppholdsperiode på 21 døgn, f.eks. på grunn av vær.":""}</div>`;
  const fs=s.segs.find(g=>g.flotel);
  if(fs){const fl=fs.flotel,cur=S.flotelAt[s.id];
    const opts=[...new Set([...fl.entries.filter(e=>!e.utland).map(e=>e.felt),...Object.values(S.places).filter(o=>o.kind==="installation"&&o.link&&o.link.type==="sodir"&&!flotelOf(o.key)).map(o=>{const f=D.facById.get(o.link.id);return f&&!f.moveable?(f.belongsTo||f.name):""}).filter(Boolean)].map(x=>C.normName(x)))];
    const bases=[];for(const l of s.legs||[])for(const x of [l&&l.from,l&&l.to])if(x&&kindOf(C.placeKey(x))==="base")bases.push(x);
    const okReach=o=>{const site=flotelSite({felt:o,inst:o});if(!site)return true;return bases.every(b=>C.reachable(b,[site.lat,site.lon])!==false)};
    const shown=opts.filter(o=>okReach(o)||(cur&&C.normName(cur.felt)===o));opts.length=0;opts.push(...shown);
    if(fs.site&&fs.site.flotelSource)html+=`<div class="small muted">Kilde: ${fs.site.flotelUrl?`<a href="${h(fs.site.flotelUrl)}" target="_blank" rel="noopener">${h(fs.site.flotelSource)}</a>`:h(fs.site.flotelSource)}</div>`;
    html+=`<div class="field"><label for="flotat">${fs.conf==="sikker"?"Stemmer ikke? ":""}Hvor lå ${h(C.titleCase(fl.name))} da du var der?</label>
      <select class="input" id="flotat" data-id="${h(s.id)}"><option value="">${cur?"Fjern svaret mitt":"Velg felt …"}</option>${opts.map(o=>`<option value="${h(o)}"${cur&&C.normName(cur.felt)===o?" selected":""}>${h(C.titleCase(o))}</option>`).join("")}</select>
      <div class="small muted">Svaret ditt brukes her med en gang. Del det gjerne via «Foreslå koder» i menyen, så blir flotellregisteret bedre for alle.</div></div>`;
  }
  const p=S.places[s.key];const mob=s.segs.find(g=>g.site&&g.site.kind==="mobile");
  html+=`<div class="row">
    ${s.long?`<button class="btn small${S.accepted[s.id]?" ghost":""}" type="button" data-act="${S.accepted[s.id]?"unacceptlong":"acceptlong"}" data-id="${h(s.id)}">${S.accepted[s.id]?"Angre godkjenning":"Godta oppholdet"}</button>`:""}
    <button class="btn small ghost" type="button" data-act="pickstay" data-id="${h(s.id)}">${S.overrides[s.id]?"Flytt manuell posisjon":"Sett posisjon for denne turen"}</button>
    ${S.overrides[s.id]?`<button class="btn small ghost" type="button" data-act="unpickstay" data-id="${h(s.id)}">Fjern manuell posisjon</button>`:""}
    ${mob?`<button class="btn small ghost" type="button" data-act="openrig" data-id="${h(mob.site.facilityId)}" data-date="${h(s.start)}">Rigghistorikk</button>`:""}
    ${p&&!p.link?`<button class="btn small accent" type="button" data-act="editplace" data-key="${h(s.key)}">Koble installasjonen</button>`:""}
    ${s.manual?`<button class="btn small ghost" type="button" data-act="delmanual" data-id="${h(s.id)}">Slett oppholdet</button>`:""}
  </div></div>`;
  return html;
}

/* ---------- rig history ---------- */
function rigSearchHtml(id,ph,val=""){return `<div class="search"><input class="input" id="${id}" placeholder="${h(ph)}" autocomplete="off" value="${h(val)}" role="combobox" aria-expanded="false" aria-autocomplete="list"><div class="suggest" id="${id}-s" hidden></div></div>`}
function facilitySuggest(input,{onPick,filter,boost}={}){
  const box=$(input.id+"-s");let hi=-1,items=[];
  const run=()=>{
    const q=input.value.trim();if(!q){box.hidden=true;input.setAttribute("aria-expanded","false");return}
    const nq=C.normName(q);
    items=D.facilities.filter(f=>!filter||filter(f)).map(f=>{
        let sc=0,via="";
        for(const nm of namesOf(f)){const n=C.normName(nm);const s2=n.startsWith(nq)?1:n.includes(nq)?.85:Math.max(C.nameScore(q,nm),C.idfScore(q,nm,D.idf));if(s2>sc){sc=s2;via=nm===f.name?"":nm}}
        if(boost&&sc)sc+=boost(f);return {f,sc,via}})
      .filter(x=>x.sc>=.5).sort((a,b)=>b.sc-a.sc||a.f.name.localeCompare(b.f.name)).slice(0,10);
    if(!items.length){box.innerHTML=`<div class="small muted" style="padding:8px">${D.facilities.length?"Ingen treff i Sodir":"Sodir-data er ikke lastet"}</div>`;box.hidden=false;return}
    hi=-1;box.innerHTML=items.map((x,i)=>`<button type="button" data-i="${i}"><span>${h(C.titleCase(x.f.name))}${x.via?` <small>(tidl. ${h(C.titleCase(x.via))})</small>`:""}</span><small>${x.f.moveable?"Flyttbar":"Fast"}${x.f.kind?" · "+h(C.titleCase(x.f.kind)):""}</small></button>`).join("");
    box.hidden=false;input.setAttribute("aria-expanded","true");
    box.querySelectorAll("button").forEach(b=>b.addEventListener("mousedown",e=>{e.preventDefault();pick(+b.dataset.i)}));
  };
  const pick=i=>{const x=items[i];if(!x)return;box.hidden=true;input.value=C.titleCase(x.f.name);onPick&&onPick(x.f)};
  input.addEventListener("input",run);input.addEventListener("focus",run);
  input.addEventListener("blur",()=>setTimeout(()=>box.hidden=true,120));
  input.addEventListener("keydown",e=>{
    const bs=[...box.querySelectorAll("button")];
    if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();hi=(hi+(e.key==="ArrowDown"?1:-1)+bs.length)%bs.length;bs.forEach((b,i)=>b.classList.toggle("hi",i===hi))}
    if(e.key==="Enter"){e.preventDefault();pick(hi>=0?hi:0)}
    if(e.key==="Escape")box.hidden=true;
  });
}
function myRigs(){
  const m=new Map();
  for(const st of STAYS)for(const g of st.segs)if(g.site&&g.site.kind==="mobile"){const f=D.facById.get(g.site.facilityId);if(f)m.set(f.id,f)}
  for(const p of Object.values(S.places))if(p.link&&p.link.type==="sodir"){const f=D.facById.get(p.link.id);if(f&&f.moveable)m.set(f.id,f)}
  return [...m.values()];
}
async function openRig(facId,date){
  const fac=D.facById.get(facId);if(!fac)return;
  RIG={fac,tl:null,loading:true};S.ui.rig=facId;S.ui.rigSel=null;if(date)S.ui.rigDate=date;
  switchTab("rig");
  const tl=fac.moveable||hasHistory(fac)?await timelineFor(facId):null;
  if(!RIG||RIG.fac.id!==facId)return;
  RIG.tl=tl;RIG.loading=false;renderRig();updateMap();
  const ans=rigAnswer();if(ans&&ans.site){S.ui.rigSel=ans.site.id;renderRig();updateMap();revealMap();chart.flyTo(ans.site.lat,ans.site.lon,7.2)}else fitToContent();
}
function rigAnswer(){
  if(!RIG||!RIG.tl||!S.ui.rigDate)return null;
  const d=S.ui.rigDate;const segs=C.locateOnRig(RIG.tl,d,d);return segs[0];
}
function renderRig(){
  const v=$("view-rig");
  const mine=myRigs();
  let html=`<div class="field"><label for="rigq">Rigg eller innretning</label>${rigSearchHtml("rigq","Søk i Sodir, f.eks. Deepsea Atlantic",RIG?C.titleCase(RIG.fac.name):"")}</div>`;
  if(mine.length)html+=`<div class="chips">${mine.map(f=>`<button class="chip${RIG&&RIG.fac.id===f.id?" on":""}" type="button" data-act="openrig" data-id="${h(f.id)}">${h(C.titleCase(f.name))}</button>`).join("")}</div>`;
  if(!D.facilities.length)html+=`<div class="answer">${D.status==="loading"?"Henter innretninger fra Sodir …":"Sodir-data er ikke tilgjengelig akkurat nå. Last inn Sodir sin brønnbanetabell (CSV) via Importer, eller prøv igjen senere."}</div>`;
  if(RIG){
    const f=RIG.fac;
    const old=D.aliases.get(f.id)||[];
    html+=`<div class="rig-head"><h2>${h(C.titleCase(f.name))}</h2>${old.length?`<div class="muted">Het tidligere ${old.map(n=>h(C.titleCase(n))).join(", ")}</div>`:""}<div class="muted">${f.moveable?"Flyttbar":"Fast"} innretning${f.kind?" · "+h(C.titleCase(f.kind)):""}${f.operator?" · "+h(f.operator):""}${f.url?` · <a href="${h(f.url)}" target="_blank" rel="noopener">Sodir ↗</a>`:""}</div></div>`;
    if(RIG.loading)html+=`<p class="muted">Henter brønnhistorikk fra Sodir …</p>`;
    else if(!RIG.tl||!RIG.tl.visits.length){
      html+=f.lat!=null?`<div class="answer">Fast posisjon: <b class="mono">${fmtPos(f.lat,f.lon)}</b></div>`:`<div class="answer">Sodir har ingen brønner registrert på denne innretningen. Boligrigger og fartøy borer ikke, så posisjonen deres finnes ikke her.</div>`;
    }else{
      html+=`<div class="field"><label for="rigdate">Hvor var riggen den …</label><input class="input" type="date" id="rigdate" value="${h(S.ui.rigDate)}"></div>`;
      const a=rigAnswer();
      if(a)html+=`<div class="answer">${a.site?`<b>${h(a.site.name)}</b>${a.site.sub?` · <span class="mono">${h(a.site.sub)}</span>`:""} ${pill(a.conf)}<br><span class="mono small">${fmtPos(a.site.lat,a.site.lon)}</span><br><span class="small">${h(a.note)}</span>`:`<b>Ukjent.</b> <span class="small">${h(a.note)}</span>`}</div>`;
      const mineIds=mineSites();
      const vs=RIG.tl.visits.slice().reverse();
      html+=`<div><p class="eyebrow"><span>${RIG.tl.visits.length} opphold på ${RIG.tl.sites.length} lokasjoner</span><span>${RIG.tl.visits[0].start.slice(0,4)}–${RIG.tl.visits[RIG.tl.visits.length-1].end.slice(0,4)}</span></p>`;
      for(const vi of vs){const s=RIG.tl.siteById[vi.site];
        html+=`<button type="button" class="visit${S.ui.rigSel===s.id?" sel":""}${mineIds.has(s.id)?" mine":""}" data-site="${h(s.id)}">
          <span class="when">${C.fmtDate(vi.start)} –<br>${C.fmtDate(vi.end)}</span>
          <span class="where">${h(s.name)}</span>
          <span class="wells">${h(vi.wells.map(w=>w.name).join(", "))}</span></button>`}
      html+=`</div>`;
    }
  }else html+=`<p class="small muted" style="margin:0">Sodir registrerer hvilken innretning som boret hver brønn på norsk sokkel, med datoer og posisjon. Det gjør det mulig å følge en flyttbar rigg bakover i tid.</p>`;
  v.innerHTML=html;
  facilitySuggest($("rigq"),{onPick:f=>openRig(f.id),boost:f=>f.moveable?.05:0});
  const di=$("rigdate");if(di)di.addEventListener("change",()=>{S.ui.rigDate=di.value;const a=rigAnswer();S.ui.rigSel=a&&a.site?a.site.id:null;renderRig();updateMap();if(a&&a.site){revealMap();chart.flyTo(a.site.lat,a.site.lon,7.2)}});
  v.querySelectorAll(".visit").forEach(b=>b.addEventListener("click",()=>{const s=RIG.tl.siteById[b.dataset.site];S.ui.rigSel=s.id;renderRig();updateMap();revealMap();chart.flyTo(s.lat,s.lon,Math.max(chart.z,7))}));
}

/* ---------- places ---------- */
function renderPlaces(){
  const v=$("view-places");
  const ps=Object.values(S.places);
  if(!ps.length){v.innerHTML=`<p class="muted">Når du har importert en reiselogg, dukker installasjonene og heliportene fra loggen opp her.</p>`;return}
  const need=ps.filter(p=>p.kind==="installation"&&!p.link),auto=ps.filter(p=>p.kind==="installation"&&p.link&&p.auto),ok=ps.filter(p=>p.kind==="installation"&&p.link&&!p.auto),base=ps.filter(p=>p.kind==="base");
  const stayCount=k=>STAYS.filter(s=>s.key===k).length;
  const row=(p,status,cls)=>{
    const open=S.ui.openPlace===p.key;
    let html=`<div class="place" data-key="${h(p.key)}"><div class="place-top"><span class="code">${h(p.raw)}</span>
      <div><div class="name">${h(p.label)}</div><div class="sub">${h(placeLinkText(p))}${p.kind==="installation"?` · ${stayCount(p.key)} ${plural(stayCount(p.key),"tur","turer")}`:` · ${p.rows} reiser`}</div></div>
      <button class="btn small ghost" type="button" data-act="toggleplace" data-key="${h(p.key)}" aria-expanded="${open}">${open?"Lukk":status}</button></div>`;
    if(open)html+=placeEditor(p);
    else if(p.kind==="installation"&&!p.link&&D.facilities.length){
      const c=candidates(p,3);
      html+=c.length?`<div class="chips"><span class="small muted" style="align-self:center">Forslag:</span>${c.map(x=>`<button class="chip" type="button" data-act="linkfac" data-key="${h(p.key)}" data-id="${h(x.f.id)}">${h(C.titleCase(x.f.name))} <span class="muted small">${x.via?"tidl. "+h(C.titleCase(x.via)):x.f.moveable?"flyttbar":"fast"}</span></button>`).join("")}</div>`:"";
    }
    return html+`</div>`;
  };
  let html=`<p class="small muted" style="margin:0">Installasjonene kobles automatisk mot Sodir ut fra koden, datoene du var der og hvem du fløy mellom. For flyttbare rigger finner kartet da lokasjonen ut fra datoen på turen. Er en kobling feil, trykk «Endre».</p>`;
  if(need.length)html+=`<div><p class="eyebrow"><span>Må kobles · ${need.length}</span></p>${need.map(p=>row(p,"Koble","need")).join("")}</div>`;
  if(auto.length)html+=`<div><p class="eyebrow"><span>Koblet automatisk · ${auto.length}</span></p>${auto.map(p=>row(p,"Endre","auto")).join("")}</div>`;
  if(ok.length)html+=`<div><p class="eyebrow"><span>Koblet · ${ok.length}</span></p>${ok.map(p=>row(p,"Endre","ok")).join("")}</div>`;
  if(base.length)html+=`<div><p class="eyebrow"><span>Landbaser og heliporter · ${base.length}</span></p>${base.map(p=>row(p,"Endre","base")).join("")}</div>`;
  v.innerHTML=html;
  const inp=v.querySelector("#placeq");
  if(inp){const key=inp.dataset.key;facilitySuggest(inp,{onPick:f=>{linkPlace(key,{type:"sodir",id:f.id},C.titleCase(f.name))}})}
  const fol=v.querySelector("#placefollow");
  if(fol)fol.addEventListener("change",()=>{if(fol.value)linkPlace(fol.dataset.key,{type:"follow",key:fol.value})});
  const lab=v.querySelector("#placelabel");
  if(lab)lab.addEventListener("change",()=>{const p=S.places[lab.dataset.key];p.label=lab.value.trim()||p.raw;p.labelEdited=true;persist();recompute()});
}
function placeEditor(p){
  const c=D.facilities.length?candidates(p,5):[];
  const others=Object.values(S.places).filter(o=>o.key!==p.key&&o.kind==="installation"&&o.link&&o.link.type!=="follow");
  return `<div class="place-edit">
    ${/^[^\s]{2,6}$/.test(p.raw)&&p.kind==="installation"?`<p class="small muted" style="margin:0">«${h(p.raw)}» er en kode fra MinDaVinci. Velg innretningen den står for. Er det en boligrigg uten egne brønner, velg innretningen den lå ved. Valget huskes i denne nettleseren, og kan lastes ned som kodeliste under «···».</p>`:""}
    <div class="field"><label for="placelabel">Navn i kartet</label><input class="input" id="placelabel" data-key="${h(p.key)}" value="${h(p.label)}"></div>
    ${p.kind==="installation"?`
    ${c.length?`<div class="field"><label>Forslag fra Sodir</label><div class="chips">${c.map(x=>`<button class="chip${p.link&&p.link.type==="sodir"&&p.link.id===x.f.id?" on":""}" type="button" data-act="linkfac" data-key="${h(p.key)}" data-id="${h(x.f.id)}">${h(C.titleCase(x.f.name))} <span class="muted small">${x.via?"tidl. "+h(C.titleCase(x.via)):x.f.moveable?"flyttbar":"fast"}</span></button>`).join("")}</div></div>`:""}
    <div class="field"><label for="placeq">Søk i Sodir</label>${rigSearchHtml("placeq","Skriv navnet på innretningen").replace('id="placeq"',`id="placeq" data-key="${h(p.key)}"`)}</div>
    ${others.length?`<div class="field"><label for="placefollow">Eller: lå ved en annen installasjon (f.eks. boligrigg)</label><select class="input" id="placefollow" data-key="${h(p.key)}"><option value="">Velg …</option>${others.map(o=>`<option value="${h(o.key)}"${p.link&&p.link.type==="follow"&&p.link.key===o.key?" selected":""}>${h(o.label)}</option>`).join("")}</select></div>`:""}
    <div class="row" style="display:flex;flex-wrap:wrap;gap:6px">
      <button class="btn small ghost" type="button" data-act="pickplace" data-key="${h(p.key)}">Plasser i kartet</button>
      ${p.link?`<button class="btn small ghost" type="button" data-act="unlink" data-key="${h(p.key)}">Fjern kobling</button>`:""}
      ${p.auto?`<button class="btn small accent" type="button" data-act="approve" data-key="${h(p.key)}">Riktig kobling</button>`:""}
      <button class="btn small ghost" type="button" data-act="setbase" data-key="${h(p.key)}">Dette er en landbase</button>
    </div>`:`
    <p class="small muted" style="margin:0">Landbaser og heliporter vises ikke i kartet. Er dette egentlig en installasjon offshore?</p>
    <div><button class="btn small ghost" type="button" data-act="setinst" data-key="${h(p.key)}">Dette er en installasjon</button></div>`}
  </div>`;
}
function linkPlace(key,link,label){
  const p=S.places[key];if(!p)return;p.link=link;p.auto=false;p.byCode=false;p.kind="installation";if(label&&!p.labelEdited)p.label=label;
  persist();toast(`${p.label} er koblet.`);recompute();
}

/* ---------- tabs ---------- */
function switchTab(t){
  S.ui.tab=t;
  for(const b of document.querySelectorAll(".tab"))b.setAttribute("aria-selected",String(b.dataset.tab===t));
  for(const k of ["stays","rig","places"])$("view-"+k).hidden=k!==t;
  if(t==="rig")renderRig();
  renderMDetail();if(isMobile())Sheet.refresh();
  updateMap();
}

/* ================= import ================= */
async function handleFile(file){
  try{
    const name=file.name||"fil";
    if(/\.json$/i.test(name)){
      const j=JSON.parse(await file.text());
      if(!["sokkelreiser","sokkelreise","offshorekart"].includes(j.app))throw new Error("JSON-filen er ikke en prosjektfil fra Sokkelreiser.");
      S.legs=j.legs||[];S.places=j.places||{};S.manual=j.manual||[];S.overrides=j.overrides||{};S.accepted=j.accepted||{};S.flotelAt=j.flotelAt||{};S.sourceName=j.sourceName||name;
      persist();toast("Prosjektfilen er lastet inn.");await recompute();fitToContent();return;
    }
    let tables,date1904=false;
    if(/\.xlsx$/i.test(name)){const r=await C.readXlsx(await file.arrayBuffer());tables=r.sheets;date1904=r.date1904}
    else if(/\.xls$/i.test(name))throw new Error("Gamle .xls-filer støttes ikke. Lagre filen som .xlsx eller CSV først.");
    else tables=[{name,rows:C.parseCSV(await file.text())}];
    const an=C.analyseTables(tables).filter(t=>t.rowCount>0);
    if(!an.length)throw new Error("Fant ingen rader i filen.");
    const sod=an.find(t=>t.kind!=="trips");
    if(sod){
      const msg=ingestSodirFile(sod.kind,sod.headers,sod.body);
      toast(`Sodir-data lastet fra fil: ${msg}.`);autoLink();persist();await recompute();return;
    }
    an.sort((a,b)=>b.score-a.score);
    const t=an[0],miss=[];
    if(t.cols.date==null)miss.push("Dato");
    if(t.cols.inst==null){if(t.cols.from==null)miss.push("Fra");if(t.cols.to==null)miss.push("Til")}
    if(miss.length)throw new Error(`Fant ikke ${miss.length>1?"kolonnene":"kolonnen"} ${miss.map(m=>"«"+m+"»").join(" og ")}. Bruk reisehistorikken slik den eksporteres fra MinDaVinci.`);
    const legs=C.buildLegs(t,t.cols,date1904);
    if(!legs.length)throw new Error("Fant ingen reiser med gyldig dato i filen.");
    await applyLegs(legs,name);
  }catch(e){console.error(e);toast(e.message||"Kunne ikke lese filen.")}
}
async function applyLegs(legs,name){
  S.legs=legs;S.sourceName=name;S.ui.year=null;S.ui.sel=null;
  syncPlaces();let n=applyCodeList();
  if(D.facilities.length){toast("Kobler installasjonene mot Sodir …");await loadActivity(false)}
  n+=autoLink();persist();
  await recompute();switchTab("stays");fitToContent();
  const skipped=legs.filter(l=>l.cancelled).length;
  const need=Object.values(S.places).filter(p=>p.kind==="installation"&&!p.link).length;
  toast(`${legs.length-skipped} reiser importert${skipped?`, ${skipped} kansellerte hoppet over`:""}.${n?` ${n} koblet automatisk.`:""}${need?` ${need} kunne ikke kobles sikkert.`:""}`);
}
function bindDrop(el){
  if(!el)return;
  el.addEventListener("dragover",e=>{e.preventDefault();el.classList.add("over")});
  el.addEventListener("dragleave",()=>el.classList.remove("over"));
  el.addEventListener("drop",e=>{e.preventDefault();el.classList.remove("over");const f=e.dataTransfer.files[0];if(f)handleFile(f)});
}
document.addEventListener("dragover",e=>e.preventDefault());
document.addEventListener("drop",e=>{e.preventDefault();const f=e.dataTransfer&&e.dataTransfer.files[0];if(f)handleFile(f)});

/* ================= manual stay ================= */
function openAddDialog(){
  const f=$("addForm");let chosen=null;
  f.innerHTML=`<h2>Legg inn et opphold</h2>
    <div class="field"><label for="addq">Installasjon</label>${rigSearchHtml("addq","Søk i Sodir eller skriv et navn")}</div>
    <div class="grid2"><div class="field"><label for="addfrom">Ut</label><input class="input" type="date" id="addfrom" required></div>
    <div class="field"><label for="addto">Hjem</label><input class="input" type="date" id="addto" required></div></div>
    <p class="err" id="adderr" hidden></p>
    <div class="foot"><button class="btn ghost" value="cancel" type="submit" formnovalidate>Avbryt</button><button class="btn accent" value="go" type="submit" id="addgo">Legg til</button></div>`;
  facilitySuggest($("addq"),{onPick:fc=>chosen=fc,boost:fc=>fc.moveable?.03:0});
  $("addq").addEventListener("input",()=>chosen=null);
  $("addgo").addEventListener("click",e=>{
    const name=$("addq").value.trim(),a=$("addfrom").value,b=$("addto").value,err=$("adderr");
    if(!name||!a||!b||b<a){e.preventDefault();err.hidden=false;err.textContent=!name?"Skriv inn installasjonen.":(!a||!b)?"Velg begge datoene.":"Hjemreisen kan ikke være før utreisen.";return}
    const key=chosen?"SODIR "+chosen.id:C.normName(name);
    if(!S.places[key])S.places[key]={key,raw:chosen?C.titleCase(chosen.name):name,label:chosen?C.titleCase(chosen.name):name,kind:"installation",guess:"installation",link:chosen?{type:"sodir",id:chosen.id}:null,auto:false,rows:0};
    S.manual.push({id:"M"+Date.now().toString(36)+"@"+a,key,start:a,end:b});persist();
  });
  $("dlgAdd").showModal();
}
$("dlgAdd").addEventListener("close",async()=>{if($("dlgAdd").returnValue==="go"){await recompute();switchTab("stays");fitToContent();toast("Oppholdet er lagt til.")}});

/* ================= pick on map ================= */
function startPick(kind,id,text){S.ui.pick={kind,id};$("pickText").textContent=text;$("pickbar").hidden=false;$("map").classList.add("pick");if(isMobile()){startPick.prev=Sheet.state;Sheet.set("peek")}}
function endPick(){S.ui.pick=null;$("pickbar").hidden=true;$("map").classList.remove("pick");if(isMobile()&&startPick.prev){Sheet.set(startPick.prev);startPick.prev=null}}
$("pickCancel").addEventListener("click",endPick);

/* ================= export ================= */
function stayTable(){
  const rows=[["Ut","Hjem","Døgn","Installasjon","Lokasjon","Brønn","Breddegrad","Lengdegrad","Sikkerhet","Merknad"]];
  for(const s of STAYS)for(const g of s.segs)rows.push([g.start,g.end,s.segs.length>1?Math.max(0,C.diffDays(g.start,g.end)):s.days,labelOf(s.key),g.site?g.site.name:"",g.site&&g.site.kind==="mobile"?(g.visit?g.visit.wells:g.site.wells).map(w=>w.name).join(" "):"",g.site?g.site.lat:"",g.site?g.site.lon:"",CONF_TXT[g.conf],g.note||""]);
  return rows;
}
function download(name,text,type){
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([text],{type}));a.download=name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500);
}
async function copyText(t){try{await navigator.clipboard.writeText(t);toast("Kopiert. Lim inn i Excel eller et regneark.")}catch(_){toast("Nettleseren tillot ikke kopiering.")}}
function confirmDialog(title,body,okText,onOk){
  const f=$("confirmForm");f.innerHTML=`<h2>${h(title)}</h2><p style="margin:0">${body}</p><div class="foot"><button class="btn ghost" value="cancel" type="submit">Avbryt</button><button class="btn accent" value="ok" type="submit">${h(okText)}</button></div>`;
  const d=$("dlgConfirm");d.onclose=()=>{if(d.returnValue==="ok")onOk()};d.showModal();
}

/* ================= mobil: bunnark og detaljkort ================= */
const MQ=matchMedia("(max-width:820px)");
function isMobile(){return MQ.matches}
/* Arket har tre stopp: «peek» (bare toppen synlig), «half» og «full». Kartet ligger alltid under i fullskjerm. */
const Sheet={
  state:"half",vis:0,el:null,
  init(){
    this.el=$("panel");
    for(const el of [$("grip"),this.el.querySelector(".brand"),this.el.querySelector(".tabs"),$("mdet")])bindSheetDrag(el);
    for(const v of ["view-stays","view-rig","view-places","mdet"])bindScrollDrag($(v));
    $("grip").addEventListener("click",()=>{if(Sheet.justDragged)return;Sheet.set({peek:"half",half:"full",full:"peek"}[Sheet.state])});
    this.el.addEventListener("focusin",e=>{const t=e.target;if(isMobile()&&t.matches&&t.matches("input:not([type=checkbox]),select,textarea")&&this.state!=="full")this.set("full")});
    addEventListener("resize",()=>this.refresh());
    MQ.addEventListener("change",()=>{if(isMobile())this.set(this.state,false);else{chart.inset=0;document.documentElement.style.removeProperty("--sheet-vis")}renderStays();updateMap()});
    if(isMobile())this.set("half",false);
  },
  snaps(){
    const H=this.el.offsetHeight,half=Math.round(Math.min(H,innerHeight*.5));
    const det=!$("mdet").hidden,anchor=det?$("mdet").querySelector(".mdet-title"):this.el.querySelector(".tabs");
    let peek=anchor?anchor.offsetTop+anchor.offsetHeight+(det?14:0):140;
    peek=Math.max(96,Math.min(half-40,peek));
    return {peek,half,full:H};
  },
  apply(v){this.vis=v;document.documentElement.style.setProperty("--sheet-vis",Math.round(v)+"px")},
  set(state,anim=true){
    if(!this.el||!isMobile())return;
    if(!anim)this.el.classList.add("dragging");
    const sn=this.snaps();this.state=state;this.apply(sn[state]);
    this.el.style.setProperty("--sheet-hidden",Math.max(0,sn.full-sn[state])+"px");
    this.el.setAttribute("data-sheet",state);
    chart.inset=Math.min(sn[state],sn.half);
    if(!anim){void this.el.offsetHeight;this.el.classList.remove("dragging")}
  },
  refresh(){if(isMobile())this.set(this.state,false)},
};
/* Fra fullt ark må kartet bli synlig før det flyr dit. */
function revealMap(){if(isMobile()&&Sheet.state==="full")Sheet.set("half")}
let drag=null;
function dragStart(y){drag={y0:y,v0:Sheet.vis,samples:[[performance.now(),Sheet.vis]]};Sheet.el.classList.add("dragging")}
function dragMove(y){
  const sn=Sheet.snaps();let v=drag.v0+(drag.y0-y);
  if(v>sn.full)v=sn.full+(v-sn.full)*.25;if(v<sn.peek)v=sn.peek-(sn.peek-v)*.35;   // gummistrikk i endene
  Sheet.apply(v);drag.samples.push([performance.now(),v]);if(drag.samples.length>6)drag.samples.shift();
}
function dragEnd(){
  Sheet.el.classList.remove("dragging");
  const sm=drag.samples,a=sm[0],b=sm[sm.length-1],vel=(b[1]-a[1])/Math.max(1,b[0]-a[0]);   // px/ms, positiv = opp
  const sn=Sheet.snaps(),order=["peek","half","full"],v=Sheet.vis,dist=v-drag.v0;let target;
  // et raskt sveip eller et tydelig drag går til neste stopp i den retningen
  if(vel>.35||(dist>70&&vel>-.1))target=order.find(k=>sn[k]>drag.v0+8)||"full";
  else if(vel<-.35||(dist<-70&&vel<.1))target=[...order].reverse().find(k=>sn[k]<drag.v0-8)||"peek";
  else target=order.reduce((best,k)=>Math.abs(sn[k]-v)<Math.abs(sn[best]-v)?k:best,"peek");
  drag=null;Sheet.set(target);
}
/* Dra i håndtaket, toppen eller overskriften i detaljkortet. Små bevegelser regnes som trykk. */
function bindSheetDrag(el){
  let p=null;
  const move=e=>{
    if(!p||e.pointerId!==p.id)return;
    if(!p.on){const dy=e.clientY-p.y,dx=e.clientX-p.x;if(Math.abs(dy)<7||Math.abs(dy)<Math.abs(dx))return;p.on=true;dragStart(p.y)}
    dragMove(e.clientY);
  };
  const up=e=>{if(!p||e.pointerId!==p.id)return;const was=p.on;p=null;
    removeEventListener("pointermove",move);removeEventListener("pointerup",up);removeEventListener("pointercancel",up);
    if(was){dragEnd();Sheet.justDragged=true;setTimeout(()=>Sheet.justDragged=false,60)}};
  el.addEventListener("pointerdown",e=>{
    if(!isMobile()||e.button>0)return;if(el.id==="mdet"&&!e.target.closest(".mdet-head"))return;
    p={id:e.pointerId,y:e.clientY,x:e.clientX,on:false};
    addEventListener("pointermove",move);addEventListener("pointerup",up);addEventListener("pointercancel",up);
  });
  el.addEventListener("click",e=>{if(Sheet.justDragged){e.stopPropagation();e.preventDefault()}},true);
}
/* I listene: dra ned når listen står øverst lukker arket, dra opp fra «peek» åpner det. Ellers vanlig scrolling. */
function bindScrollDrag(box){
  let t=null;
  const scroller=target=>box.id==="mdet"?target.closest(".mdet-body"):box;
  box.addEventListener("touchstart",e=>{
    if(!isMobile()||e.touches.length>1){t=null;return}
    const sc=scroller(e.target);if(!sc){t=null;return}
    t={sc,y:e.touches[0].clientY,top:sc.scrollTop,on:false};
  },{passive:true});
  box.addEventListener("touchmove",e=>{
    if(!t)return;const y=e.touches[0].clientY,dy=y-t.y;
    if(!t.on){
      if(Math.abs(dy)<6)return;
      const down=dy>0&&t.top<=0&&t.sc.scrollTop<=0,upFromPeek=dy<0&&Sheet.state==="peek";
      if(!(down||upFromPeek)||!e.cancelable){t=null;return}
      t.on=true;dragStart(t.y);
    }
    e.preventDefault();dragMove(y);
  },{passive:false});
  const end=()=>{if(t&&t.on)dragEnd();t=null};
  box.addEventListener("touchend",end);box.addEventListener("touchcancel",end);
}
function stayConf(s){const r={ukjent:0,usikker:1,trolig:2,manuell:3,sikker:4};return s.segs.reduce((w,g)=>r[g.conf]<r[w]?g.conf:w,"sikker")}
/* Detaljkortet viser valgt opphold øverst i arket i stedet for å folde det ut midt i listen. */
function renderMDetail(dir){
  const box=$("mdet"),panel=$("panel");
  const s=isMobile()&&S.ui.tab==="stays"&&S.ui.sel?STAYS.find(x=>x.id===S.ui.sel):null;
  if(!s){if(!box.hidden){box.hidden=true;box.innerHTML="";box.dataset.id="";panel.classList.remove("detail-open")}return}
  const same=box.dataset.id===s.id,body=box.querySelector(".mdet-body"),keep=same&&body?body.scrollTop:0;
  const vis=STAYS.filter(x=>inYear(x,S.ui.year)),i=vis.indexOf(s),older=vis[i-1],newer=vis[i+1];
  const p=S.places[s.key];
  let title,sub;
  if(s.turnback){const l=s.legs[0];title=`Snudde · ${h(l.from)}–${h(l.to)}`;sub=`<span class="mono">${C.fmtDate(s.start)}</span>`}
  else{title=instTitle(s,p);sub=`<span class="mono">${C.fmtDate(s.start)}${s.startKnown?"":"?"} – ${C.fmtDate(s.end)}${s.endKnown?"":"?"}</span>${pill(stayConf(s))}`}
  const longCls=s.long&&!S.accepted[s.id]?" long":s.over?" over":"";
  box.innerHTML=`<div class="mdet-head">
      <button class="back" type="button" data-act="mclose" aria-label="Tilbake til alle opphold"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M11 3.5 5.5 9l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="mdet-title"><h2>${title}</h2><div class="sub">${sub}</div></div>
      <div class="mdet-days${longCls}"><b>${s.turnback?0:s.days}</b><span>døgn</span></div>
      <div class="mdet-nav">
        <button class="btn small ghost" type="button" data-act="mgo" data-dir="back" data-id="${older?h(older.id):""}"${older?"":" disabled"} aria-label="Forrige tur">‹ Forrige tur</button>
        <button class="btn small ghost" type="button" data-act="mgo" data-dir="fwd" data-id="${newer?h(newer.id):""}"${newer?"":" disabled"} aria-label="Neste tur">Neste tur ›</button>
      </div>
    </div>
    <div class="mdet-body">${stayDetail(s)}</div>`;
  box.dataset.id=s.id;box.hidden=false;panel.classList.add("detail-open");
  box.querySelector(".mdet-body").scrollTop=keep;
  if(dir&&!same){box.classList.remove("enter","back-dir");void box.offsetWidth;box.classList.add("enter");if(dir==="back")box.classList.add("back-dir")}
}
function closeMDetail(){
  const id=S.ui.sel;S.ui.sel=null;renderStays();updateMap();Sheet.refresh();
  const row=id&&document.querySelector(`#view-stays .stay[data-stay="${CSS.escape(id)}"]`);
  if(row){const v=$("view-stays");v.scrollTop=Math.max(0,row.offsetTop-v.offsetTop-v.clientHeight/4);row.classList.add("sel");setTimeout(()=>row.classList.remove("sel"),900)}
}

/* ================= events ================= */
document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-act]");
  if(!b){
    if(!e.target.closest("#menu,#btnMenu"))$("menu").hidden=true;
    const st=e.target.closest(".stay");
    if(st&&!e.target.closest("[data-stop]")){selectStay(st.dataset.stay)}
    return;
  }
  const act=b.dataset.act;$("menu").hidden=true;
  if(act==="pick")$("file").click();
  else if(act==="add")openAddDialog();
  else if(act==="rigtab")switchTab("rig");
  else if(act==="placestab")switchTab("places");
  else if(act==="allyears"){S.ui.year=null;renderStays();updateMap();fitToContent()}
  else if(act==="csv")download("sokkelreiser-opphold.csv","﻿"+C.toCSV(stayTable()),"text/csv;charset=utf-8");
  else if(act==="copy")copyText(C.toCSV(stayTable(),"\t"));
  else if(act==="save")download("sokkelreiser-prosjekt.json",JSON.stringify({app:"sokkelreiser",version:1,saved:new Date().toISOString(),sourceName:S.sourceName,legs:S.legs,places:S.places,manual:S.manual,overrides:S.overrides,accepted:S.accepted,flotelAt:S.flotelAt}),"application/json");
  else if(act==="koder")download("koder.json",JSON.stringify({app:"sokkelreiser",version:1,koder:koderPayload()},null,2),"application/json");
  else if(act==="paste"){
    confirmDialog("Lim inn reiser","Marker tabellen med reiser i MinDaVinci (hold fingeren på teksten og dra, eller «Velg alle»), kopier og lim inn her. Overskriftene (Dato, Fra, Til …) må være med. Ingenting sendes noe sted.",
      "Les inn",()=>{const t=($("pasteTxt")||{}).value||"";if(t.trim())handleFile(new File([t],"innlimt-tabell.csv",{type:"text/csv"}));else toast("Ingenting å lese inn.")});
    const f=$("confirmForm");f.querySelector("p").insertAdjacentHTML("afterend",'<textarea id="pasteTxt" class="input" rows="8" style="width:100%;margin-top:10px;font:12px/1.4 monospace" placeholder="Lim inn her …" spellcheck="false"></textarea>');
    setTimeout(()=>{const x=$("pasteTxt");if(x)x.focus()},50);
  }
  else if(act==="share"){
    const k=koderPayload(),fr=flotelReports();if(!Object.keys(k).length&&!fr.length){toast("Du har ingen koblinger å dele ennå.");return}
    confirmDialog("Foreslå koder og flotellplasseringer","Det som sendes er kodene og navnene de er koblet til (for eksempel «SKV → SKARV»), og hvilket felt en flotell lå ved i en gitt måned (for eksempel «Floatel Endurance · Skarv · 2026-03»). Ingen datoer, reiser, firma eller personopplysninger. Du åpner et ferdig utfylt forslag hos GitHub, og du bestemmer selv om du sender det.","Åpne forslag",()=>{
      const body="Koder fra min logg og innretningene de hører til hos Sodir:\n\n```json\n"+JSON.stringify({koder:k,floteller:fr},null,2)+"\n```\n";
      const url="https://github.com/oyvindhn/sokkelreiser.no/issues/new?title="+encodeURIComponent("Forslag til kodelisten")+"&body="+encodeURIComponent(body);
      if(!window.open(url,"_blank","noopener"))copyText(JSON.stringify(k,null,2));
    });
  }
  else if(act==="sodir"){const ok=await loadFacilities(true);if(ok){await Promise.all([loadAliases(true),loadActivity(true)]);applyCodeList();autoLink();persist();await recompute();toast("Sodir-data er oppdatert.")}else toast("Fikk ikke kontakt med Sodir.")}
  else if(act==="clear")confirmDialog("Slette alle data?","Reiseloggen, koblingene og lagret Sodir-data fjernes fra denne nettleseren. Lagre en prosjektfil først hvis du vil beholde arbeidet.","Slett alt",()=>{for(const k of store.keys())store.del(k);location.reload()});
  else if(act==="openrig")openRig(b.dataset.id,b.dataset.date);
  else if(act==="pickstay")startPick("stay",b.dataset.id,"Klikk der du var på denne turen");
  else if(act==="acceptlong"){S.accepted[b.dataset.id]=true;persist();renderStays();updateMap()}
  else if(act==="unacceptlong"){delete S.accepted[b.dataset.id];persist();renderStays();updateMap()}
  else if(act==="unpickstay"){delete S.overrides[b.dataset.id];persist();recompute()}
  else if(act==="delmanual"){S.manual=S.manual.filter(m=>m.id!==b.dataset.id);S.ui.sel=null;persist();recompute()}
  else if(act==="editplace"){S.ui.openPlace=b.dataset.key;switchTab("places");renderPlaces()}
  else if(act==="toggleplace"){S.ui.openPlace=S.ui.openPlace===b.dataset.key?null:b.dataset.key;renderPlaces();const i=$("placeq");if(i)i.focus()}
  else if(act==="linkfac"){const f=D.facById.get(b.dataset.id);linkPlace(b.dataset.key,{type:"sodir",id:b.dataset.id},f?C.titleCase(f.name):null)}
  else if(act==="unlink"){const p=S.places[b.dataset.key];p.link=null;p.auto=false;persist();recompute()}
  else if(act==="approve"){S.places[b.dataset.key].auto=false;persist();renderPlaces();renderPlaceCount()}
  else if(act==="approveall"){for(const p of Object.values(S.places))p.auto=false;persist();renderPlaces();renderPlaceCount()}
  else if(act==="setbase"){const p=S.places[b.dataset.key];p.kind="base";p.kindEdited=true;p.link=null;p.auto=false;if(!p.labelEdited)p.label=p.raw;persist();recompute()}
  else if(act==="setinst"){const p=S.places[b.dataset.key];p.kind="installation";p.kindEdited=true;if(!p.labelEdited)p.label=p.nameHint||p.raw;persist();recompute()}
  else if(act==="pickplace")startPick("place",b.dataset.key,"Klikk der installasjonen ligger");
  else if(act==="mclose")closeMDetail();
  else if(act==="mgo")selectStay(b.dataset.id,b.dataset.dir);
});
document.addEventListener("change",e=>{
  const t=e.target;if(!t||t.id!=="flotat")return;
  const st=STAYS.find(x=>x.id===t.dataset.id);
  if(t.value)S.flotelAt[t.dataset.id]={felt:t.value,inst:""};else delete S.flotelAt[t.dataset.id];
  persist();recompute();toast(t.value?"Takk! Plasseringen er lagret.":"Svaret ditt er fjernet.");
});
document.addEventListener("keydown",e=>{
  if((e.key==="Enter"||e.key===" ")&&e.target.classList&&e.target.classList.contains("stay")){e.preventDefault();selectStay(e.target.dataset.stay)}
  if(e.key==="Escape"&&S.ui.pick)endPick();
  else if(e.key==="Escape"&&isMobile()&&S.ui.sel)closeMDetail();
});
function selectStay(id,dir){
  const mob=isMobile();
  S.ui.sel=mob?id:(S.ui.sel===id?null:id);renderStays.scroll=true;renderStays();updateMap();
  if(mob){renderMDetail(dir||"fwd");if(S.ui.sel&&Sheet.state!=="half")Sheet.set("half");else Sheet.refresh()}
  const s=STAYS.find(x=>x.id===S.ui.sel);if(!s)return;
  const pts=s.segs.filter(g=>g.site).map(g=>[g.site.lat,g.site.lon]);
  if(pts.length===1)chart.flyTo(pts[0][0],pts[0][1],Math.max(chart.z,7));else if(pts.length)chart.fit(pts);
}
for(const b of document.querySelectorAll(".tab"))b.addEventListener("click",()=>{if(isMobile()&&Sheet.state==="peek")Sheet.set("half");switchTab(b.dataset.tab);if(b.dataset.tab!=="places")fitToContent()});
$("btnImport").addEventListener("click",()=>$("file").click());
$("file").addEventListener("change",e=>{const f=e.target.files[0];if(f)handleFile(f);e.target.value=""});
$("btnMenu").addEventListener("click",()=>{const m=$("menu");m.hidden=!m.hidden;$("btnMenu").setAttribute("aria-expanded",String(!m.hidden));if(!m.hidden&&isMobile())Sheet.set("full")});
$("zlayers").addEventListener("click",()=>{const l=$("legend"),on=!l.classList.contains("open");l.classList.toggle("open",on);$("zlayers").setAttribute("aria-expanded",String(on))});
$("zin").addEventListener("click",()=>chart.zoomAt(2));
$("zout").addEventListener("click",()=>chart.zoomAt(.5));
$("zfit").addEventListener("click",fitToContent);
for(const [id,key] of [["optRoutes","routes"],["optDrift","drift"],["optNames","names"]]){const el=$(id);el.checked=MAPOPT[key];el.addEventListener("change",()=>{MAPOPT[key]=el.checked;store.set("mapopt",MAPOPT);chart.fullNames=MAPOPT.names;updateMap();chart.req()})}

/* ================= boot ================= */
chart=new Chart($("map"));chart.fullNames=MAPOPT.names;
Sheet.init();
const tip=$("tip");
chart.cb.hover=(m,p,geo)=>{
  $("readout").textContent=geo?fmtPos(geo[0],geo[1]):"";
  const hid=m&&!m.port?m.id:null;if(hid!==(chart.hoverId||null)){chart.hoverId=hid;chart.req()}
  if(!m||!p){tip.hidden=true;$("map").style.cursor="";return}
  $("map").style.cursor="pointer";
  const d=m.data||{};const s=d.site||{};
  let body="";
  if(d.port){body=`<span class="mono">Heliport</span><br>${d.n} ${plural(d.n,"flyreise","flyreiser")}`}
  else if(d.rig){const n=s.wells.length;body=`<span class="mono">${h(s.sub||s.well)}</span><br>${n} ${plural(n,"brønn","brønner")} · ${s.wells[0].entry.slice(0,4)}–${(s.wells[n-1].comp||s.wells[n-1].entry).slice(0,4)}`}
  else body=`${d.stays?d.stays.size:0} ${plural(d.stays?d.stays.size:0,"tur","turer")} · ${d.days||0} døgn${s.sub&&s.kind==="mobile"?`<br><span class="mono">${h(s.sub)}</span>`:""}`;
  tip.innerHTML=m.port?`<b>${h(m.label)}</b>${body}`:body;tip.hidden=false;
  const W=chart.W;tip.style.left=Math.min(p[0],W-270)+"px";tip.style.top=(p[1]+(m.port?0:34))+"px";
};
chart.cb.click=(m,geo)=>{
  if(S.ui.pick){
    const pk=S.ui.pick;endPick();
    if(pk.kind==="stay"){const s=STAYS.find(x=>x.id===pk.id);S.overrides[pk.id]={lat:+geo[0].toFixed(5),lon:+geo[1].toFixed(5),label:s?labelOf(s.key):""}}
    else{const p=S.places[pk.id];if(p){p.link={type:"manual",lat:+geo[0].toFixed(5),lon:+geo[1].toFixed(5)};p.auto=false;p.kind="installation"}}
    persist();toast("Posisjonen er lagret.");recompute();return;
  }
  if(isMobile()){const l=$("legend");if(l.classList.contains("open")){l.classList.remove("open");$("zlayers").setAttribute("aria-expanded","false");if(!m)return}}
  if(!m||m.port){if(isMobile()&&!m&&Sheet.state!=="peek")Sheet.set("peek");return}
  if(S.ui.tab==="rig"&&m.data&&m.data.rig){S.ui.rigSel=m.id;renderRig();updateMap();if(isMobile()&&Sheet.state==="peek")Sheet.set("half");const el=document.querySelector(`.visit[data-site="${CSS.escape(m.id)}"]`);el&&el.scrollIntoView({block:isMobile()?"center":"nearest",behavior:isMobile()?"smooth":"auto"});return}
  const st=STAYS.filter(s=>s.segs.some(g=>g.site&&g.site.id===m.id)&&inYear(s,S.ui.year)).pop()||STAYS.filter(s=>s.segs.some(g=>g.site&&g.site.id===m.id)).pop();
  if(st){if(S.ui.tab!=="stays")switchTab("stays");S.ui.sel=null;selectStay(st.id)}
};
const themeObs=()=>{chart.col=null;chart.req()};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change",themeObs);
new MutationObserver(themeObs).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","class"]});
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(themeObs);

(async function boot(){
  restoreSodirFile();
  const ff=store.get("sodir:facfile",null);
  await recompute();
  if(isMobile())Sheet.set("half",false);
  if(STAYS.length)fitToContent();
  const ok=await loadFacilities(false);
  if(ff&&ff.list){const m=new Map(D.facilities.map(f=>[f.id,f]));for(const f of ff.list)m.set(f.id,{...m.get(f.id),...f});setFacilities([...m.values()],D.status,D.stamp)}
  if(!ok&&D.fileWellbores){D.status="file";renderSource()}
  if(D.fileWellbores&&!D.facilities.length){
    const known=new Map();for(const [id,l] of D.fileWellbores)known.set(id,{id,name:l[0].facility,kind:l[0].facilityKind,moveable:l[0].moveable,lat:null,lon:null,url:""});
    setFacilities([...known.values()],"file",store.get("sodir:wbfile",{}).ts);
  }
  await loadCodeList();
  if(applyCodeList())persist();
  if(D.facilities.length)await Promise.all([loadAliases(false),loadActivity(false)]);
  if(applyCodeList())persist();   // på nytt: tidligere navn fra Sodir er lastet nå
  if(autoLink())persist();
  await recompute();
  if(STAYS.length)fitToContent();
  if(S.ui.tab==="rig")renderRig();
})();
})();
