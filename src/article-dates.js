// Dates are publisher declarations from the actual page, never inferred from a URL,
// search rank, copyright year, retrieval time, or the HTTP Last-Modified header.
const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const dayMs = 86400000;
const chinaOffset = 8 * 3600000;
const datePattern = String.raw`(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT|北京时间))?)?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+\d{4})`;
const ymd = (year,month,day) => `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
export const chinaDay = (time=Date.now()) => new Date(time+chinaOffset).toISOString().slice(0,10);

function decode(value) {
  return String(value??"").replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gu, entity => ({"&amp;":"&","&lt;":"<","&gt;":">","&quot;":'"',"&apos;":"'","&nbsp;":" "})[entity])
    .replace(/&#(x[0-9a-f]+|\d+);/giu,(_match,code)=>{const n=/^x/iu.test(code)?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):" ";});
}

function attribute(tag,name) {
  const match=tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,"iu"));
  return decode(match?.[1]??match?.[2]??match?.[3]??"");
}

export function parseArticleDate(raw,{source="原网页",now=Date.now()}={}) {
  const text=decode(raw).trim().replace(/\s+/gu," ").slice(0,100);
  let parts=text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:(?:T|\s)+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT|北京时间)?)?$/iu);
  let year,month,day,hour,minute,second,zone;
  if(parts) [,year,month,day,hour,minute,second,,zone]=parts;
  else {
    const english=text.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/iu)
      ?? text.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/iu);
    if(!english)return null;
    const monthName=/^\d/u.test(english[1])?english[2]:english[1];
    day=/^\d/u.test(english[1])?english[1]:english[2];year=english[3];
    month=months.findIndex(name=>name===monthName.toLowerCase()||name.slice(0,3)===monthName.toLowerCase())+1;
  }
  year=Number(year);month=Number(month);day=Number(day);
  const calendar=new Date(Date.UTC(year,month-1,day));
  if(year<1970||year>2100||calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day
    ||(hour!==undefined&&(Number(hour)>23||Number(minute)>59||Number(second??0)>59)))return null;
  const calendarDay=ymd(year,month,day),precision=hour===undefined?"day":second===undefined?"minute":"second";
  let value=calendarDay,epoch=null;
  if(hour!==undefined) {
    const local=`${calendarDay}T${String(hour).padStart(2,"0")}:${minute}:${second??"00"}`;
    if(zone) {
      const offset=/^(?:z|utc|gmt)$/iu.test(zone)?"Z":zone==="北京时间"?"+08:00":zone.replace(/^([+-]\d{2})(\d{2})$/u,"$1:$2");
      if(offset!=="Z"&&(Number(offset.slice(1,3))>14||Number(offset.slice(4,6))>59||(Number(offset.slice(1,3))===14&&Number(offset.slice(4,6))!==0)))return null;
      epoch=Date.parse(local+offset);if(!Number.isFinite(epoch))return null;value=new Date(epoch).toISOString();
    } else value=local;
  }
  const future=epoch!==null?epoch>now+300000:calendarDay>chinaDay(now);
  return {value,calendarDay,precision,timezoneKnown:hour!==undefined&&Boolean(zone),source,evidence:text,future};
}

function selectDate(candidates) {
  const valid=candidates.filter(Boolean);
  if(!valid.length)return {status:"missing",date:null,candidates:[]};
  const nonFuture=valid.filter(item=>!item.future);
  if(!nonFuture.length)return {status:"future",date:null,candidates:valid.slice(0,4)};
  const compatible=(a,b)=>{
    if(a.timezoneKnown&&b.timezoneKnown)return Math.abs(Date.parse(a.value)-Date.parse(b.value))<=300000;
    const days=item=>[item.calendarDay,...(item.timezoneKnown?[chinaDay(Date.parse(item.value))]:[])];
    return days(a).some(day=>days(b).includes(day));
  };
  if(valid.some(item=>item.future)||nonFuture.some((item,index)=>nonFuture.slice(index+1).some(other=>!compatible(item,other))))
    return {status:"conflict",date:null,candidates:valid.slice(0,4)};
  // Source order is deliberate: explicit metadata and Article structured data,
  // followed by labelled visible text. Prefer precise time only when it agrees.
  const selected=nonFuture.find(item=>item.timezoneKnown)??nonFuture[0];
  return {status:"verified",date:selected,candidates:valid.slice(0,4)};
}

function samePage(a,b) {
  try {
    const normalize=value=>{
      const url=new URL(value,b);url.hash="";
      for(const key of [...url.searchParams.keys()])if(/^(?:utm_.+|fbclid|gclid|spm)$/iu.test(key))url.searchParams.delete(key);
      url.searchParams.sort();return url.href.replace(/\/$/u,"");
    };
    return normalize(a)===normalize(b);
  } catch{return false;}
}

function structuredArticles(html,url) {
  const nodes=[];
  const visit=(value,depth=0)=>{
    if(!value||typeof value!=="object"||depth>8||nodes.length>400)return;
    if(Array.isArray(value)){for(const item of value)visit(item,depth+1);return;}
    const types=Array.isArray(value["@type"])?value["@type"]:[value["@type"]];
    if(types.some(type=>typeof type==="string"&&/(?:^|\/)(?:Article|NewsArticle|BlogPosting|TechArticle|ScholarlyArticle|Report)$/u.test(type)))nodes.push(value);
    for(const [key,item] of Object.entries(value))if(key!=="@context")visit(item,depth+1);
  };
  for(const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    if(match[1].length>256000)continue;
    try {visit(JSON.parse(match[1].trim().replace(/^<!--|-->$/gu,"")));} catch{}
  }
  const exact=url?nodes.filter(node=>[node.url,node["@id"],typeof node.mainEntityOfPage==="string"?node.mainEntityOfPage:node.mainEntityOfPage?.["@id"]].some(value=>typeof value==="string"&&samePage(value,url))):[];
  // A sole foreign Article can be a recommendation rather than this document.
  const identities=node=>[node.url,node["@id"],typeof node.mainEntityOfPage==="string"?node.mainEntityOfPage:node.mainEntityOfPage?.["@id"]].filter(value=>typeof value==="string"&&value&&!value.startsWith("#"));
  return exact.length?exact:nodes.length===1&&(!url||!identities(nodes[0]).length)?nodes:[];
}

// These are quoted declarations in the body, not certified event dates. A future
// effective date is valid evidence and must not be mistaken for future publication.
export function eventDateEvidence(value,{now=Date.now()}={}) {
  const text=String(value??"").slice(0,32000),items=[],seen=new Set();
  const labels=/(?:生效|施行|实施|上线|开放|维护|发生|举办|举行|effective|takes? effect|comes? into force|launch|release|maintenance)/iu;
  for(const match of text.matchAll(new RegExp(datePattern,"giu"))) {
    const start=Math.max(0,match.index-42),end=Math.min(text.length,match.index+match[0].length+48);
    const quote=text.slice(start,end).replace(/\s+/gu," ").trim();
    if(!labels.test(quote))continue;
    const date=parseArticleDate(match[0],{now,source:"实际取得的正文日期片段"});if(!date)continue;
    const kind=/生效|施行|实施|effective|takes? effect|comes? into force/iu.test(quote)?"生效/实施时间线索":"事件/上线时间线索";
    const key=kind+date.value;if(seen.has(key))continue;seen.add(key);items.push({kind,date,quote});if(items.length>=5)break;
  }
  return items;
}

export function labelledDateCandidates(value,{now=Date.now(),source="原文显示"}={}) {
  const text=decode(value).replace(/\u00a0/gu," ").slice(0,6000);
  const collect=(labels)=>[...text.matchAll(new RegExp(`(?:${labels})[\\s:：*|\\-]{0,18}(${datePattern})`,"giu"))].slice(0,5)
    .map(match=>parseArticleDate(match[1],{now,source:`${source}：${match[0].slice(0,32)}`})).filter(Boolean);
  return {
    published:collect("发布时间|发布日期|发表时间|刊登日期|发布于|发表于|Published(?:\\s+on|\\s+at)?|Posted(?:\\s+on)?"),
    updated:collect("更新时间|更新日期|最后更新|最后修改|Last\\s+updated|Updated(?:\\s+on|\\s+at)?|Modified"),
  };
}

export function articleDateMetadata(html,{url,now=Date.now()}={}) {
  const published=[],updated=[];
  const add=(list,value,source)=>{const date=parseArticleDate(value,{source,now});if(date)list.push(date);};
  const publishedKeys=["article:published_time","og:published_time","datepublished","pubdate","publishdate","publish_date","dc.date.issued","dcterms.issued","citation_publication_date","citation_date"];
  const updatedKeys=["article:modified_time","og:updated_time","datemodified","lastmod","last-modified","modified_time"];
  for(const tag of html.match(/<meta\b[^>]*>/giu)??[]) {
    const key=(attribute(tag,"property")||attribute(tag,"name")||attribute(tag,"itemprop")).toLowerCase();
    if(publishedKeys.includes(key))add(published,attribute(tag,"content"),`原网页 meta ${key}`);
    if(updatedKeys.includes(key))add(updated,attribute(tag,"content"),`原网页 meta ${key}`);
  }
  for(const node of structuredArticles(html,url)) {
    add(published,node.datePublished,"原网页 Article.datePublished");add(updated,node.dateModified,"原网页 Article.dateModified");
  }
  for(const match of html.matchAll(/<aside\b([^>]*)>([\s\S]*?)<\/aside>/giu)) {
    if(!/^(?:article metadata|article information|文章信息|文章元数据)$/iu.test(attribute(" "+match[1],"aria-label")))continue;
    const labels=labelledDateCandidates(decode(match[2].replace(/<[^>]*>/gu," ")).replace(/\s+/gu," "),{now,source:"原网页文章信息"});
    published.push(...labels.published);updated.push(...labels.updated);
  }
  // Exclude navigation, scripts, recommendations outside the main article, and footer dates.
  let scope=html.replace(/<(script|style|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/giu,"");
  scope=scope.match(/<article\b[^>]*>([\s\S]*?)<\/article>/iu)?.[1]??scope.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1]??scope;
  scope=scope.slice(0,100000);
  for(const match of scope.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/giu)) {
    const tag=" "+match[1],prop=attribute(tag,"itemprop").toLowerCase(),classes=attribute(tag,"class");
    const value=attribute(tag,"datetime")||decode(match[2].replace(/<[^>]*>/gu," ")).trim();
    if(prop==="datepublished"||/\bpubdate(?:\s|=|$)/iu.test(tag)||/\b(?:published|publish-date)\b/iu.test(classes))add(published,value,"原网页 time 发布时间");
    else if(prop==="datemodified"||/\b(?:updated|modified)\b/iu.test(classes))add(updated,value,"原网页 time 更新时间");
    else if(/\bentry-date\b/iu.test(classes))add(published,value,"原网页 time 文章日期");
    // An unlabelled <time> may describe an event, so it is intentionally ignored.
  }
  const visible=decode(scope.replace(/<[^>]*>/gu," ")).replace(/\s+/gu," ");
  const labelled=labelledDateCandidates(visible,{now});published.push(...labelled.published);updated.push(...labelled.updated);
  const publication=selectDate(published),modification=selectDate(updated);
  return {publication,modification,publishedAt:publication.date?.value??null,updatedAt:modification.date?.value??null,dateVerification:"original-page"};
}

export function extractedDateMetadata(text,{now=Date.now()}={}) {
  const candidates=labelledDateCandidates(text,{now,source:"原文提取文本"});
  const publication=selectDate(candidates.published),modification=selectDate(candidates.updated);
  return {publication,modification,publishedAt:publication.date?.value??null,updatedAt:modification.date?.value??null,dateVerification:"extracted-text"};
}

export function mergeArticleDates(original,extracted) {
  const combine=(kind)=>selectDate([...(original[kind]?.candidates??[]),...(extracted[kind]?.candidates??[])]);
  const publication=combine("publication"),modification=combine("modification");
  const dateVerification=original.publication?.status==="missing"&&publication.status==="verified"?"extracted-text-only":original.dateVerification;
  return {...original,publication,modification,publishedAt:publication.date?.value??null,updatedAt:modification.date?.value??null,dateVerification};
}

export function displayArticleDate(date) {
  if(!date)return null;
  if(date.precision==="day")return date.value;
  if(!date.timezoneKnown)return `${date.value.replace("T"," ").slice(0,date.precision==="second"?19:16)}（原文未标时区）`;
  return new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(date.value))+"（北京时间）";
}

export function summaryDateWindow(intent,{now=Date.now()}={}) {
  const subject=intent.subject??"",today=chinaDay(now),todayStart=Date.parse(today+"T00:00:00+08:00");
  // Only an explicitly requested publication date defines this filter. A date
  // in an event title (e.g. a future effective date) is not a publication window.
  const dateScope=subject.match(/(?:发布日期|发布时间|发表于|发布于|发表日期)[\s:：为在]*(.{0,80})/u)?.[1]??"";
  const declared=dateScope.match(/^(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)(?:\s*(?:至|到|~|～)\s*(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?))?/u);
  const explicit=declared?[declared[1],declared[2]].filter(Boolean).map(value=>parseArticleDate(value,{now})).filter(Boolean):[];
  if(explicit.length&&(!declared[2]||explicit.length===2)) {
    const start=explicit[0].calendarDay,end=explicit[1]?.calendarDay??start;
    if(start<=end)return {start,end,label:explicit.length===1?start:`${start}至${end}`,timezone:"Asia/Shanghai"};
  }
  if(!intent.latest)return null;
  let start=todayStart-29*dayMs,end=todayStart+dayMs-1,label="近30天";
  if(/(?:今天|今日)/u.test(subject)){start=todayStart;label="今天";}
  else if(/昨天|昨日/u.test(subject)){start=todayStart-dayMs;end=todayStart-1;label="昨天";}
  else if(/前天/u.test(subject)){start=todayStart-2*dayMs;end=todayStart-dayMs-1;label="前天";}
  else if(/本周|这周/u.test(subject)){start=todayStart-((new Date(today+"T00:00:00Z").getUTCDay()+6)%7)*dayMs;label="本周";}
  else if(/本月/u.test(subject)){start=Date.parse(today.slice(0,8)+"01T00:00:00+08:00");label="本月";}
  else {
    const days=subject.match(/(?:近|过去|最近)\s*(\d{1,3})\s*天/u)?.[1];
    const count=days?Math.max(1,Math.min(365,Number(days))):/近一周|最近一周|近期|最近|新闻|动态|资讯/u.test(subject)?7:30;
    start=todayStart-(count-1)*dayMs;label=`近${count}天`;
  }
  return {start:chinaDay(start),end:chinaDay(end),label,timezone:"Asia/Shanghai"};
}

export function dateWithinWindow(article,window) {
  if(["original-page-unreadable","original-page-body-unreadable","extracted-text-only"].includes(article.dateVerification))return false;
  const date=article.publication?.status==="verified"?article.publication.date:null;
  if(!date)return false;
  const day=date.timezoneKnown?chinaDay(Date.parse(date.value)):date.calendarDay;
  return day>=window.start&&day<=window.end;
}
