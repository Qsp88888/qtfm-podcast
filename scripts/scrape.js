// Qtfm Podcast Scraper for GitHub Actions
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

function httpGet(url, acceptJSON) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = acceptJSON
      ? { 'User-Agent': UA, 'Accept': 'application/json', 'Origin': 'https://m.qtfm.cn', 'Referer': 'https://m.qtfm.cn/' }
      : { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://m.qtfm.cn/' };
    const req = mod.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) fail(new Error('HTTP ' + res.statusCode));
        else ok(acceptJSON ? JSON.parse(d) : d);
      });
    });
    req.on('error', fail);
    req.setTimeout(20000, () => { req.destroy(); fail(new Error('timeout')); });
  });
}

function extractInitStores(html) {
  const m = html.match(/window\.__initStores\s*=\s*(\{)/);
  if (!m) return null;
  const str = html.slice(m.index + m[0].length - 1);
  let d = 0, ins = false, esc = false, end = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && ins) { esc = true; continue; }
    if (c === '"') { ins = !ins; continue; }
    if (ins) continue;
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) { end = i + 1; break; } }
  }
  if (end === 0) return null;
  try { return JSON.parse(str.slice(0, end)); } catch (_) { return null; }
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
    : m + ':' + String(s).padStart(2,'0');
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function main() {
  console.log('[' + CHANNEL_ID + '] Starting...');

  const html = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/');
  const data = extractInitStores(html);
  if (!data?.VChannelStore?.channel) throw new Error('Parse failed');

  const ch = data.VChannelStore.channel;
  const ver = ch.v || '';
  const title = ch.title || 'Unknown';
  const desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';
  console.log('Title: ' + title + ', Total: ' + (ch.program_count || 0));

  let progs = [];
  if (ver) {
    try {
      const api = await httpGet('https://webapi.qtfm.cn/api/mobile/channels/' + CHANNEL_ID + '/programs?version=' + ver, true);
      if (api.programs) { progs = api.programs; console.log('API: ' + progs.length + ' eps'); }
    } catch(e) { console.log('API fail: ' + e.message); }
  }
  if (progs.length === 0) {
    progs = data.VChannelStore.programs?.items || [];
    console.log('SSR: ' + progs.length + ' eps');
  }
  if (progs.length === 0) throw new Error('No episodes');

  console.log('Fetching audio URLs...');
  const audio = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < progs.length; i++) {
    const pid = progs[i].programId;
    if (!pid) { fail++; continue; }
    try {
      const html2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/');
      const am = html2.match(/"audioUrl"\s*:\s*"([^"]+)"/);
      if (am) {
        const ep = am[1].replace(/\\u0026/g, '&');
        try {
          const html3 = await httpGet(ep);
          const hm = html3.match(/href="([^"]+)"/);
          audio[pid] = hm ? hm[1] : ep;
        } catch(_) { audio[pid] = ep; }
        ok++;
      } else { fail++; }
    } catch(_) { fail++; }
    if ((i + 1) % 50 === 0 || i === progs.length - 1)
      console.log('  ' + (i+1) + '/' + progs.length + ' OK=' + ok + ' FAIL=' + fail);
    if (i < progs.length - 1) await new Promise(r => setTimeout(r, 120));
  }
  console.log('Audio done: ' + ok + ' OK, ' + fail + ' FAIL');

  const now = new Date().toUTCString();
  let items = '';
  for (const p of progs) {
    const pid = p.programId;
    if (!pid) continue;
    const au = audio[pid] || WORKER_BASE + '/audio/' + CHANNEL_ID + '/' + pid;
    const du = fmtDur(p.duration || 0);
    const dt = p.updateTime ? new Date(p.updateTime).toUTCString() : now;
    const pt = p.title || '';
    const pu = 'https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/';
    items += '    <item>\n      <title>' + esc(pt) + '</title>\n';
    items += '      <link>' + esc(pu) + '</link>\n';
    items += '      <guid isPermaLink="false">qtfm-' + CHANNEL_ID + '-' + pid + '</guid>\n';
    items += '      <description>' + esc(pt) + '</description>\n';
    items += '      <enclosure url="' + esc(au) + '" length="0" type="audio/mpeg"/>\n';
    items += '      <itunes:duration>' + du + '</itunes:duration>\n';
    items += '      <itunes:author>蜻蜓FM</itunes:author>\n';
    items += '      <pubDate>' + dt + '</pubDate>\n    </item>\n';
  }

  const rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">\n  <channel>\n' +
    '    <title>' + esc(title) + '</title>\n    <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/</link>\n' +
    '    <description>' + esc(desc) + '</description>\n    <language>zh-cn</language>\n' +
    '    <itunes:author>蜻蜓FM</itunes:author>\n    <itunes:summary>' + esc(desc) + '</itunes:summary>\n' +
    (cover ? '    <itunes:image href="' + esc(cover) + '"/>\n' : '') +
    '    <itunes:category text="有声书"/>\n    <lastBuildDate>' + now + '</lastBuildDate>\n' +
    '    <pubDate>' + now + '</pubDate>\n' + items + '  </channel>\n</rss>\n';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.xml'), rss, 'utf8');
  const meta = { channelId: CHANNEL_ID, title, programs: progs.length, audioOk: ok, audioFail: fail, generatedAt: now };
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.json'), JSON.stringify(meta, null, 2), 'utf8');

  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch(_) {}
  const ex = idx.find(i => i.channelId === CHANNEL_ID);
  if (ex) Object.assign(ex, meta); else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  console.log('Done: ' + progs.length + ' eps, ' + (rss.length/1024).toFixed(0) + 'KB');
}

main().catch(e => { console.error('FAIL:', e && (e.message || e.stack || String(e)) || 'unknown'); process.exit(1); });