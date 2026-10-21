import { request } from "node:http";
import { readBilibiliVideo } from "./bilibili-video.js";
import sharp from "sharp";

function browserRequest(method, path, body = "", binary = false) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: 3456, path, method,
      headers: body ? { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) } : {} }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => { chunks.push(chunk); size += chunk.length; if (size > (binary ? 12 : 1) * 1024 * 1024) req.destroy(new Error("BILI_BROWSER_LIMIT")); });
      response.on("end", () => {
        try { if (response.statusCode !== 200) throw new Error("BILI_BROWSER_UNAVAILABLE"); const data = Buffer.concat(chunks); resolve(binary ? data : JSON.parse(data.toString("utf8"))); }
        catch { reject(new Error("BILI_BROWSER_UNAVAILABLE")); }
      });
      response.on("error", () => reject(new Error("BILI_BROWSER_UNAVAILABLE")));
    });
    const timer = setTimeout(() => req.destroy(new Error("BILI_BROWSER_TIMEOUT")), 30000);
    req.once("close", () => clearTimeout(timer));
    req.on("error", () => reject(new Error("BILI_BROWSER_UNAVAILABLE")));
    req.end(body);
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function withTab(url, allowed, work) {
  if (!allowed()) throw new Error("BILI_DISCOVERY_CANCELLED");
  if (!(await browserRequest("GET", "/health")).connected) throw new Error("BILI_BROWSER_DISCONNECTED");
  const created = await browserRequest("POST", "/new", url);
  if (!created.targetId) throw new Error("BILI_BROWSER_UNAVAILABLE");
  const target = encodeURIComponent(created.targetId);
  const evaluate = async expression => {
    if (!allowed()) throw new Error("BILI_DISCOVERY_CANCELLED");
    const result = await browserRequest("POST", `/eval?target=${target}`, expression);
    return result.value;
  };
  try { return await work(evaluate, target); }
  finally { try { await browserRequest("GET", `/close?target=${target}`); } catch {} }
}

export async function browseBilibiliFeed(allowed = () => true) {
  return withTab("https://www.bilibili.com/", allowed, async evaluate => {
    for (let attempt = 0; attempt < 24; attempt++) {
      const value = await evaluate(`(() => ({ origin: location.origin, cards: Array.from(document.querySelectorAll('.bili-video-card__info--tit a[href*="/video/BV"]')).slice(0,20).map(a => ({title:(a.innerText||'').trim().slice(0,180),url:a.href,duration:(a.closest('.bili-video-card')?.querySelector('.bili-video-card__image--link')?.innerText||'').split('\\n').map(x=>x.trim()).find(x=>/^\\d{1,3}:\\d{2}(?::\\d{2})?$/.test(x))||''})) }))()`);
      if (value?.origin !== "https://www.bilibili.com") throw new Error("BILI_BROWSER_SOURCE");
      const found = new Map();
      for (const card of value.cards ?? []) {
        let url; try { url = new URL(card.url); } catch { continue; }
        const bvid = url.hostname === "www.bilibili.com" && url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/u)?.[1];
        if (!bvid || !card.title || found.has(bvid)) continue;
        const parts = String(card.duration).split(":");
        const seconds = parts.length >= 2 && parts.every(x => /^\d+$/u.test(x)) ? parts.reduce((total, part) => total * 60 + Number(part), 0) : null;
        found.set(bvid, { bvid, title: card.title, duration: seconds, url: `https://www.bilibili.com/video/${bvid}/` });
      }
      if (found.size) return [...found.values()].slice(0, 10);
      await delay(500);
    }
    throw new Error("BILI_FEED_EMPTY");
  });
}

async function readVisibleVideoFrames(candidate, settings, evaluate, target) {
  const info = await evaluate(`(() => { const v=document.querySelector('video'); if(!v) return null; v.muted=true; return {duration:v.duration,ready:v.readyState}; })()`);
  const duration = Number(info?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > settings.videoMaxMinutes * 60 || !settings.videoFramesEnabled || !settings.visionEnabled) throw new Error("BILI_NO_EVIDENCE");
  if (candidate.duration && Math.abs(duration - candidate.duration) > Math.max(5, candidate.duration * 0.1)) throw new Error("BILI_PLAYER_NOT_READY");
  const frames = [];
  for (const ratio of [0.05, 0.25, 0.5, 0.7, 0.9]) {
    const at = Math.min(Math.max(0, duration - 0.2), duration * ratio);
    const visible = await evaluate(`(async () => { const v=document.querySelector('video'); if(!v) return null; v.muted=true; v.pause(); v.scrollIntoView({block:'center'}); v.currentTime=${at}; await new Promise(resolve => { const timer=setTimeout(resolve,2500); v.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true}); }); const r=v.getBoundingClientRect(); return {ready:v.readyState,seeking:v.seeking,at:v.currentTime,viewWidth:innerWidth,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}; })()`);
    if (!visible || visible.ready < 2 || visible.seeking || Math.abs(visible.at - at) > 1) continue;
    const screenshot = await browserRequest("GET", `/screenshot?target=${target}&format=jpeg`, "", true);
    const meta = await sharp(screenshot).metadata(), scale = meta.width / visible.viewWidth;
    const left = Math.max(0, Math.round(visible.rect.x * scale)), top = Math.max(0, Math.round(visible.rect.y * scale));
    const width = Math.min(meta.width - left, Math.round(visible.rect.width * scale)), height = Math.min(meta.height - top, Math.round(visible.rect.height * scale));
    if (width < 120 || height < 80) continue;
    const frame = await sharp(screenshot).extract({ left, top, width, height }).resize({ width: 768, withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    frames.push({ at: Math.round(visible.at), dataUrl: `data:image/jpeg;base64,${frame.toString("base64")}` });
  }
  if (!frames.length) throw new Error("BILI_NO_EVIDENCE");
  return { bvid: candidate.bvid, title: candidate.title, duration, url: candidate.url, page: 1,
    source: "浏览器实际画面抽样（未读取语音）", transcript: "", coverage: null, frames,
    notes: ["公开视频读取器未取得字幕/语音，当前只分析实际浏览器画面，不能声称听过语音或完整看完视频。"] };
}

export async function watchBilibiliCandidate(candidate, settings, allowed = () => true) {
  if (!/^BV[a-zA-Z0-9]{10}$/u.test(candidate?.bvid ?? "")) throw new Error("BILI_BROWSER_SOURCE");
  return withTab(`https://www.bilibili.com/video/${candidate.bvid}/`, allowed, async (evaluate, target) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const visible = await evaluate(`(() => { const video=document.querySelector('video'); if(video) video.muted=true; return {origin:location.origin,hasVideo:!!video}; })()`);
      if (visible?.origin !== "https://www.bilibili.com") throw new Error("BILI_BROWSER_SOURCE");
      if (visible.hasVideo) break;
      await delay(500);
    }
    // The browser owns login and recommendation state; the existing reader uses
    // public video/subtitle/audio sources and never exports the browser cookies.
    let material;
    try { material = await readBilibiliVideo(candidate.url, settings); }
    catch { material = await readVisibleVideoFrames(candidate, settings, evaluate, target); }
    if (!allowed()) throw new Error("BILI_DISCOVERY_CANCELLED");
    if (!material.transcript && !material.frames.length) throw new Error("BILI_NO_EVIDENCE");
    return material;
  });
}
