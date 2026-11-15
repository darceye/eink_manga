// 墨水屏漫画阅读器 - Node.js 版 (零依赖, 需 Node 18+)
// 用法: node app.js [起始端口=8000]  端口被占用自动 +1
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i;

function decodeEnt(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

// ---------- Gatekeeper PoW 门禁 (bzmg 系等站点) ----------
// 首次访问返回 403 {"error":"challenge_required","challenge_url":...}。
// 挑战页给出 challengeId/ticket/difficultyBits: 浏览器端 worker 求
// SHA-256("gatekeeper-pow-v1:{challengeId}:{nonce}") 前导零 >= difficultyBits 的 nonce,
// POST verify 换取放行 Cookie 后重放原请求。这里本地复算等价 PoW (纯哈希, 不执行远端 JS),
// 按 host 维护 Cookie, 同一 host 的挑战串行避免互相踩 Cookie。

const GK_MAX_BITS = 22; // 难度上限 (防异常值卡死; 实测站点为 12, ~4096 次哈希)
const gkJars = new Map();  // host -> Map(cookie 名 -> 值)
const gkLocks = new Map(); // host -> 进行中的挑战 (串行)

function gkJar(host) {
  if (!gkJars.has(host)) gkJars.set(host, new Map());
  return gkJars.get(host);
}

function gkEat(res, host) {
  let raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (!raw.length) {
    const joined = res.headers.get('set-cookie');
    if (joined) raw = joined.split(/,(?=[^ ;]+=[^;]*)/); // 老运行时合并头时按 "x=y," 切
  }
  const jar = gkJar(host);
  for (const c of raw) {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function gkLeadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    let v = b;
    while (!(v & 0x80)) { n++; v <<= 1; }
    break;
  }
  return n;
}

// 从挑战页 HTML 提取配置 (字符串匹配, 不求值页面脚本)
function gkConfig(html) {
  const pick = (re) => (html.match(re) || [])[1];
  const bits = parseInt(pick(/difficultyBits:\s*(\d+)/), 10);
  const cfg = {
    challengeId: pick(/challengeId:\s*"([^"]+)"/),
    ticket: pick(/ticket:\s*"([^"]+)"/),
    verifyUrl: pick(/verifyUrl:\s*"([^"]+)"/),
  };
  return (cfg.challengeId && cfg.ticket && cfg.verifyUrl && bits > 0) ? { ...cfg, bits } : null;
}

async function gkRaw(url, host, headers, opt) {
  const cookie = [...gkJar(host)].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, {
    ...opt,
    headers: { ...(headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  gkEat(res, host);
  return res;
}

async function gkChallenge(startUrl, host, pageUrl) {
  const doSolve = async () => {
    const origin = new URL(pageUrl).origin;
    // 1. 挑战页 (拿 challengeId/ticket/难度; verify 绑定 Referer/Origin)
    const res = await gkRaw(startUrl, host, {
      'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': 'text/html,*/*;q=0.8', 'Referer': pageUrl,
    });
    const cfg = gkConfig(await res.text());
    if (!cfg) throw new Error('gatekeeper: 无法解析挑战配置');
    if (cfg.bits > GK_MAX_BITS) throw new Error(`gatekeeper: 难度 ${cfg.bits} bits 超出上限`);
    // 2. 本地 PoW
    const prefix = 'gatekeeper-pow-v1:' + cfg.challengeId + ':';
    let nonce = 0;
    while (gkLeadingZeroBits(crypto.createHash('sha256').update(prefix + nonce).digest()) < cfg.bits) nonce++;
    // 3. 验证换 Cookie
    const vRes = await gkRaw(new URL(cfg.verifyUrl, pageUrl).href, host, {
      'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept': '*/*', 'Content-Type': 'application/json',
      'Origin': origin, 'Referer': startUrl,
    }, { method: 'POST', body: JSON.stringify({ challenge_id: cfg.challengeId, ticket: cfg.ticket, nonce: String(nonce) }) });
    const txt = await vRes.text();
    if (vRes.status !== 200 || !/"status"\s*:\s*"passed"/.test(txt))
      throw new Error('gatekeeper 验证失败: HTTP ' + vRes.status + ' ' + txt.slice(0, 80));
  };
  const job = (gkLocks.get(host) || Promise.resolve()).then(doSolve, doSolve);
  gkLocks.set(host, job.catch(() => {}));
  return job;
}

// 带 Gatekeeper 重试的请求: 403 且 JSON 要求挑战时, 过关后重放一次
async function gkFetch(url, headers, opt) {
  const host = new URL(url).hostname;
  let res = await gkRaw(url, host, headers, opt);
  if (res.status !== 403) return res;
  if (!(res.headers.get('content-type') || '').includes('json')) return res;
  let j = null;
  try { j = JSON.parse(await res.text()); } catch {}
  if (!j || j.error !== 'challenge_required' || !j.challenge_url) return res;
  await gkChallenge(new URL(j.challenge_url, url).href, host, url);
  return gkRaw(url, host, headers, opt);
}

async function fetchBuf(url, ref) {
  const res = await gkFetch(url, {
    'User-Agent': UA,
    'Referer': ref || url,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return { buf: Buffer.from(await res.arrayBuffer()), ctype: res.headers.get('content-type') || '' };
}

// ---------- 解析漫画图片 ----------
function shapeOf(u) {
  try {
    const p = new URL(u);
    const segs = p.pathname.split('/');
    // 文件名含数字 → 归 N 保留形状 (1.jpg / page2.jpg 各自成同形状, 漫画页聚成一组);
    // 文件名不含数字 → 保留原名, 避免同目录下各异的站点图标 (icon.png / close.png…)
    // 被并成一组, 在短章节里以数量优势反超真正的漫画图
    const last = segs[segs.length - 1];
    segs[segs.length - 1] = /\d/.test(last) ? last.replace(/\d+/g, 'N') : last;
    return p.host + '|' + segs.join('/').replace(/\d+/g, 'N');
  } catch { return null; }
}

function pageNo(u) {
  try {
    const nums = new URL(u).pathname.match(/\d+/g);
    return nums ? parseInt(nums[nums.length - 1], 10) : 0;
  } catch { return 0; }
}

function extractImages(html, baseUrl) {
  const cands = [];
  const push = (raw) => {
    if (!raw) return;
    let u;
    try { u = new URL(decodeEnt(raw.trim()), baseUrl).href; } catch { return; }
    if (u.startsWith('http')) cands.push(u);
  };
  for (const m of html.matchAll(/<img\b[^>]+?src=["']([^"']+)["']/gi)) push(m[1]);
  // 懒加载属性
  for (const m of html.matchAll(/data-(?:src|original|lazy-src|echo)=["']([^"']+)["']/gi)) push(m[1]);
  // 站点常见的 JS 图片数组 (如 var imgs = [...]) 兜底
  for (const m of html.matchAll(/["'](https?:\/\/[^"'\s]+?\.(?:jpe?g|png|webp))["']/gi)) push(m[1]);

  const uniq = [...new Set(cands)];
  const groups = new Map();
  for (const u of uniq) {
    const s = shapeOf(u);
    if (!s) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(u);
  }
  let best = null;
  for (const [shape, us] of groups) {
    if (us.length >= 3 && IMG_EXT.test(shape)) {
      if (!best || us.length > best.length) best = us;
    }
  }
  if (!best) { // 兜底: 任意 >=3 的组
    for (const us of groups.values())
      if (us.length >= 3 && (!best || us.length > best.length)) best = us;
  }
  const list = best || uniq;
  return list.sort((a, b) => pageNo(a) - pageNo(b));
}

// ---------- JS 循环生成的顺序图片 (如 var pasd="https://.../"; for(i=1;i<=num;i++) pasd+i+'.webp') ----------
const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractSeqImages(html) {
  const out = [];
  // 数字变量: var num = eval("186") / var num = 186
  const vars = {};
  for (const m of html.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*(?:eval\(\s*["'](\d+)["']\s*\)|["']?(\d+)["']?)/g))
    vars[m[1]] = parseInt(m[2] || m[3], 10);
  // 基址变量: var pasd = "https://.../"
  const bases = {};
  for (const m of html.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*"(https?:\/\/[^"]*\/)"/g))
    bases[m[1]] = m[2];
  // 循环: for(let i=1; i<=num; i++){ ... base + i + '.webp' ... }
  for (const m of html.matchAll(
      /for\s*\(\s*(?:var|let|const)?\s*(\w+)\s*=\s*(\d+)\s*;\s*\1\s*<=\s*(\w+)\s*;[^)]*\)([\s\S]{0,600}?)(?:<\/script>|$)/gi)) {
    const ivar = m[1], start = parseInt(m[2], 10), count = vars[m[3]];
    if (!count || count > 2000) continue;
    const body = m[4];
    for (const bn of Object.keys(bases)) {
      const use = new RegExp(reEscape(bn) + '\\s*\\+\\s*' + ivar + '\\s*\\+\\s*["\'](\\.[a-z0-9]+)["\']', 'i');
      const um = body.match(use) || html.match(use);
      if (um) for (let i = start; i <= count; i++) out.push(bases[bn] + i + um[1]);
    }
  }
  return out;
}

// ---------- 上一章/下一章 ----------
const PREV_KW = ['上一章', '上一话', '上一页', '前一章', '上一集', 'prev', 'previous', '«', '<<', '‹'];
const NEXT_KW = ['下一章', '下一话', '下一页', '后一章', '下一集', 'next', '»', '>>', '›'];

function extractChapters(html, baseUrl) {
  let prev = null, next = null;
  for (const m of html.matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = (m[1] + ' ' + m[3]).toLowerCase();
    const text = m[4].replace(/<[^>]+>/g, '').trim();
    const low = (text + ' ' + attrs).toLowerCase();
    let u;
    try { u = new URL(decodeEnt(m[2].trim()), baseUrl).href; } catch { continue; }
    if (!u.startsWith('http')) continue;
    const attrPrev = /\bprev(ious)?\b/.test(attrs) || /rel=["']?prev/i.test(attrs);
    const attrNext = /\bnext\b/.test(attrs);
    if ((prev === null) && (PREV_KW.some(k => low.includes(k.toLowerCase())) || attrPrev)) prev = u;
    else if ((next === null) && (NEXT_KW.some(k => low.includes(k.toLowerCase())) || attrNext)) next = u;
  }
  return { prev, next };
}

// ---------- dm5.com (动漫屋) 专用解析 ----------
// 章节页无静态图片: chapterfun.ashx 按签名返回打包 JS, 解包后为
// pix 基址 + 文件名数组 + '?cid=&key=' 后缀; 每个分页返回 [当前图, 下一页首图(预载)]。

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Dean Edwards packer 解包 (纯字符串替换, 不执行远端代码)
function jsUnpack(src) {
  const m = src.match(/\}\('([\s\S]*)',\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'\.split\('\|'\)/);
  if (!m) return src;
  let p = m[1];
  const a = parseInt(m[2], 10), c = parseInt(m[3], 10), k = m[4].split('|');
  p = p.replace(/\\(.)/g, (x, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch));
  const e = (n) => (n < a ? '' : e(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
  const d = {};
  for (let i = c - 1; i >= 0; i--) d[e(i)] = k[i] || e(i);
  return p.replace(/\b\w+\b/g, w => (w in d ? d[w] : w));
}

// 从 chapterfun.ashx 响应 (打包或明文) 提取图片 URL 列表; 有高清组 hd_c 时优先
function dm5ImagesFromCode(code) {
  if (/eval\(function\(p,a,c,k,e,d\)/.test(code)) code = jsUnpack(code);
  const baseM = code.match(/var\s+\w+\s*=\s*"(https?:\/\/[^"]+)"/) || code.match(/var\s+\w+\s*=\s*'(https?:\/\/[^']+)'/);
  const base = baseM ? baseM[1] : '';
  const suffix = (code.match(/\[\s*\w+\s*\]\s*\+\s*["'](\?[^"']*)["']/) || [])[1] || '';
  let best = null, hd = null;
  const arrRe = /(\w+)\s*=\s*\[([^\[\]]*)\]/g;
  let m;
  while ((m = arrRe.exec(code))) {
    const items = [...m[2].matchAll(/["']([^"']+)["']/g)].map(x => x[1]);
    if (!items.length) continue;
    const urls = items.map(s => {
      if (/^https?:\/\//i.test(s)) return s;
      if (s.startsWith('//')) return 'https:' + s;
      return base + s + (s.includes('?') ? '' : suffix);
    });
    if (m[1] === 'hd_c') hd = urls;
    else if (m[1] !== 'd_c' && (!best || urls.length > best.length)) best = urls;
  }
  return hd || best || [];
}

function dm5Vars(html) {
  const vs = {};
  for (const m of html.matchAll(/var\s+(DM5_[A-Z_]+)\s*=\s*("([^"]*)"|([^;\n]+));/g))
    vs[m[1]] = m[3] !== undefined ? m[3] : m[4].trim();
  return vs;
}

function dm5ApiUrl(chUrl, vs, page, key) {
  const api = new URL('/chapterfun.ashx', chUrl);
  api.search = new URLSearchParams({
    cid: vs.DM5_CID, page: String(page), key,
    language: '1', gtk: '6',
    _cid: vs.DM5_CID, _mid: vs.DM5_MID,
    _dt: vs.DM5_VIEWSIGN_DT, _sign: vs.DM5_VIEWSIGN,
  }).toString();
  return api.href;
}

// 上一章/下一章: 只认明确锚文本/按钮类, 排除章内翻页(-pN)与结尾页(-end)
function dm5ChapterLinks(html, baseUrl) {
  let prev = null, next = null;
  for (const m of html.matchAll(/<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1] + ' ' + m[3];
    const text = m[4].replace(/<[^>]+>/g, '').trim();
    let u;
    try { u = new URL(decodeEnt(m[2].trim()), baseUrl).href; } catch { continue; }
    let path = '';
    try { path = new URL(u).pathname; } catch {}
    if (/(?:-end|-p\d+(?:-pl\d+)?)\/?$/.test(path)) continue;
    const isPrev = text === '上一章' || /view-btn-prev/.test(attrs);
    const isNext = text === '下一章' || /view-btn-next/.test(attrs);
    if (isPrev && !prev) prev = u;
    else if (isNext && !next) next = u;
  }
  return { prev, next };
}

async function parseDm5Chapter(url, html) {
  let vs = dm5Vars(html);
  const count = parseInt(vs.DM5_IMAGE_COUNT, 10);
  if (!vs.DM5_CID || !count || !vs.DM5_VIEWSIGN) return null;
  const keyM = html.match(/id="dm5_key"[^>]*value="([^"]*)"/i) || html.match(/value="([^"]*)"[^>]*id="dm5_key"/i);
  const mk = keyM ? keyM[1] : '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEnt(tm[1]).replace(/\s+/g, ' ').replace(/_在线漫画阅读.*$/, '').trim() : url;

  // 地址归一化: 去掉 -pN/-plN/-end 后缀, 阅读/进度/历史都挂在章首地址上
  let canon = url;
  try {
    const c = new URL(url);
    c.search = ''; c.hash = '';
    c.pathname = c.pathname.replace(/(?:-end|-p\d+(?:-pl\d+)?)\/?$/, '/');
    if (!c.pathname.endsWith('/')) c.pathname += '/';
    canon = c.href;
  } catch {}

  // 并发 3 抓取全部分页; 空页/失败页稍后用新签名补抓
  const pages = new Array(count).fill(null);
  const bad = new Set();
  let cursor = 0;
  const worker = async () => {
    while (cursor < count) {
      const pg = ++cursor;
      try {
        const { buf } = await fetchBuf(dm5ApiUrl(canon, vs, pg, mk), canon);
        const list = dm5ImagesFromCode(buf.toString('utf8').trim());
        pages[pg - 1] = list;
        if (!list.length) bad.add(pg);
      } catch { pages[pg - 1] = []; bad.add(pg); }
      await sleep(80);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  if (bad.size) { // 签名有时效: 重新加载章节页换取新签名, 逐页补抓
    try {
      const { buf } = await fetchBuf(canon);
      const vs2 = dm5Vars(buf.toString('utf8'));
      if (vs2.DM5_VIEWSIGN) vs = vs2;
    } catch {}
    for (const pg of [...bad].sort((a, b) => a - b)) {
      try {
        const { buf } = await fetchBuf(dm5ApiUrl(canon, vs, pg, mk), canon);
        const list = dm5ImagesFromCode(buf.toString('utf8').trim());
        if (list.length) pages[pg - 1] = list;
      } catch {}
      await sleep(120);
    }
  }

  // 合并去重: 每页数组末尾是下一页首图 (站方预载), 按首次出现顺序保留
  const seen = new Set();
  const images = [];
  for (const list of pages) for (const u of list || [])
    if (!seen.has(u)) { seen.add(u); images.push(u); }

  return {
    title, images, url: canon,
    ...dm5ChapterLinks(html, canon),
    series: vs.DM5_MID ? 'dm5-' + vs.DM5_MID : undefined,
  };
}

async function parseChapter(url) {
  const { buf } = await fetchBuf(url);
  const html = buf.toString('utf8');
  // dm5.com (动漫屋): 图片由 chapterfun.ashx 动态返回, 走专用解析
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  if (/(^|\.)dm5\.com$/i.test(host) && /var\s+DM5_CID\s*=/.test(html)) {
    const ch = await parseDm5Chapter(url, html);
    if (ch && ch.images.length) return ch;
  }
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = tm ? decodeEnt(tm[1]).replace(/\s+/g, ' ').trim() : url;
  let images = extractImages(html, url);
  // 动态拼接的图片列表 (JS 循环生成) 优先: 通常数量远大于静态 <img>
  const seq = extractSeqImages(html);
  if (seq.length > images.length) images = seq;
  const { prev, next } = extractChapters(html, url);
  // bzmg 系 (包子漫画 cnbzmg/bzmgcn/baozimh): 标题去站名尾缀; 图片为 <img src> 或
  // <amp-img data-src> (通用提取已覆盖), 历史按收藏链接里的 comic_id 聚合
  let series;
  if (/bzmg|baozimh/i.test(host)) {
    title = title.replace(/\s*[-–]\s*[^-]{1,16}漫画\s*$/i, '');
    const idM = html.match(/comic_id=([a-z0-9_-]+)/i);
    if (idM) series = 'bzmg-' + idM[1];
  }
  return { title, images, prev, next, series };
}

// ---------- 页面模板 ----------
const HOME = `<!doctype html><html lang=zh><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>墨水屏漫画阅读器</title><style>
body{font-family:sans-serif;background:#fff;color:#000;margin:0;padding:1em;
display:flex;flex-direction:column;align-items:center;gap:1em;min-height:100vh;box-sizing:border-box}
h1{font-weight:normal;font-size:1.4em;margin:.5em 0 0}
form{display:flex;gap:.5em;width:min(92vw,640px)}
input[type=url]{flex:1;font-size:1em;padding:.6em;border:1px solid #000;border-radius:4px;background:#fff;color:#000;min-width:0}
button{font-size:1em;padding:.6em 1.2em;border:1px solid #000;border-radius:4px;background:#000;color:#fff;cursor:pointer}
#hist{width:min(92vw,640px)}
#hist h2{font-size:1em;border-bottom:2px solid #000;padding-bottom:.3em;display:flex;align-items:center;gap:.5em}
#hist h2 button{font-size:.75em;padding:.2em .7em;background:#fff;color:#000}
#hist ul{list-style:none;margin:0;padding:0}
#hist li{border-bottom:1px solid #ddd;padding:.55em 0;display:flex;align-items:baseline;gap:.6em}
#hist a{color:#000;text-decoration:none;flex:1;min-width:0;font-size:.95em;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hist a:visited{color:#000}
#hist .prog{color:#555;font-size:.8em;white-space:nowrap}
#hist .empty{color:#999;font-size:.9em;padding:.6em 0}
p.tip{color:#555;font-size:.85em;margin:0;text-align:center}
</style></head><body>
<h1>📚 墨水屏漫画阅读器</h1>
<form action="/read" method="get">
<input type="url" name="url" placeholder="粘贴漫画章节网址…" required autofocus>
<button type="submit">阅读</button>
</form>
<div id=hist>
<h2>历史记录 <button id=clear>清空</button></h2>
<ul id=list></ul>
</div>
<p class=tip>粘贴漫画网站的某一话网址，自动提取图片并以适合墨水屏的翻页方式呈现。</p>
<script>
function render(){
  var h = {};
  try { h = JSON.parse(localStorage.getItem('eink_hist') || '{}'); } catch(e) {}
  var arr = Object.keys(h).map(function(k){ return h[k]; })
    .sort(function(a,b){ return b.t - a.t; });
  var ul = document.getElementById('list');
  if (!arr.length) {
    ul.innerHTML = '<li class=empty>暂无阅读记录</li>';
    return;
  }
  var html = '';
  for (var j = 0; j < arr.length; j++) {
    var r = arr[j];
    var title = (r.title || r.url).replace(/\\s+/g, ' ');
    html += '<li><a href="/read?url=' + encodeURIComponent(r.url) + '">' + title +
      '</a><span class=prog>第' + r.page + '/' + r.total + '页</span></li>';
  }
  ul.innerHTML = html;
}
document.getElementById('clear').onclick = function(){
  if (confirm('清空全部历史记录?')) { localStorage.removeItem('eink_hist'); render(); }
};
render();
</script>
</body></html>`;

function errorPage(url) {
  return `<!doctype html><html lang=zh><head><meta charset=utf-8><title>未找到漫画图片</title>
<style>body{font-family:sans-serif;background:#fff;color:#000;padding:2em}a{color:#000}</style></head><body>
<h2>未能从该页面解析出漫画图片</h2><p>${esc(url)}</p>
<p>可能原因: 页面由 JavaScript 动态加载图片、需要登录、或被目标站点拦截。</p>
<p><a href="/">返回首页</a></p></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function readerPage(url, ch) {
  const imgs = JSON.stringify(ch.images.map(u => '/img?u=' + encodeURIComponent(u) + '&ref=' + encodeURIComponent(url)));
  const prev = ch.prev ? '/read?url=' + encodeURIComponent(ch.prev) : '';
  const next = ch.next ? '/read?url=' + encodeURIComponent(ch.next) : '';
  return `<!doctype html>
<html lang="zh"><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(ch.title)}</title>
<style>
:root{--bar:2.6em}
*{box-sizing:border-box}
html,body{height:100%;margin:0;overflow:hidden;background:#fff;color:#000;
  font-family:sans-serif;user-select:none}
#bar{position:fixed;top:0;left:0;right:0;height:var(--bar);
  display:flex;align-items:center;gap:.4em;padding:0 .5em;
  background:#fff;border-bottom:2px solid #000;z-index:9;
  transform:translateY(-100%);transition:transform .12s}
#bar.show{transform:translateY(0)}
#bar a,#bar button{color:#000;background:#fff;border:1px solid #000;border-radius:4px;
  padding:.25em .6em;font-size:.9em;text-decoration:none;cursor:pointer;line-height:1.4}
#title{flex:1;font-size:.85em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#page{position:fixed;top:0;left:0;right:0;bottom:0;
  display:flex;align-items:center;justify-content:center;overflow:hidden}
#img{width:100%;height:100%;flex-shrink:0;object-fit:contain}
#img.rot90{transform:rotate(90deg)}
/* 夜间模式: 页面变黑, 文字/边框变白, 图片不反色 */
body.night{background:#000}
body.night #bar,body.night #nav{background:#000;border-color:#fff}
body.night #bar a,body.night #bar button,
body.night #bar a:visited{color:#fff;background:#000;border-color:#fff}
body.night #title,body.night #counter{color:#fff}
body.night input[type=range]{background:#fff}
body.night input[type=range]::-webkit-slider-thumb{background:#fff;border-color:#000;box-shadow:0 0 0 1px #fff}
body.night #load{color:#aaa}
#zoneL,#zoneR,#zoneM{position:fixed;top:0;bottom:0;width:33.33%;z-index:5}
#zoneL{left:0;cursor:w-resize}#zoneR{right:0;cursor:e-resize}
#zoneM{left:33.33%;cursor:pointer}
#nav{position:fixed;left:0;right:0;bottom:0;height:var(--bar);
  display:flex;align-items:center;gap:.6em;padding:0 .6em;
  background:#fff;border-top:2px solid #000;z-index:9;
  transform:translateY(100%);transition:transform .12s}
#nav.show{transform:translateY(0)}
#counter{font-size:.9em;min-width:5.5em;text-align:center}
input[type=range]{flex:1;appearance:none;-webkit-appearance:none;height:4px;
  background:#000;border-radius:2px;outline:none}
input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;
  width:1.4em;height:1.4em;border-radius:50%;background:#000;border:2px solid #fff;
  box-shadow:0 0 0 1px #000;cursor:pointer}
input[type=range]::-moz-range-thumb{width:1.4em;height:1.4em;border-radius:50%;
  background:#000;border:2px solid #fff;cursor:pointer}
/* 右下角预加载状态图标 */
#preload{display:flex;gap:.25em;font-size:.9em;min-width:2.6em;justify-content:flex-end}
#preload .pi{width:1em;text-align:center}
#preload .pi-ok{color:#000}
#preload .pi-load{color:#999}
#preload .pi-err{color:#000;font-weight:bold}
#preload .pi-off{color:#bbb}
#load{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  font-size:.9em;color:#555;z-index:1}
a.done{visibility:hidden}
</style></head><body>

<div id=bar>
  <a href="/">🏠 首页</a>
  <a class="${prev ? '' : 'done'}" href="${prev}">◀ 上一章</a>
  <a class="${next ? '' : 'done'}" href="${next}">下一章 ▶</a>
  <span id=title>${esc(ch.title)}</span>
  <button id=rotBtn>旋转</button>
  <button id=invBtn>夜间</button>
  <button id=fsBtn>全屏</button>
</div>

<div id=page><img id=img alt=""></div>
<div id=zoneL></div><div id=zoneM></div><div id=zoneR></div>
<div id=load>加载中…</div>

<div id=nav>
  <span id=counter>0 / 0</span>
  <input type=range id=slider min=1 value=1 step=1>
  <span id=preload></span>
</div>

<script>
var IMGS = ${imgs};
var CH_URL = ${JSON.stringify(url)};
var SERIES = ${JSON.stringify(ch.series || '')};
var KEY_CFG = 'eink_cfg', KEY_POS = 'eink_pos';
var cfg = JSON.parse(localStorage.getItem(KEY_CFG) || '{}');
var pos = JSON.parse(localStorage.getItem(KEY_POS) || '{}');
var i = pos[CH_URL] || 0;
if (i >= IMGS.length) i = 0;

var img = document.getElementById('img');
var slider = document.getElementById('slider');
var counter = document.getElementById('counter');
var bar = document.getElementById('bar');
var load = document.getElementById('load');
var rotBtn = document.getElementById('rotBtn');
var invBtn = document.getElementById('invBtn');
slider.max = IMGS.length;

// 预加载接下来 3 张, 并在右下角显示各自的加载状态
var PRE_N = 3;
var prefCache = {};   // url -> {img, state}
var ind = document.getElementById('preload');

function prefetch(n){
  if (n < 0 || n >= IMGS.length) return null;
  var url = IMGS[n];
  if (prefCache[url]) return prefCache[url];
  var st = { img: new Image(), state: 'load' };
  st.img.onload  = function(){ st.state = 'ok';  renderInd(); };
  st.img.onerror = function(){ st.state = 'err'; renderInd(); };
  st.img.src = url;
  prefCache[url] = st;
  // 缓存过多时清掉旧的, 避免内存增长
  if (Object.keys(prefCache).length > 30) prefCache = {};
  return st;
}

function renderInd(){
  var html = '';
  for (var k = 1; k <= PRE_N; k++) {
    var idx = i + k;
    if (idx >= IMGS.length) { html += '<span class="pi pi-off">·</span>'; continue; }
    var st = prefetch(idx);
    var cls = st.state === 'ok' ? 'pi-ok' : (st.state === 'err' ? 'pi-err' : 'pi-load');
    var ch  = st.state === 'ok' ? '●' : (st.state === 'err' ? '✕' : '○');
    html += '<span class="pi ' + cls + '" title="第' + (idx + 1) + '页 ' +
            (st.state === 'ok' ? '已加载' : st.state === 'err' ? '失败' : '加载中') +
            '">' + ch + '</span>';
  }
  ind.innerHTML = html;
}

function saveCfg(){ localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); }
function savePos(){ pos[CH_URL] = i; localStorage.setItem(KEY_POS, JSON.stringify(pos)); }

// 系列键: 章节地址最后一段数字替换为 '#', 同一部漫画各章归为一条
function seriesKey(u){
  var p = new URL(u);
  var segs = p.pathname.split('/').filter(Boolean);
  var seg = segs.pop() || '';
  var nums = seg.match(/\\d+/g);
  if (nums) {
    var last = nums[nums.length - 1];
    var idx = seg.lastIndexOf(last);
    seg = seg.slice(0, idx) + '#' + seg.slice(idx + last.length);
  }
  return p.origin + '/' + segs.join('/') + '/' + seg;
}
function saveHist(){
  var h = {};
  try { h = JSON.parse(localStorage.getItem('eink_hist') || '{}'); } catch(e) {}
  h[SERIES || seriesKey(CH_URL)] = {
    url: CH_URL,
    title: document.title.replace(/\\s+/g, ' ').slice(0, 80),
    page: i + 1, total: IMGS.length, t: Date.now(),
  };
  var ks = Object.keys(h);
  if (ks.length > 50) { // 超出时删最旧的
    ks.sort(function(a, b){ return h[a].t - h[b].t; });
    while (ks.length > 50) delete h[ks.shift()];
  }
  localStorage.setItem('eink_hist', JSON.stringify(h));
}

function applyCfg(){
  img.className = cfg.rot ? 'rot90' : '';
  // 旋转 90 度时交换宽高, 保证旋转后仍撑满整屏
  img.style.width = cfg.rot ? '100vh' : '100%';
  img.style.height = cfg.rot ? '100vw' : '100%';
  document.body.classList.toggle('night', !!cfg.inv);
  invBtn.textContent = cfg.inv ? '白天' : '夜间';
  rotBtn.textContent = cfg.rot ? '竖排' : '旋转';
}
function show(){
  img.src = IMGS[i];
  slider.value = i + 1;
  counter.textContent = (i + 1) + ' / ' + IMGS.length;
  savePos();
  saveHist();
  renderInd();
}
function go(n){
  n = Math.max(0, Math.min(IMGS.length - 1, n));
  if (n === i) return;
  i = n; show();
}
function flip(d){ if (i + d >= 0 && i + d < IMGS.length) go(i + d); }

img.onload = function(){ load.style.display = 'none'; };
img.onerror = function(){ load.style.display = 'block'; load.textContent = '图片加载失败'; };
slider.oninput = function(){ go(parseInt(this.value, 10) - 1); };

document.getElementById('zoneL').onclick = function(){ flip(-1); };
document.getElementById('zoneR').onclick = function(){ flip(1); };

// 顶栏/底栏一起呼出隐藏: 点中间切换, 鼠标离开或 BAR_HIDE_MS 无操作自动收起;
// 按住底栏 (拖动滑动条) 期间挂起不收起, 松手后重新计时
var nav = document.getElementById('nav');
var BAR_HIDE_MS = 3000;
var hideTimer = null, navHold = false;
function armHide(){
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(function(){
    hideTimer = null;
    if (navHold) return armHide();
    bar.classList.remove('show');
    nav.classList.remove('show');
  }, BAR_HIDE_MS);
}
function showBar(on){
  bar.classList.toggle('show', on);
  nav.classList.toggle('show', on);
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (on) armHide();
}
document.getElementById('zoneM').onclick = function(){ showBar(!bar.classList.contains('show')); };
bar.onmouseleave = function(){ showBar(false); };
nav.onmouseleave = function(){ showBar(false); };
nav.onmousedown = nav.ontouchstart = function(){ navHold = true; };
function navRelease(){ if (!navHold) return; navHold = false; if (nav.classList.contains('show')) armHide(); }
document.addEventListener('mouseup', navRelease);
document.addEventListener('touchend', navRelease);

rotBtn.onclick = function(){ cfg.rot = !cfg.rot; saveCfg(); applyCfg(); };
invBtn.onclick = function(){ cfg.inv = !cfg.inv; saveCfg(); applyCfg(); };

// 全屏切换 (兼容老 WebKit 内核的墨水屏浏览器)
var fsBtn = document.getElementById('fsBtn');
var docEl = document.documentElement;
function enterFs(el){
  (el.requestFullscreen || el.webkitRequestFullscreen || function(){ throw 0; }).call(el);
}
function exitFs(){
  (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
}
function isFs(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function syncFsBtn(){
  fsBtn.textContent = isFs() ? '退出全屏' : '全屏';
}
fsBtn.onclick = function(){
  try { isFs() ? exitFs() : enterFs(docEl); } catch(e) {}
};
document.addEventListener('fullscreenchange', syncFsBtn);
document.addEventListener('webkitfullscreenchange', syncFsBtn);
syncFsBtn();

document.onkeydown = function(e){
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') flip(-1);
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') flip(1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(IMGS.length - 1);
  else if (e.key === 'r' || e.key === 'R') rotBtn.click();
  else if (e.key === 'f' || e.key === 'F') fsBtn.click();
};

applyCfg(); show();
</script>
</body></html>`;
}

// ---------- HTTP 服务 ----------
function send(res, code, body, ctype) {
  if (typeof body === 'string') body = Buffer.from(body);
  res.writeHead(code, {
    'Content-Type': ctype || 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(res, 200, HOME);
    }
    if (u.pathname === '/read') {
      const url = u.searchParams.get('url');
      if (!url) return send(res, 400, '缺少 url 参数', 'text/plain; charset=utf-8');
      const ch = await parseChapter(url);
      if (!ch.images.length) return send(res, 200, errorPage(url));
      return send(res, 200, readerPage(ch.url || url, ch));
    }
    if (u.pathname === '/img') {
      const target = u.searchParams.get('u') || '';
      const ref = u.searchParams.get('ref') || target;
      if (!/^https?:/.test(target)) return send(res, 400, 'bad url', 'text/plain');
      const { buf, ctype } = await fetchBuf(target, ref);
      return send(res, 200, buf, (ctype && ctype.startsWith('image')) ? ctype : 'image/jpeg');
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    try { send(res, 502, '错误: ' + e.message, 'text/plain; charset=utf-8'); } catch {}
  }
});

function portFree(port) {
  return new Promise(ok => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); ok(false); });
    s.once('error', () => ok(true));
  });
}

(async () => {
  let port = parseInt(process.argv[2] || '8000', 10);
  for (let i = 0; i < 100; i++) {
    if (await portFree(port)) break;
    console.log(`端口 ${port} 被占用, 尝试 ${port + 1}...`);
    port++;
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`墨水屏漫画阅读器已启动: http://localhost:${port}  (Ctrl+C 退出)`);
  });
})();
