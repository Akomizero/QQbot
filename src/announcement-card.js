import sharp from "sharp";

const W=1120, MAX_HEIGHT=2600;
const xml=value=>String(value).replace(/[&<>"']/gu,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[char]);
const units=text=>Array.from(text).reduce((n,char)=>n+(/[\u0020-\u007e]/u.test(char)?0.57:1),0);
const plain=text=>String(text).replace(/\*\*([^*]+)\*\*/gu,"$1").replace(/`([^`]+)`/gu,"$1");

function richTokens(text) {
  const result=[];let strong=false,code=false;
  for(const part of String(text).split(/(\*\*|`)/u)) {
    if(part==="**"){strong=!strong;continue;}if(part==="`"){code=!code;continue;}
    for(const token of part.match(/[A-Za-z0-9]+(?:[.,:%+\-–/][A-Za-z0-9]+)*|[ \t]+|[^\x00-\x7f]|./gu)??[])result.push({text:token,strong,code});
  }
  return result;
}

function wrapped(text,width) {
  const lines=[];let line=[],used=0;
  for(const paragraph of String(text).split(/\r?\n/u)) {
    for(const token of richTokens(paragraph)) {
      const parts=units(token.text)>width?Array.from(token.text):[token.text];
      for(const text of parts) {
        const size=units(text)*(token.strong?1.02:1);
        if(line.length&&used+size>width&&!/^[,，。；：!?！？）》」』、%]$/u.test(text)){lines.push(line);line=[];used=0;}
        if(!line.length&&/^\s+$/u.test(text))continue;
        line.push({...token,text});used+=size;
      }
    }
    if(line.length)lines.push(line);line=[];used=0;
  }
  return lines.length?lines:[[]];
}

function textSvg(lines,x,y,{font=28,lineHeight=43,color="#dce1e8",weight=400}={}) {
  return lines.map((line,index)=>`<text x="${x}" y="${y+index*lineHeight}" font-size="${font}" font-weight="${weight}" fill="${color}">${line.map(token=>`<tspan${token.strong?' font-weight="700" fill="#f7f8fb"':token.code?' fill="#d9a5c2"':""}>${xml(token.text)}</tspan>`).join("")}</text>`).join("");
}

function splitReply(reply,metadata) {
  if(typeof metadata?.body==="string")return {body:metadata.body,sources:metadata.sourceText??""};
  let text=String(reply),boundary=-1;
  if(/^(?:来源\d+：|用户提供文字的摘要)/u.test(text)) {
    const checked=text.indexOf("检索时间：");boundary=text.indexOf("\n\n",checked>=0?checked:0);
  }
  return boundary>=0?{body:text.slice(boundary+2),sources:text.slice(0,boundary)}:{body:text,sources:metadata?.sourceText??""};
}

export function parseCardDocument(reply,metadata={}) {
  const {body,sources}=splitReply(reply,metadata);
  const blocks=[];let section=null,pending=null,conclusion="";
  const flush=()=>{if(!pending)return;if(!section&&!conclusion&&pending.kind==="paragraph")conclusion=pending.text.replace(/^(?:\*\*)?(?:一句话结论|核心结论|结论)[：:](?:\*\*)?\s*/u,"");else{section??={title:"内容要点",tone:"purple",items:[]};section.items.push(pending);}pending=null;};
  const flushSection=()=>{flush();if(section){if(!section.items.length)section.items.push({kind:"paragraph",text:""});blocks.push(section);}section=null;};
  for(const raw of body.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu," ").split(/\r?\n/u)) {
    const line=raw.trim();if(!line){flush();continue;}
    if(/^```/u.test(line)||/^[-*_]{3,}$/u.test(line)) {flush();continue;}
    const heading=line.match(/^#{1,6}\s+(.+)$/u)??line.match(/^\*\*([^*\n]{2,60})\*\*[：:]?$/u);
    if(heading){flushSection();section={title:plain(heading[1]).trim(),tone:/(?:怎么做|怎么办|怎样|如何|步骤|操作|建议|下一步|行动|处理|使用方法|把.+关掉)/u.test(heading[1])?"teal":"purple",items:[]};continue;}
    const quote=line.match(/^>\s?(.*)$/u);
    const numbered=line.match(/^(?:(\d{1,2})[.、)]\s*|([①②③④⑤⑥⑦⑧⑨⑩])\s*|[-*•]\s+)(.+)$/u);
    if(quote){if(pending?.kind!=="quote"){flush();pending={kind:"quote",text:quote[1]};}else pending.text+="\n"+quote[1];continue;}
    if(numbered){flush();pending={kind:"item",number:numbered[1]?Number(numbered[1]):numbered[2]?"①②③④⑤⑥⑦⑧⑨⑩".indexOf(numbered[2])+1:null,text:numbered[3]};continue;}
    if(!pending)pending={kind:"paragraph",text:line};else pending.text+="\n"+line;
  }
  flushSection();
  if(sources.trim())blocks.push({title:/日期|时间|发布|更新/u.test(sources)?"来源与日期":"来源说明",tone:"muted",items:[{kind:"source",text:sources.trim()}]});
  if(!conclusion&&!blocks.length)throw new Error("Empty illustrated reply");
  return {conclusion,sections:blocks};
}

function preparedSections(document) {
  const sections=[];
  if(document.conclusion)sections.push({kind:"conclusion",title:"",tone:"muted",items:[{kind:"conclusion",text:"**一句话结论：**"+document.conclusion}]});
  for(const section of document.sections)sections.push({kind:"section",...section});
  return sections.map(section=>{
    let number=0;const rows=[];
    for(const item of section.items) {
      const kind=item.kind==="paragraph"&&section.items.length>1?"item":item.kind;
      if(kind==="item")number++;
      const font=kind==="source"?22:28,lineHeight=kind==="source"?35:43;
      const available=kind==="item"?860:kind==="quote"?900:948;
      const lines=wrapped(item.text,available/font);
      for(let start=0;start<lines.length;start+=28) {
        const part=lines.slice(start,start+28);
        rows.push({kind,lines:part,font,lineHeight,number:item.number??number,continued:start>0,height:part.length*lineHeight+(kind==="item"?32:kind==="quote"?40:kind==="conclusion"?8:20)});
      }
    }
    const titleLines=wrapped(section.title,950/34);
    return {...section,rows,titleLines,header:section.kind==="conclusion"?0:titleLines.length*47+40};
  });
}

function paginate(sections,title) {
  const titleLines=wrapped(title,1020/30),headerHeight=title?titleLines.length*42+65:52;
  const pages=[];let page={groups:[],used:headerHeight};
  const finish=()=>{if(page.groups.length)pages.push(page);page={groups:[],used:headerHeight};};
  for(const section of sections) {
    let group=null;
    for(const row of section.rows) {
      const extra=group?row.height+14:section.header+row.height+60+24;
      if(page.used+extra+70>MAX_HEIGHT&&page.groups.length){finish();group=null;}
      if(!group){group={...section,rows:[],top:page.used+24,height:section.header+60,continued:section.rows.indexOf(row)>0};page.groups.push(group);page.used+=section.header+60+24;}
      if(group.rows.length){group.height+=14;page.used+=14;}
      group.rows.push(row);group.height+=row.height;page.used+=row.height;
    }
  }
  finish();if(pages.length>6)throw new Error("Illustrated reply has too many pages");
  return {pages,titleLines};
}

function renderGroup(group) {
  const y=group.top,h=group.height,teal=group.tone==="teal",muted=group.tone==="muted";
  let out=`<rect x="32" y="${y}" width="1056" height="${h}" rx="24" fill="${group.kind==="conclusion"?"#303238":"#21252d"}"${group.kind==="conclusion"?' stroke="#484b53" stroke-width="2"':""}/>`;
  let rowY=y+30;
  if(group.header) {
    const title=group.continued?wrapped(group.title+"（续）",950/34):group.titleLines;
    out+=textSvg(title.slice(0,group.titleLines.length),76,rowY+32,{font:34,lineHeight:47,color:muted?"#aebac9":"#f0f3f7",weight:700});
    const lineY=y+group.header+6;
    out+=`<rect x="64" y="${lineY}" width="992" height="4" rx="2" fill="${muted?"#44515e":teal?"url(#tealLine)":"url(#purpleLine)"}"/>`;
    rowY=y+group.header+32;
  }
  for(const row of group.rows) {
    if(row.kind==="item") {
      out+=`<rect x="64" y="${rowY}" width="992" height="${row.height}" rx="18" fill="${teal?"#0d302e":"#2a3039"}" filter="url(#shadow)"/>`;
      if(teal)out+=`<rect x="64" y="${rowY}" width="6" height="${row.height}" rx="3" fill="#13c4bc"/>`;
      out+=`<circle cx="103" cy="${rowY+43}" r="23" fill="${teal?"url(#tealBadge)":"url(#purpleBadge)"}"/><text x="103" y="${rowY+52}" font-size="25" font-weight="700" text-anchor="middle" fill="#fff">${xml(row.continued?"·":row.number)}</text>`;
      out+=textSvg(row.lines,146,rowY+43,{font:row.font,lineHeight:row.lineHeight});
    } else if(row.kind==="quote") {
      out+=`<rect x="64" y="${rowY}" width="992" height="${row.height}" rx="18" fill="#162838" stroke="#458bfa" stroke-width="2"/>`;
      out+=textSvg(row.lines,94,rowY+43,{font:row.font,lineHeight:row.lineHeight,color:"#b8d7ff"});
    } else out+=textSvg(row.lines,64,rowY+(row.kind==="source"?28:39),{font:row.font,lineHeight:row.lineHeight,color:row.kind==="source"?"#acbbca":"#e4e7ec",weight:row.kind==="conclusion"?500:400});
    rowY+=row.height+14;
  }
  return out;
}

export async function renderSummaryImages(reply,metadata={}) {
  const document=parseCardDocument(reply,metadata);
  let title=plain(metadata.topic||metadata.articles?.[0]?.game||"").replace(/[\s·|｜—-]+$/gu,"").slice(0,100);
  if(["问题分析","内容总结","文字总结"].includes(title))title="";
  const label=metadata.adapter==="discussion"?"问题分析":metadata.adapter==="steam"?"更新公告摘要":"内容摘要";
  const {pages,titleLines}=paginate(preparedSections(document),title);
  const buffers=[];let total=0;
  for(let index=0;index<pages.length;index++) {
    const page=pages[index],height=Math.ceil(page.used+75);
    const header=`<text x="40" y="32" font-size="18" fill="#8291a3">${label} · 图文整理</text>`+(title?textSvg(titleLines,40,78,{font:30,lineHeight:42,color:"#e5e9f0",weight:700}):"");
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}"><defs><linearGradient id="purpleLine"><stop stop-color="#5268ff"/><stop offset="1" stop-color="#884bff"/></linearGradient><linearGradient id="tealLine"><stop stop-color="#12bda9"/><stop offset="1" stop-color="#16cbe4"/></linearGradient><linearGradient id="purpleBadge" x2="1" y2="1"><stop stop-color="#5267ff"/><stop offset="1" stop-color="#814bff"/></linearGradient><linearGradient id="tealBadge"><stop stop-color="#18b5aa"/><stop offset="1" stop-color="#11c5dc"/></linearGradient><filter id="shadow" x="-10%" y="-15%" width="120%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000" flood-opacity="0.28"/></filter></defs><rect width="${W}" height="${height}" fill="#12161d"/><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">${header}${page.groups.map(renderGroup).join("")}<line x1="40" x2="1080" y1="${height-44}" y2="${height-44}" stroke="#3f4651"/><text x="40" y="${height-16}" font-size="18" fill="#8291a3">${label} · ${index+1} / ${pages.length}</text></g></svg>`;
    const bytes=await sharp(Buffer.from(svg)).png().toBuffer();total+=bytes.length;
    if(bytes.length>4*1024*1024||total>12*1024*1024)throw new Error("Illustrated reply image too large");
    buffers.push(bytes);
  }
  return buffers;
}

export const renderAnnouncementImages=renderSummaryImages;
