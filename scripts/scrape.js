// Qtfm Podcast Scraper v5 - 最终优化版（gzip + keep-alive + 原生https）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';
const MAX_WALK = 50000;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

// Keep-alive agent
const kaAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });
const kaAgentHttp = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });

function httpFetch(url, { json = true, retries = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? kaAgent : kaAgentHttp;

    function tryReq(n) {
      const req = mod.get(u.href, {
        agent, timeout: 30000,
        headers: {
          'User-Agent': UA,
          'Accept': json ? 'application/json, text/html' : 'text/html',
          'Accept-Encoding': 'gzip, deflate',
          ...(json ? { 'Origin': 'https://m.qtfm.cn', 'Referer': 'https://m.qtfm.cn/' } : {}),
        },
      }, (res) => {
        const chunks = [];
        const stream = res.headers['content-encoding'] === 'gzip'
          ? res.pipe(zlib.createGunzip())
          : res.headers['content-encoding'] === 'deflate'
            ? res.pipe(zlib.createInflate())
            : res;

        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            if (n > 1) return setTimeout(() => tryReq(n - 1), 2000);
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try { resolve(json ? JSON.parse(raw) : raw); }
          catch (e) { reject(new Error(`parse: ${e.message.slice(0, 60)}`)); }
        });
      });
      req.on('error', e => { if (n > 1) setTimeout(() => tryReq(n - 1), 2000); else reject(e); });
      req.on('timeout', () => { req.destroy(); if (n > 1) setTimeout(() => tryReq(n - 1), 2000); else reject(new Error('timeout')); });
      req.end();
    }
    tryReq(retries);
  });
}

function extractInitStores(html) {
  const m = html.match(/window\.__initStores\s*=\s*(\{)/);
  if (!m) return null;
  const s = m.index + m[0].length - 1;
  let d = 0, ins = false, esc = false;
  for (let i = 0; i < html.length - s; i++) {
    const c = html[s + i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && ins) { esc = true; continue; }
    if (c === '"') { ins = !ins; continue; }
    if (ins) continue;
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return JSON.parse(html.slice(s, s + i + 1)); }
  }
  return null;
}

function fmtDur(s) {
  s = parseInt(s) || 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), s2 = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s2).padStart(2,'0')}` : `${m}:${String(s2).padStart(2,'0')}`;
}
function esc(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function main() {
  const T0 = Date.now();
  const log = (...a) => console.log(`[${Math.round((Date.now()-T0)/1000)}s]`, ...a);
  log(`${CHANNEL_ID} starting`);

  // ── 1. 频道元数据 ──
  const html = await httpFetch(`https://m.qtfm.cn/vchannels/${CHANNEL_ID}/`, { json: false });
  let data = extractInitStores(html);
  let ch, ver, title = '', desc = '', cover = '';

  if (data?.VChannelStore?.channel?.id) {
    ch = data.VChannelStore.channel;
    ver = ch.v || '';
    title = ch.title || '';
    desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
    cover = ch.cover ? ch.cover + '!400' : '';
    log(`${title} - ${ch.program_count || 0} eps`);
  } else {
    const seo = data?.VChannelStore?.seo || [];
    title = (seo.find(s => s.elementType === 'title')?.innerText || '').replace(/\s*有声小说在线收听.*$/, '') || `Channel ${CHANNEL_ID}`;
    desc = seo.find(s => s.elementType === 'meta' && s.name === 'description')?.content?.slice(0,200) || title;
    log(`SSR empty, trying search: ${title}`);
    for (const c of ((await httpFetch(`https://webapi.qtfm.cn/api/mobile/search/keyword/${encodeURIComponent(title.replace(/\s*\(.*?\)\s*/,'').trim())}?page=1&pageSize=10`))?.channels?.data || [])) {
      if (!c?.id) continue;
      const h2 = await httpFetch(`https://m.qtfm.cn/vchannels/${c.id}/`, { json: false });
      const d2 = extractInitStores(h2);
      if (d2?.VChannelStore?.channel?.id && d2.VChannelStore.programs?.total > 0) {
        ch = d2.VChannelStore.channel; ver = ch.v || '';
        title = ch.title || c.title || title;
        desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
        cover = ch.cover ? ch.cover + '!400' : '';
        log(`Found: ${c.id} (${title}, ${ch.program_count || 0})`);
        break;
      }
    }
    if (!ch) throw new Error('Channel not found');
  }

  // ── 2. 全量链式遍历 ──
  const seen = new Set();
  const all = [];

  let batch = [];
  if (ver) { try { batch = (await httpFetch(`https://webapi.qtfm.cn/api/mobile/channels/${CHANNEL_ID}/programs?version=${ver}`)).programs || []; } catch (_) {} }
  if (!batch.length) batch = data?.VChannelStore?.programs?.items || [];
  for (const p of batch) { if (!seen.has(p.programId)) { seen.add(p.programId); all.push(p); } }

  let cur = all.length ? all[all.length - 1].programId : null;
  let walked = 0, errs = 0;

  const reporter = setInterval(() => log(`walk:${walked} have:${all.length} cur:${cur}`), 10000);

  while (cur && walked < MAX_WALK) {
    try {
      const h = await httpFetch(`https://m.qtfm.cn/vchannels/${CHANNEL_ID}/programs/${cur}/`, { json: false });
      const d = extractInitStores(h);
      if (!d?.ProgramStore?.programInfo) { errs++; if (errs > 3) break; cur = null; break; }
      errs = 0;

      const pi = d.ProgramStore.programInfo;
      const nid = pi.nextProgramId;
      if (!nid || seen.has(nid)) break;

      seen.add(nid);
      all.push({
        programId: nid,
        title: pi.title || '',
        duration: pi.duration || 0,
        updateTime: pi.updateTime || all[0]?.updateTime || '2022-01-01T00:00:00.000Z',
      });
      cur = nid;
      walked++;
    } catch (e) { log(`err @ ${walked}: ${e.message.slice(0,60)}`); errs++; if (errs > 3) break; cur = null; }
  }
  clearInterval(reporter);
  log(`walked ${walked}, total ${all.length}`);

  // ── 排序去重 ──
  const ep = (t) => { const m = (t || '').match(/第(\d+)集/); return m ? parseInt(m[1]) : 999999; };
  all.sort((a, b) => ep(a.title) - ep(b.title));
  const dedup = []; const ds = new Set();
  for (const p of all) { if (!ds.has(p.programId)) { ds.add(p.programId); dedup.push(p); } }
  if (dedup.length !== all.length) log(`-${all.length - dedup.length} dupes`);

  if (!dedup.length) throw new Error('No episodes');

  const nums = dedup.map(p => ep(p.title)).filter(n => n !== 999999);
  if (nums.length) {
    let g = 0, gl = [];
    for (let i = 0; i < nums.length; i++) { if (nums[i] !== nums[0] + i) { g++; if (gl.length < 10) gl.push(nums[i]); } }
    log(g ? `GAPS: ${g} (${gl.join(',')})` : `SEQ OK: ${nums[0]}-${nums[nums.length-1]}`);
  }

  // ── 3. RSS ──
  const now = new Date().toUTCString();
  let items = '';
  for (const p of dedup) {
    if (!p.programId) continue;
    items += `    <item>
      <title>${esc(p.title)}</title>
      <link>https://m.qtfm.cn/vchannels/${CHANNEL_ID}/programs/${p.programId}/</link>
      <guid isPermaLink="false">qtfm-${CHANNEL_ID}-${p.programId}</guid>
      <description>${esc(p.title)}</description>
      <enclosure url="${esc(WORKER_BASE)}/audio/${CHANNEL_ID}/${p.programId}" length="0" type="audio/mpeg"/>
      <itunes:duration>${fmtDur(p.duration)}</itunes:duration>
      <itunes:author>蜻蜓FM</itunes:author>
      <pubDate>${p.updateTime ? new Date(p.updateTime).toUTCString() : now}</pubDate>
    </item>\n`;
  }

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
  <channel>
    <title>${esc(title)}</title>
    <link>https://m.qtfm.cn/vchannels/${CHANNEL_ID}/</link>
    <description>${esc(desc)}</description>
    <language>zh-cn</language>
    <itunes:author>蜻蜓FM</itunes:author>
    <itunes:summary>${esc(desc)}</itunes:summary>
    ${cover ? `<itunes:image href="${esc(cover)}"/>` : ''}
    <itunes:category text="有声书"/>
    <lastBuildDate>${now}</lastBuildDate>
    <pubDate>${now}</pubDate>
${items}  </channel>
</rss>\n`;

  // ── 4. 写文件 ──
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, `${CHANNEL_ID}.xml`), rss, 'utf8');

  const meta = { channelId: CHANNEL_ID, title, programs: dedup.length, generatedAt: now, duration: `${Math.round((Date.now()-T0)/1000)}s` };
  fs.writeFileSync(path.join(OUT_DIR, `${CHANNEL_ID}.json`), JSON.stringify(meta, null, 2), 'utf8');

  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch (_) {}
  const ex = idx.find(i => i.channelId === CHANNEL_ID);
  if (ex) Object.assign(ex, meta); else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  log(`DONE: ${dedup.length} eps, ${Math.round(rss.length/1024)}KB`);
}

main().catch(e => { console.error('FAIL:', e.message || String(e)); process.exit(1); });
