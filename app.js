// 墨水屏漫画阅读器 - Node.js 版 (零依赖, 需 Node 18+)
// 用法: node app.js [起始端口=8000]  端口被占用自动 +1
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i;

function decodeEnt(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

async function fetchBuf(url, ref) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': ref || url,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  return { buf: Buffer.from(await res.arrayBuffer()), ctype: res.headers.get('content-type') || '' };
}

// ---------- 解析漫画图片 ----------
function shapeOf(u) {
  try {
    const p = new URL(u);
    let path = p.pathname.replace(/\d+/g, 'N');
    path = path.replace(/[^/]*\.(jpe?g|png|gif|webp|bmp|avif)$/i, 'F.EXT');
    return p.host + '|' + path;
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

async function parseChapter(url) {
  const { buf } = await fetchBuf(url);
  const html = buf.toString('utf8');
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEnt(tm[1]).replace(/\s+/g, ' ').trim() : url;
  let images = extractImages(html, url);
  // 动态拼接的图片列表 (JS 循环生成) 优先: 通常数量远大于静态 <img>
  const seq = extractSeqImages(html);
  if (seq.length > images.length) images = seq;
  const { prev, next } = extractChapters(html, url);
  return { title, images, prev, next };
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
  background:#fff;border-top:2px solid #000;z-index:9}
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
  h[seriesKey(CH_URL)] = {
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
document.getElementById('zoneM').onclick = function(){ bar.classList.toggle('show'); };
bar.onmouseleave = function(){ bar.classList.remove('show'); };

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
      return send(res, 200, readerPage(url, ch));
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
