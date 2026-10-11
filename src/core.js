/* Sokkelreiser core — pure logic (import, matching, stays, position lookup). No DOM. */
(function(root){
"use strict";
const DAY=86400000;

/* ---------- dates ---------- */
function pad(n){return String(n).padStart(2,"0")}
function isoFromDate(d){return d.getUTCFullYear()+"-"+pad(d.getUTCMonth()+1)+"-"+pad(d.getUTCDate())}
function toDay(iso){return Math.round(Date.parse(iso+"T00:00:00Z")/DAY)}
function fromDay(n){return isoFromDate(new Date(n*DAY))}
function addDays(iso,n){return fromDay(toDay(iso)+n)}
function diffDays(a,b){return toDay(b)-toDay(a)}
function todayIso(){const d=new Date();return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
function excelSerialToIso(n,date1904){
  const epoch=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,30);
  return isoFromDate(new Date(epoch+Math.floor(n)*DAY));
}
function parseDate(v,date1904){
  if(v==null||v==="")return "";
  if(typeof v==="number"&&isFinite(v)){
    if(v>20000&&v<80000)return excelSerialToIso(v,date1904);
    if(v>1e11)return isoFromDate(new Date(v)); // epoch ms
    return "";
  }
  if(v instanceof Date&&!isNaN(v))return isoFromDate(v);
  const s=String(v).trim();
  let m=/^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if(m)return m[1]+"-"+pad(+m[2])+"-"+pad(+m[3]);
  m=/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(s);
  if(m){let y=+m[3];if(y<100)y+=y>60?1900:2000;return y+"-"+pad(+m[2])+"-"+pad(+m[1])}
  m=/^(\d{1,2})\.?\s*([a-zæøå]{3,})\.?\s+(\d{4})/i.exec(s);
  if(m){
    const mon=["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"],en=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const k=m[2].slice(0,3).toLowerCase();let i=mon.indexOf(k);if(i<0)i=en.indexOf(k);
    if(i>=0)return m[3]+"-"+pad(i+1)+"-"+pad(+m[1]);
  }
  if(/^\d{5}(\.\d+)?$/.test(s))return excelSerialToIso(+s,date1904);
  return "";
}
function fmtDate(iso,withYear=true){
  if(!iso)return "?";
  const [y,m,d]=iso.split("-");
  return withYear?`${d}.${m}.${y}`:`${d}.${m}`;
}

/* ---------- text ---------- */
function clean(v){return v==null?"":String(v).replace(/\s+/g," ").trim()}
function normName(s){
  return clean(s).toUpperCase()
    .replace(/Æ/g,"AE").replace(/Ø/g,"O").replace(/Å/g,"A").replace(/Ä/g,"A").replace(/Ö/g,"O").replace(/Ü/g,"U").replace(/É/g,"E")
    .replace(/[^A-Z0-9]+/g," ").trim();
}
const GENERIC=new Set(["THE","AS","ASA","RIG","PLATFORM","PLATTFORM","INSTALLASJON","INSTALLATION","OFFSHORE","DRILLING","SEMI","SUB","JACKUP","JACK","UP","UNIT","FIELD","FELT","FELTET"]);
function tokens(s){return normName(s).split(" ").filter(t=>t&&!GENERIC.has(t))}
function nameScore(q,target){
  const a=normName(q),b=normName(target);
  if(!a||!b)return 0;
  if(a===b)return 1;
  const ta=tokens(q),tb=tokens(target);
  if(!ta.length||!tb.length)return 0;
  const sa=new Set(ta),sb=new Set(tb);
  let inter=0;for(const t of sa)if(sb.has(t))inter++;
  if(ta.join(" ")===tb.join(" "))return .97;
  if(inter===sa.size)return Math.max(.6,.9-.06*(sb.size-inter));          // all query tokens present
  if(inter===sb.size)return Math.max(.55,.85-.06*(sa.size-inter));        // target fully inside query
  const distinctive=[...sa].filter(t=>sb.has(t)&&t.length>=5).length;
  const jac=inter/(sa.size+sb.size-inter);
  return Math.min(.7,jac*.8+(distinctive?.25:0));
}

/* ---------- CSV ---------- */
function parseCSV(text){
  text=String(text).replace(/^﻿/,"");
  const first=text.split(/\r?\n/).slice(0,5).join("\n");
  const cand=[";",",","\t"];let delim=",",best=-1;
  for(const c of cand){const n=first.split(c).length;if(n>best){best=n;delim=c}}
  const rows=[];let row=[],cur="",q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){
      if(ch==='"'){if(text[i+1]==='"'){cur+='"';i++}else q=false}
      else cur+=ch;
    }else if(ch==='"')q=true;
    else if(ch===delim){row.push(cur);cur=""}
    else if(ch==="\n"||ch==="\r"){
      if(ch==="\r"&&text[i+1]==="\n")i++;
      row.push(cur);cur="";if(row.some(c=>c!==""))rows.push(row);row=[];
    }else cur+=ch;
  }
  row.push(cur);if(row.some(c=>c!==""))rows.push(row);
  return rows;
}

/* ---------- XLSX (minimal reader, browser only) ---------- */
function xmlDecode(s=""){return String(s).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/&amp;/g,"&")}
function xattrs(s=""){const o={};String(s).replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g,(_,k,v)=>{o[k]=xmlDecode(v);return""});return o}
function colIndex(ref="A1"){const m=/^([A-Z]+)/i.exec(ref);if(!m)return 0;let n=0;for(const ch of m[1].toUpperCase())n=n*26+(ch.charCodeAt(0)-64);return n-1}
async function unzip(ab){
  const u8=new Uint8Array(ab),dv=new DataView(ab);let eocd=-1;
  for(let i=u8.length-22;i>=Math.max(0,u8.length-65557);i--){if(dv.getUint32(i,true)===0x06054b50){eocd=i;break}}
  if(eocd<0)throw new Error("Filen ser ikke ut som en Excel-fil (.xlsx).");
  const count=dv.getUint16(eocd+10,true);let p=dv.getUint32(eocd+16,true);const entries=new Map();
  for(let i=0;i<count;i++){
    if(dv.getUint32(p,true)!==0x02014b50)break;
    const method=dv.getUint16(p+10,true),comp=dv.getUint32(p+20,true),nlen=dv.getUint16(p+28,true),xlen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true),loff=dv.getUint32(p+42,true);
    const name=new TextDecoder().decode(u8.slice(p+46,p+46+nlen));
    entries.set(name,{method,comp,loff});p+=46+nlen+xlen+clen;
  }
  return {
    has:n=>entries.has(n),
    async text(name){
      const e=entries.get(name);if(!e)return null;
      const q=e.loff,n=dv.getUint16(q+26,true),x=dv.getUint16(q+28,true),start=q+30+n+x,data=u8.slice(start,start+e.comp);
      if(e.method===0)return new TextDecoder().decode(data);
      if(e.method!==8)throw new Error("Excel-filen bruker en komprimering som ikke støttes.");
      if(typeof DecompressionStream==="undefined")throw new Error("Nettleseren kan ikke lese .xlsx lokalt. Bruk en oppdatert Chrome, Edge, Safari eller Firefox – eller lagre arket som CSV.");
      const out=await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
      return new TextDecoder().decode(out);
    }
  };
}
function sheetMatrix(xml,shared){
  const rows=[];const rowRe=/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g;let rm;
  while((rm=rowRe.exec(xml))){
    const cells=[],cellRe=/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;let cm;
    while((cm=cellRe.exec(rm[1]))){
      const at=xattrs(cm[1]),idx=colIndex(at.r||"A1"),inner=cm[2]||"";let v="";
      if(at.t==="inlineStr")v=[...inner.matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(x=>xmlDecode(x[1])).join("");
      else{
        const vm=/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner),raw=vm?xmlDecode(vm[1]):"";
        if(at.t==="s")v=shared[+raw]??"";
        else if(at.t==="str"||at.t==="e")v=raw;
        else if(at.t==="b")v=raw==="1";
        else if(raw!==""&&!isNaN(+raw))v=+raw;
        else v=raw;
      }
      cells[idx]=v;
    }
    for(let i=0;i<cells.length;i++)if(cells[i]===undefined)cells[i]="";
    if(cells.some(v=>v!==""))rows.push(cells);
  }
  return rows;
}
async function readXlsx(ab){
  const z=await unzip(ab);
  const wb=await z.text("xl/workbook.xml");if(!wb)throw new Error("Fant ingen arbeidsbok i Excel-filen.");
  const rels=await z.text("xl/_rels/workbook.xml.rels")||"";const relMap={};
  for(const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)){const a=xattrs(m[1]);relMap[a.Id]=a.Target}
  const date1904=/date1904="(1|true)"/i.test(wb);
  const sst=await z.text("xl/sharedStrings.xml"),shared=[];
  if(sst)for(const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g))
    shared.push([...m[1].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(x=>xmlDecode(x[1])).join(""));
  const sheets=[];
  for(const m of wb.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)){
    const a=xattrs(m[1]);let t=relMap[a["r:id"]];if(!t)continue;
    t=t.replace(/\\/g,"/").replace(/^\//,"");if(!t.startsWith("xl/"))t="xl/"+t.replace(/^(\.\.\/)+/,"").replace(/^\.\//,"");
    const xml=await z.text(t);if(xml)sheets.push({name:a.name||t,rows:sheetMatrix(xml,shared)});
  }
  return {sheets,date1904};
}

/* ---------- column detection ---------- */
const FIELDS={
  date:{label:"Dato",req:true,re:[/^(date|dato|flight ?date|travel ?date|reisedato|flydato|dep(arture)? ?date|avreisedato)$/i,/dato|date/i],not:/update|endret|year|år$/i},
  from:{label:"Fra",re:[/^(from|fra|origin|fra ?sted|from ?location)$/i,/^fra\b|^from\b/i]},
  to:{label:"Til",re:[/^(to|til|destination|til ?sted|to ?location)$/i,/^til\b|^to\b/i]},
  dep:{label:"Avg.",re:[/^(avg|avgang|avreise|dep|departure|dep ?time)$/i]},
  arr:{label:"Ank.",re:[/^(ank|ankomst|arr|arrival|arr ?time)$/i]},
  checked:{label:"Sjekket inn",re:[/^(sjekket ?inn|checked ?in)$/i]},
  tripType:{label:"Reise type",re:[/^(reise ?type|trip ?type)$/i]},
  inst:{label:"Installasjon",re:[/^(offshore ?installation|installation|installasjon|innretning|rig|rigg|platform|plattform|asset|location)$/i,/installa|innretning|rigg?\b|platt?form/i]},
  dir:{label:"Retning",re:[/^(direction|retning|leg|type)$/i,/direction|retning/i]},
  status:{label:"Status",re:[/^(bestillings ?status|booking ?status|status)$/i,/status/i]},
  route:{label:"Rute / flight",re:[/^(rutenr|rute ?nr|route ?no|route|rute|flight|flight ?no|flightnr)$/i,/route|rute|flight/i]},
  company:{label:"Selskap",re:[/^(company|selskap|firma|employer|arbeidsgiver)$/i]},
  purpose:{label:"Formål",re:[/^(purpose|formål|reason)$/i]},
  ref:{label:"Referanse",re:[/^(reference|referanse|booking ?ref(erence)?|ref)$/i]}
};
const hkey=h=>clean(h).replace(/[.:]+$/,"").trim();
function findHeaderRow(rows){
  let best=-1,bestScore=0;
  for(let i=0;i<Math.min(rows.length,20);i++){
    const hs=rows[i].map(hkey);let score=0;
    for(const k in FIELDS)if(hs.some(h=>FIELDS[k].re[0].test(h)))score+=FIELDS[k].req?3:1;
    if(score>bestScore){bestScore=score;best=i}
  }
  return bestScore>=2?best:-1;
}
function guessColumns(headers){
  const used=new Set(),map={};
  for(const pass of [0,1])for(const k in FIELDS){
    if(map[k]!=null)continue;const f=FIELDS[k];if(!f.re[pass])continue;
    const i=headers.findIndex((h,ix)=>!used.has(ix)&&h&&f.re[pass].test(hkey(h))&&!(f.not&&f.not.test(hkey(h))&&!f.re[0].test(hkey(h))));
    if(i>=0){map[k]=i;used.add(i)}
  }
  return map;
}
function isSodirWellbore(headers){return headers.some(h=>/^wlbWellboreName$/i.test(clean(h)))}
function isSodirFacility(headers){return headers.some(h=>/^fclName$/i.test(clean(h)))}
/* Pick the sheet that looks most like a trip log. */
function analyseTables(tables){
  const out=[];
  for(const t of tables){
    const hi=findHeaderRow(t.rows);
    const headers=hi>=0?t.rows[hi].map(clean):(t.rows[0]||[]).map(clean);
    const body=t.rows.slice((hi>=0?hi:0)+1);
    let kind="trips";
    if(isSodirWellbore(headers))kind="sodir-wellbore";else if(isSodirFacility(headers))kind="sodir-facility";
    const cols=guessColumns(headers);
    let score=(cols.date!=null?3:0)+(cols.to!=null?2:0)+(cols.inst!=null?2:0)+(cols.from!=null?1:0)+(/offshore|heli|reise|trip|travel/i.test(t.name)?2:0);
    out.push({name:t.name,headers,body,cols,kind,score:kind==="trips"?score:0,rowCount:body.length});
  }
  return out;
}

/* ---------- legs ---------- */
const CANCEL_RE=/(cancel|kansell|avbestil|no.?show|ikke reist|not flown|strøket|annul)/i;
const DIR_OUT=/^(out|ut|utreise|outbound|offshore|til offshore|to offshore|ut ?reise)\b|outbound|utreise/i;
const DIR_IN=/^(in|inn|hjem|home|inbound|return|retur|onshore|til land|to shore)\b|inbound|hjemreise|retur/i;
function fmtTime(v){
  if(v==null||v==="")return "";
  if(typeof v==="number"&&isFinite(v)){const f=v-Math.floor(v);if(f===0&&v>=1)return "";const m=Math.round(f*1440)%1440;return pad(Math.floor(m/60))+":"+pad(m%60)}
  const m=/(?:^|[^\d])(\d{1,2}):(\d{2})/.exec(String(v));return m?pad(+m[1])+":"+m[2]:"";   // «05.08.2026 11:41» -> 11:41
}
function buildLegs(table,cols,date1904){
  const g=(r,k)=>cols[k]!=null?r[cols[k]]:"";
  const legs=[];
  table.body.forEach((r,i)=>{
    const date=parseDate(g(r,"date"),date1904);
    if(!date)return;
    const from=clean(g(r,"from")),to=clean(g(r,"to")),inst=clean(g(r,"inst"));
    if(!from&&!to&&!inst)return;
    const status=clean(g(r,"status")),dirRaw=clean(g(r,"dir"));
    const dir=DIR_OUT.test(dirRaw)?"out":DIR_IN.test(dirRaw)?"in":"";
    legs.push({i,date,from,to,inst,dir,dirRaw,status,route:clean(g(r,"route")),dep:fmtTime(g(r,"dep")),arr:fmtTime(g(r,"arr")),checked:fmtTime(g(r,"checked"))||clean(g(r,"checked")),tripType:clean(g(r,"tripType")),company:clean(g(r,"company")),purpose:clean(g(r,"purpose")),ref:clean(g(r,"ref")),cancelled:CANCEL_RE.test(status)});
  });
  legs.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:a.i-b.i);
  return legs;
}

/* ---------- places (codes / names in the log) ---------- */
function placeKey(s){return normName(s)}
function derivePlaces(legs){
  const P=new Map();
  const hasEnds=legs.some(l=>l.from||l.to);
  // Uten retnings- og installasjonskolonne: en landbase har flere ulike partnere enn en installasjon.
  const nb=new Map();
  for(const l of legs){if(l.cancelled||!l.from||!l.to)continue;const a=placeKey(l.from),b=placeKey(l.to);
    if(!nb.has(a))nb.set(a,new Set());if(!nb.has(b))nb.set(b,new Set());nb.get(a).add(b);nb.get(b).add(a)}
  const deg=k=>nb.has(k)?nb.get(k).size:0;
  const get=(raw)=>{const k=placeKey(raw);if(!k)return null;if(!P.has(k))P.set(k,{key:k,raw:clean(raw),rows:0,names:new Map(),asFrom:0,asTo:0,first:null,votesInst:0,votesBase:0});return P.get(k)};
  for(const l of legs){
    if(l.cancelled)continue;
    if(hasEnds){
      const a=l.from?get(l.from):null,b=l.to?get(l.to):null;
      for(const [p,role] of [[a,"from"],[b,"to"]]){
        if(!p)continue;p.rows++;role==="from"?p.asFrom++:p.asTo++;if(!p.first)p.first=role;
        if(l.inst)p.names.set(l.inst,(p.names.get(l.inst)||0)+1);
      }
      if(l.dir==="out"){if(b)b.votesInst++;if(a)a.votesBase++}
      if(l.dir==="in"){if(a)a.votesInst++;if(b)b.votesBase++}
      if(l.inst){
        const ni=placeKey(l.inst);
        if(a&&ni===a.key)a.votesInst+=2;
        if(b&&ni===b.key)b.votesInst+=2;
      }else if(!l.dir&&a&&b&&deg(a.key)!==deg(b.key)){
        const lo=deg(a.key)<deg(b.key)?a:b,hi=lo===a?b:a;lo.votesInst++;hi.votesBase++;
      }
    }else if(l.inst){
      const p=get(l.inst);p.rows++;p.names.set(l.inst,(p.names.get(l.inst)||0)+1);p.votesInst++;
    }
  }
  const nameRows=new Map();
  for(const l of legs)if(!l.cancelled&&l.inst)nameRows.set(l.inst,(nameRows.get(l.inst)||0)+1);
  const out=[];
  for(const p of P.values()){
    let bestName="",bestN=0;for(const [n,c] of p.names)if(c>bestN){bestN=c;bestName=n}
    const share=p.rows?bestN/p.rows:0;
    const fullCover=bestName&&bestN===nameRows.get(bestName);   // the code is on every row naming this installation
    let inst;
    if(p.votesInst||p.votesBase)inst=p.votesInst>p.votesBase;
    else if(!p.names.size)inst=p.first==="to";
    else inst=(fullCover?1:0)+(p.first==="to"?1:0)+(share>=.6?.5:0)>=2;
    out.push({key:p.key,raw:p.raw,label:inst&&bestName?bestName:p.raw,nameHint:bestName,share,rows:p.rows,guess:inst?"installation":"base"});
  }
  out.sort((a,b)=>b.rows-a.rows);
  return out;
}

/* ---------- koder -> navn ---------- */
/* Forslag til hva en kort kode står for: bokstavene i koden må forekomme i rekkefølge i navnet,
   og første bokstav må starte et ord. Brukes bare som forslag, aldri som automatisk kobling. */
function codeScore(code,name){
  const c=normName(code).replace(/ /g,"");
  if(c.length<2||c.length>6||/\d/.test(c))return 0;
  const words=normName(name).split(" ").filter(Boolean);if(!words.length)return 0;
  const flat=words.join(""),starts=new Set();let pos=0;for(const w of words){starts.add(pos);pos+=w.length}
  let i=0,startHits=0;
  for(let k=0;k<c.length;k++){
    let j=-1;
    if(k===0){for(const s of [...starts].sort((a,b)=>a-b))if(flat[s]===c[0]){j=s;break}}
    else j=flat.indexOf(c[k],i);
    if(j<0)return 0;
    if(starts.has(j))startHits++;
    i=j+1;
  }
  return Math.min(.85,.4+.1*startHits+(c[0]===flat[0]?.15:0)-.002*flat.length);
}

/* ---------- stays ---------- */
/* kindOf(key) -> "installation" | "base" */
function buildStays(legs,kindOf){
  const stays=[];let cur=null;
  const hasEnds=legs.some(l=>l.from||l.to);
  const open=(key,date,leg)=>{cur={key,start:date,end:null,startKnown:true,endKnown:false,legs:[leg]};stays.push(cur)};
  const close=(date,leg)=>{if(!cur)return;cur.end=date;cur.endKnown=true;if(leg&&!cur.legs.includes(leg))cur.legs.push(leg);cur=null};
  for(const l of legs){
    if(l.cancelled)continue;
    if(hasEnds){
      const fk=l.from?placeKey(l.from):"",tk=l.to?placeKey(l.to):"";
      const fI=fk&&kindOf(fk)==="installation",tI=tk&&kindOf(tk)==="installation";
      if(fI){
        if(cur&&cur.key===fk){ if(!(tI&&tk===fk)) close(l.date,l) }
        else if(!(tI&&tk===fk)){ // left an installation we never saw arriving at
          if(cur)close(l.date,null);
          stays.push({key:fk,start:l.date,end:l.date,startKnown:false,endKnown:true,legs:[l]});
        }
      }
      if(tI){
        if(cur&&cur.key===tk){cur.legs.push(l)}
        else{if(cur)close(l.date,l);open(tk,l.date,l)}
      }
      if(!fI&&!tI&&cur&&!fk&&!tk)cur.legs.push(l);
    }else{
      const k=placeKey(l.inst);if(!k||kindOf(k)!=="installation")continue;
      if(l.dir==="in"){
        if(cur&&cur.key===k)close(l.date,l);
        else stays.push({key:k,start:l.date,end:l.date,startKnown:false,endKnown:true,legs:[l]});
      }else if(l.dir==="out"){
        if(cur)close(l.date,null);open(k,l.date,l);
      }else{ // no direction: consecutive rows on the same installation within 42 days form one stay
        if(cur&&cur.key===k&&diffDays(cur.lastSeen||cur.start,l.date)<=42){cur.end=l.date;cur.endKnown=true;cur.lastSeen=l.date;cur.legs.push(l)}
        else{if(cur&&!cur.end)cur.end=cur.start;open(k,l.date,l);cur.lastSeen=l.date}
      }
    }
  }
  const today=todayIso();
  for(const s of stays){
    if(!s.end){s.end=s.start>today?s.start:(diffDays(s.start,today)<=28?today:s.start);s.endKnown=false;s.ongoing=diffDays(s.start,today)<=28}
    delete s.lastSeen;
    s.days=Math.max(0,diffDays(s.start,s.end));
    s.id=s.key+"@"+s.start;
    s.long=s.days>45;
  }
  return stays;
}

/* ---------- Sodir records ---------- */
function geoOf(attrs,geom){
  if(geom&&isFinite(geom.y)&&isFinite(geom.x)&&!(geom.x===0&&geom.y===0))return [geom.y,geom.x];
  const la=+attrs.wlbNsDecDeg||+attrs.fclNsDecDeg,lo=+attrs.wlbEwDecDeg||+attrs.fclEwDecDeg;
  if(la&&lo)return [la,lo];
  if(attrs.fclNsDeg!=null&&attrs.fclNsDeg!==""&&attrs.fclEwDeg!=null&&attrs.fclEwDeg!==""){
    let la2=+attrs.fclNsDeg+(+attrs.fclNsMin||0)/60+(+attrs.fclNsSec||0)/3600;
    let lo2=+attrs.fclEwDeg+(+attrs.fclEwMin||0)/60+(+attrs.fclEwSec||0)/3600;
    if(/S/i.test(attrs.fclNsCode||""))la2=-la2;if(/W/i.test(attrs.fclEwCode||""))lo2=-lo2;
    if(la2&&lo2)return [la2,lo2];
  }
  return null;
}
function normFacility(a,geom){
  const id=a.fclNpdidFacility!=null&&a.fclNpdidFacility!==""?String(a.fclNpdidFacility):"name:"+normName(a.fclName);
  const pos=geoOf(a,geom);
  return {id,name:clean(a.fclName),kind:clean(a.fclKind),moveable:/MOV/i.test(a.fclFixedOrMoveable||""),phase:clean(a.fclPhase),
    functions:clean(a.fclFunctions),belongsTo:clean(a.fclBelongsToName),operator:clean(a.fclCurrentOperatorName||a.fclCurrentRespCompanyName),
    url:clean(a.fclFactPageUrl),lat:pos?+pos[0].toFixed(5):null,lon:pos?+pos[1].toFixed(5):null};
}
function normWellbore(a,geom){
  const pos=geoOf(a,geom);
  return {name:clean(a.wlbWellboreName),well:clean(a.wlbWell),entry:parseDate(a.wlbEntryDate),comp:parseDate(a.wlbCompletionDate),
    field:clean(a.wlbField),discovery:clean(a.wlbDiscovery),purpose:clean(a.wlbPurpose),type:clean(a.wlbWellType),status:clean(a.wlbStatus),
    content:clean(a.wlbContent),depth:a.wlbWaterDepth!=null&&a.wlbWaterDepth!==""?+a.wlbWaterDepth:null,area:clean(a.wlbMainArea),url:clean(a.wlbFactPageUrl),
    facility:clean(a.wlbDrillingFacility),facilityId:a.fclNpdidFacilityDrilling!=null&&a.fclNpdidFacilityDrilling!==""?String(a.fclNpdidFacilityDrilling):"name:"+normName(a.wlbDrillingFacility),
    moveable:/MOV/i.test(a.wlbDrillingFacilityFixedOrMove||""),facilityKind:clean(a.wlbFacilityTypeDrilling),
    lat:pos?+pos[0].toFixed(5):null,lon:pos?+pos[1].toFixed(5):null};
}
function rowsToObjects(headers,body){return body.map(r=>{const o={};headers.forEach((h,i)=>{if(h)o[h]=r[i]});return o})}

/* ---------- rig sites & visits ---------- */
function haversineKm(a,b){
  const R=6371,toR=Math.PI/180,dLa=(b[0]-a[0])*toR,dLo=(b[1]-a[1])*toR;
  const h=Math.sin(dLa/2)**2+Math.cos(a[0]*toR)*Math.cos(b[0]*toR)*Math.sin(dLo/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
/* Group a rig's wellbores into sites (≤1.5 km apart) and chronological visits. */
function rigTimeline(facId,wellbores){
  const wbs=wellbores.filter(w=>w.entry&&w.lat!=null).slice().sort((a,b)=>a.entry<b.entry?-1:a.entry>b.entry?1:0);
  const sites=[];
  for(const w of wbs){
    let s=sites.find(s=>haversineKm([s.lat,s.lon],[w.lat,w.lon])<=1.5);
    if(!s){s={id:facId+":"+sites.length,lat:w.lat,lon:w.lon,wells:[],kind:"mobile",facilityId:facId};sites.push(s)}
    s.wells.push(w);w.site=s.id;
  }
  for(const s of sites){
    const by=(k)=>{const m=new Map();for(const w of s.wells)if(w[k])m.set(w[k],(m.get(w[k])||0)+1);return [...m.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||""};
    s.field=by("field");s.discovery=by("discovery");s.well=by("well")||s.wells[0].name;
    s.name=titleCase(s.field||s.discovery||"")||s.well;
    s.sub=s.field||s.discovery?s.well:"";
    s.depth=s.wells.find(w=>w.depth!=null)?.depth??null;
    s.area=by("area");
  }
  const visits=[];
  for(const w of wbs){
    const end=w.comp||w.entry;
    const last=visits[visits.length-1];
    if(last&&last.site===w.site&&diffDays(last.end,w.entry)<=120){last.end=end>last.end?end:last.end;last.wells.push(w)}
    else visits.push({site:w.site,start:w.entry,end,wells:[w]});
  }
  return {sites,visits,siteById:Object.fromEntries(sites.map(s=>[s.id,s]))};
}
function titleCase(s){return String(s||"").toLowerCase().replace(/(^|[\s\-\/(])([a-zæøå])/g,(m,a,b)=>a+b.toUpperCase())}

/* Where was rig X between start and end?  -> segments with confidence. */
function locateOnRig(tl,start,end){
  if(!tl||!tl.visits.length)return [{site:null,start,end,conf:"ukjent",note:"Sodir har ingen brønner registrert på denne riggen."}];
  const segs=[];
  for(const v of tl.visits){
    if(v.start<=end&&v.end>=start){
      const s=v.start>start?v.start:start,e=v.end<end?v.end:end;
      segs.push({site:tl.siteById[v.site],start:s,end:e,conf:"sikker",visit:v,note:"Riggen boret her i perioden."});
    }
  }
  if(segs.length){
    // Merge same-site neighbours, then stretch to cover the stay.
    const m=[];for(const g of segs){const l=m[m.length-1];if(l&&l.site===g.site){l.end=g.end>l.end?g.end:l.end}else m.push(g)}
    m[0].start=start;m[m.length-1].end=end;
    for(let i=1;i<m.length;i++)m[i].start=m[i].start<m[i-1].end?m[i-1].end:m[i].start;
    return m;
  }
  let prev=null,next=null;
  for(const v of tl.visits){if(v.end<start)prev=v;else if(v.start>end&&!next)next=v}
  const gp=prev?diffDays(prev.end,start):Infinity,gn=next?diffDays(end,next.start):Infinity;
  if(prev&&next&&prev.site===next.site&&gp<=120&&gn<=120)
    return [{site:tl.siteById[prev.site],start,end,conf:"trolig",note:`Mellom to brønner på samme lokasjon (${gp} dager etter forrige, ${gn} dager før neste).`}];
  const use=gp<=gn?prev:next,gap=Math.min(gp,gn);
  if(!use||gap>180)return [{site:null,start,end,conf:"ukjent",note:"Ingen brønn innen et halvt år. Riggen kan ha ligget i opplag, på verft eller utenfor norsk sokkel."}];
  const conf=gap<=21?"trolig":"usikker";
  const note=use===prev?`Siste kjente brønn ble avsluttet ${gap} dager før turen.`:`Neste kjente brønn startet ${gap} dager etter turen.`;
  return [{site:tl.siteById[use.site],start,end,conf,note}];
}

/* ---------- export ---------- */
function toCSV(rows,delim=";"){
  return rows.map(r=>r.map(v=>{v=v==null?"":String(v);return /[";\n,\t]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(delim)).join("\r\n");
}

const api={DAY,pad,isoFromDate,toDay,fromDay,addDays,diffDays,todayIso,parseDate,fmtDate,clean,normName,tokens,nameScore,parseCSV,readXlsx,
  FIELDS,findHeaderRow,guessColumns,analyseTables,buildLegs,placeKey,derivePlaces,buildStays,normFacility,normWellbore,rowsToObjects,
  codeScore,fmtTime,haversineKm,rigTimeline,locateOnRig,titleCase,toCSV,isSodirWellbore,isSodirFacility};
if(typeof module!=="undefined"&&module.exports)module.exports=api;else root.OK=api;
})(typeof window!=="undefined"?window:globalThis);
