// Qtfm Podcast Scraper v4 - 全量抓取（走代理，不抓音频URL）
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

function curl(url) {
  const cmd = 'curl -sL --connect-timeout 15 --max-time 30 -H "User-Agent: ' + UA + '" -H "Accept: text/html,application/xhtml+xml" -H "Referer: https://m.qtfm.cn/" ' + JSON.stringify(url);
  return execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
}
function curlJSON(url) {
  const cmd = 'curl -sL --connect-timeout 15 --max-time 30 -H "User-Agent: ' + UA + '" -H "Accept: application/json" -H "Origin: https://m.qtfm.cn" -H "Referer: https://m.qtfm.cn/" ' + JSON.stringify(url);
  return JSON.parse(execSync(cmd, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }));
}

function httpGet(url, retries) {
  for (let a = 1; a <= (retries||3); a++) {
    try { return curl(url); } catch(e) { if (a < (retries||3)) execSync('sleep ' + (a*2)); else throw e; }
  }
}
function httpGetJSON(url, retries) {
  for (let a = 1; a <= (retries||3); a++) {
    try { return curlJSON(url); } catch(e) { if (a < (retries||3)) execSync('sleep ' + (a*2)); else throw e; }
  }
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

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), s2 = s % 60;
  return h > 0 ? h + ':' + String(m).padStart(2,'0') + ':' + String(s2).padStart(2,'0')
    : m + ':' + String(s2).padStart(2,'0');
}
function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function main() {
  const startTime = Date.now();
  console.log('[' + CHANNEL_ID + '] Starting...');

  // 1. 获取频道元数据 + 前30集
  const html = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/');
  let data = extractInitStores(html);
  
  let ch, ver, title, desc, cover;
  if (data?.VChannelStore?.channel?.id) {
    ch = data.VChannelStore.channel;
    ver = ch.v || '';
    title = ch.title || '';
    desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
    cover = ch.cover ? ch.cover + '!400' : '';
    console.log('Title: ' + title + ', Total: ' + (ch.program_count || 0));
  } else {
    // SSR 为空，从SEO获取
    const seo = data?.VChannelStore?.seo || [];
    const seoTitle = seo.find(s => s.elementType === 'title')?.innerText || '';
    title = seoTitle.replace(/\s*有声小说在线收听.*$/, '') || 'Channel ' + CHANNEL_ID;
    desc = seo.find(s => s.elementType === 'meta' && s.name === 'description')?.content?.slice(0,200) || title;
    console.log('SSR empty, SEO title: ' + title);
    // 搜索替代频道
    const kw = encodeURIComponent(title.replace(/\s*\(.*?\)\s*/, '').trim());
    try {
      const sr = await httpGetJSON('https://webapi.qtfm.cn/api/mobile/search/keyword/' + kw + '?page=1&pageSize=5');
      const channels = sr?.channels?.data || [];
      const best = channels.sort((a,b) => (b.program_count||0)-(a.program_count||0))[0];
      if (best?.id) {
        const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + best.id + '/');
        const d2 = extractInitStores(h2);
        if (d2?.VChannelStore?.channel?.id) {
          ch = d2.VChannelStore.channel;
          ver = ch.v || '';
          title = ch.title || title;
          desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
          cover = ch.cover ? ch.cover + '!400' : '';
          console.log('Using channel ' + best.id + ': ' + title + ', ' + (ch.program_count||0) + ' eps');
        }
      }
    } catch(e) { console.log('Search failed:', e.message); }
    if (!ch) throw new Error('Cannot find channel content');
  }

  // 2. 获取所有节目（API第一页 + nextProgramId链遍历）
  let allProgs = [];
  const seenIds = new Set();

  let batch = [];
  if (ver) {
    try {
      const api = await httpGetJSON('https://webapi.qtfm.cn/api/mobile/channels/' + CHANNEL_ID + '/programs?version=' + ver);
      if (api.programs) batch = api.programs;
    } catch(e) {}
  }
  if (batch.length === 0) batch = data?.VChannelStore?.programs?.items || [];
  console.log('Initial: ' + batch.length + ' eps');

  for (const p of batch) {
    if (!seenIds.has(p.programId)) {
      seenIds.add(p.programId);
      allProgs.push(p);
    }
  }

  // 顺着 nextProgramId 链遍历
  let lastId = allProgs.length > 0 ? allProgs[allProgs.length - 1].programId : null;
  let walked = 0;
  
  while (lastId && walked < 20000) {
    try {
      const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + lastId + '/');
      const pd = extractInitStores(h2);
      if (!pd?.ProgramStore?.programInfo) break;
      
      const pi = pd.ProgramStore.programInfo;
      const nextId = pi.nextProgramId;
      if (!nextId || seenIds.has(nextId)) break;

      // 把新节目加入（从siblingPrograms里批量获取信息）
      const sibs = pd.ProgramStore.siblingPrograms || [];
      let added = 0;
      for (const sp of sibs) {
        if (!seenIds.has(sp.programId)) {
          seenIds.add(sp.programId);
          allProgs.push(sp);
          added++;
          if (sp.programId === nextId) lastId = nextId;
        }
      }
      // 如果sibling里没有nextId，单独抓
      if (!seenIds.has(nextId)) {
        const h3 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + nextId + '/');
        const pd3 = extractInitStores(h3);
        if (pd3?.ProgramStore?.programInfo) {
          const pi3 = pd3.ProgramStore.programInfo;
          seenIds.add(nextId);
          allProgs.push({ programId: nextId, title: pi3.title || '', duration: pi3.duration || 0, updateTime: pi3.updateTime || null });
          lastId = nextId;
          added++;
        }
      }
      walked++;
      if (walked % 50 === 0) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log('  Walk: ' + walked + ', total: ' + allProgs.length + ', next: ' + lastId + ', ' + elapsed + 's');
      }
    } catch(e) {
      console.log('  Walk stop: ' + walked + ' err: ' + e.message);
      break;
    }
    execSync('sleep 0.12');
  }

  console.log('Total: ' + allProgs.length + ' eps (walked ' + walked + ')');
  // Sort by episode number
  allProgs.sort((a,b) => {
    const gn = t => { const m=(t||'').match(/第(\\d+)集/); return m ? parseInt(m[1]) : Infinity; };
    return gn(a.title) - gn(b.title);
  });
  
  // Dedup
  const seenSet = new Set();
  const deduped = allProgs.filter(p => { const k = p.programId; if (seenSet.has(k)) return false; seenSet.add(k); return true; });
  if (deduped.length !== allProgs.length) console.log('  Removed ' + (allProgs.length-deduped.length) + ' duplicates');
  allProgs.length = 0; allProgs.push(...deduped);
  
  // Gap check
  const nums = allProgs.map(p => { const m = (p.title||'').match(/第(\d+)集/); return m ? parseInt(m[1]) : null; }).filter(n => n !== null);
  if (nums.length > 0) {
    let gaps = 0;
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== nums[0] + i) gaps++;
    }
    if (gaps > 0) console.log('  Warning: ' + gaps + ' sequence gaps');
    else console.log('  Sequence OK: ' + nums[0] + ' ~ ' + nums[nums.length-1]);
  }

  if (allProgs.length === 0) throw new Error('No episodes');

  // 3. 生成RSS（音频URL走CF Worker代理）
  const now = new Date().toUTCString();
  let items = '';
  for (const p of allProgs) {
    const pid = p.programId;
    if (!pid) continue;
    const au = WORKER_BASE + '/audio/' + CHANNEL_ID + '/' + pid;
    items += '    <item>\n      <title>' + esc(p.title) + '</title>\n';
    items += '      <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/</link>\n';
    items += '      <guid isPermaLink="false">qtfm-' + CHANNEL_ID + '-' + pid + '</guid>\n';
    items += '      <description>' + esc(p.title) + '</description>\n';
    items += '      <enclosure url="' + esc(au) + '" length="0" type="audio/mpeg"/>\n';
    items += '      <itunes:duration>' + fmtDur(p.duration || 0) + '</itunes:duration>\n';
    items += '      <itunes:author>蜻蜓FM</itunes:author>\n';
    items += '      <pubDate>' + (p.updateTime ? new Date(p.updateTime).toUTCString() : now) + '</pubDate>\n    </item>\n';
  }

  const rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">\n  <channel>\n' +
    '    <title>' + esc(title) + '</title>\n    <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/</link>\n' +
    '    <description>' + esc(desc) + '</description>\n    <language>zh-cn</language>\n    <itunes:author>蜻蜓FM</itunes:author>\n' +
    '    <itunes:summary>' + esc(desc) + '</itunes:summary>\n' +
    (cover ? '    <itunes:image href="' + esc(cover) + '"/>\n' : '') +
    '    <itunes:category text="有声书"/>\n    <lastBuildDate>' + now + '</lastBuildDate>\n    <pubDate>' + now + '</pubDate>\n' +
    items + '  </channel>\n</rss>\n';

  // 4. 写入文件
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.xml'), rss, 'utf8');
  const meta = { channelId: CHANNEL_ID, title, programs: allProgs.length, generatedAt: now,
    duration: Math.round((Date.now() - startTime) / 1000) + 's' };
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.json'), JSON.stringify(meta, null, 2), 'utf8');

  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch(_) {}
  const ex = idx.find(i => i.channelId === CHANNEL_ID);
  if (ex) Object.assign(ex, meta); else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('Done: ' + allProgs.length + ' eps, ' + (rss.length/1024).toFixed(0) + 'KB, ' + elapsed + 's');
}

main().catch(e => { console.error('FAIL:', e && (e.message || String(e)) || 'unknown'); process.exit(1); });