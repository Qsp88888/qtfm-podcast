// Qtfm Podcast Scraper v6 - 并行优化版（v5的https模块+ v6的分页逻辑）
// 核心优化: 用API分页并行抓取代替链式顺序遍历，速度从O(n)降到O(1)
// 请求用原生https（v5已验证GA可跑），不用Node 20 fetch（GA环境网络层不稳定）

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CID = process.env.CHANNEL_ID;
if (!CID) { console.error('CHANNEL_ID required'); process.exit(1); }

const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.7452323.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

// Keep-alive agent (复用v5已验证的配置)
const kaAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });
const kaAgentHttp = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 30000 });

// ── 工具 ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 基于https模块的请求函数，带gzip+gzip+重试（v5已验证GA可跑）
function httpFetch(url, { json = true, retries = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? kaAgent : kaAgentHttp;

    function tryReq(n) {
      try {
        const req = mod.get(u.href, {
          agent, timeout: 30000,
          headers: {
            'User-Agent': UA,
            'Accept': json ? 'application/json' : 'text/html',
            'Accept-Encoding': 'gzip',
            ...(json ? { 'Origin': 'https://m.qtfm.cn', 'Referer': 'https://m.qtfm.cn/' } : { 'Referer': 'https://m.qtfm.cn/' }),
          },
        }, (res) => {
          const chunks = [];
          const stream = res.headers['content-encoding'] === 'gzip'
            ? res.pipe(zlib.createGunzip())
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
          stream.on('error', e => { if (n > 1) setTimeout(() => tryReq(n - 1), 2000); else reject(e); });
        });
        req.on('error', e => { if (n > 1) setTimeout(() => tryReq(n - 1), 2000); else reject(e); });
        req.on('timeout', () => { req.destroy(); if (n > 1) setTimeout(() => tryReq(n - 1), 2000); else reject(new Error('timeout')); });
        req.end();
      } catch (e) {
        // https.get()可能同步抛异常（如DNS AggregateError），走重试
        if (n > 1) return setTimeout(() => tryReq(n - 1), 2000);
        reject(new Error(`request: ${e.message?.slice(0, 60) || e}`));
      }
    }
    tryReq(retries);
  });
}

async function fetchJSON(url) {
  return httpFetch(url, { json: true });
}

async function fetchHTML(url) {
  return httpFetch(url, { json: false });
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
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`;
}
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── 1. 取频道元数据 ──
async function fetchChannelMeta() {
  const html = await fetchHTML(`https://m.qtfm.cn/vchannels/${CID}/`);
  let data = extractInitStores(html);
  if (data?.VChannelStore?.channel?.id) return data;

  // SSR空，尝试搜索
  const seo = data?.VChannelStore?.seo || [];
  const fallbackTitle = (seo.find(s => s.elementType === 'title')?.innerText || '').replace(/\s*有声小说在线收听.*$/, '') || CID;
  for (const c of ((await fetchJSON(`https://webapi.qtfm.cn/api/mobile/search/keyword/${encodeURIComponent(fallbackTitle.replace(/\s*\(.*?\)\s*/, '').trim())}?page=1&pageSize=10`))?.channels?.data || [])) {
    if (!c?.id) continue;
    const h2 = await fetchHTML(`https://m.qtfm.cn/vchannels/${c.id}/`);
    const d2 = extractInitStores(h2);
    if (d2?.VChannelStore?.channel?.id && d2.VChannelStore.programs?.total > 0) {
      console.log(`[meta] Redirected to channel ${c.id}: ${d2.VChannelStore.channel.title}`);
      return d2;
    }
  }
  throw new Error('Channel not found via SSR or search');
}

// ── 2a. API分页并行抓取（优先） ──
async function fetchProgramsByAPI(ver) {
  const CHUNK = 200;
  const first = await fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${CID}/programs?version=${ver}&page=1&pageSize=${CHUNK}`);
  const firstBatch = first?.programs || [];
  const total = first?.total || firstBatch.length;

  // 检测API是否支持分页
  // 如果没total字段，或者一页拿全了，直接返回
  if (!first?.total || firstBatch.length >= total) {
    console.log(`[api] Single batch: ${firstBatch.length} programs`);
    return firstBatch;
  }

  // 检查分页是否生效：取第2页，如果programId和第1页一样，说明分页无效
  const page2 = await fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${CID}/programs?version=${ver}&page=2&pageSize=${CHUNK}`);
  const p2Programs = page2?.programs || [];
  if (p2Programs.length && p2Programs[0]?.programId === firstBatch[0]?.programId) {
    console.log(`[api] Pagination NOT supported (same data), using single batch: ${firstBatch.length}`);
    return firstBatch;
  }
  if (!p2Programs.length) {
    console.log(`[api] Page 2 empty, no pagination. Batch: ${firstBatch.length}`);
    return firstBatch;
  }

  // 分页生效，并行抓取剩余页面
  const totalPages = Math.ceil(total / CHUNK);
  console.log(`[api] Paginated: total=${total}, pages=${totalPages}, chunk=${CHUNK}`);

  const remaining = totalPages - 2; // already have p1 and p2
  if (remaining <= 0) return [...firstBatch, ...p2Programs];

  const pages = await Promise.allSettled(
    Array.from({ length: remaining }, (_, i) =>
      fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${CID}/programs?version=${ver}&page=${i + 3}&pageSize=${CHUNK}`)
        .then(r => r?.programs || [])
        .catch(e => { console.error(`[api] Page ${i + 3} failed: ${e.message}`); return []; })
    )
  );

  const all = [firstBatch, p2Programs, ...pages.map(p => p.status === 'fulfilled' ? p.value : [])].flat();
  console.log(`[api] Total via pagination: ${all.length}`);
  return all;
}

// ── 2b. 链式遍历（回退方案） ──
async function fetchProgramsChain(seedBatch) {
  const seen = new Set();
  const all = [];
  for (const p of seedBatch) {
    if (!seen.has(p.programId)) { seen.add(p.programId); all.push(p); }
  }

  let cur = all.length ? all[all.length - 1].programId : null;
  let walked = 0, errs = 0;
  const MAX_WALK = 50000;

  while (cur && walked < MAX_WALK) {
    try {
      // 🌟 用JSON API代替HTML页面，快3-5倍
      const pi = (await fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${CID}/programs/${cur}`)).programInfo;
      if (!pi?.nextProgramId) { break; }
      errs = 0;

      const nid = pi.nextProgramId;
      if (!nid || seen.has(nid)) break;

      seen.add(nid);
      all.push({
        programId: nid,
        title: pi.title || '',
        duration: pi.duration || 0,
        // updateTime不在JSON里时用seedBatch的时间
        updateTime: pi.updateTime || pi.createdAt || all[0]?.updateTime || new Date().toISOString(),
      });
      cur = nid;
      walked++;
      if (walked % 100 === 0) console.log(`[chain] ${walked}/${MAX_WALK} items, ${Math.round(Date.now()/1000)}s`);
    } catch (e) {
      console.error(`[chain] err @ ${walked}: ${(e.message||e).slice(0, 60)}`);
      errs++;
      if (errs > 3) break;
      cur = null;
    }
  }
  console.log(`[chain] done: walked ${walked}, total ${all.length}`);
  return all;
}

// ── 3. 排序去重 ──
function sortDedup(programs) {
  // 匹配 第X集、第X级、第X章、第X话，或者直接提取数字
  const ep = (t) => {
    if (!t) return 999999;
    const m = t.match(/第(\d+)([集级章话期])/);
    if (m) return parseInt(m[1]);
    // 无编号的（片花/预告等）放最后
    if (/片花|预告|花絮|彩蛋/i.test(t)) return 999999;
    return 999999;
  };
  programs.sort((a, b) => ep(b.title) - ep(a.title));

  const dedup = [];
  const seen = new Set();
  for (const p of programs) {
    if (!seen.has(p.programId)) { seen.add(p.programId); dedup.push(p); }
  }
  if (dedup.length !== programs.length) console.log(`[sort] -${programs.length - dedup.length} dupes`);

  // 统计已排序的集数范围
  const nums = dedup.map(p => ep(p.title)).filter(n => n !== 999999);
  if (nums.length) {
    const sorted = [...nums].sort((a,b) => a-b);
    console.log(`[sort] RANGE: ${sorted[0]}-${sorted[sorted.length-1]} (${nums.length} eps)`);
  }
  return dedup;
}

// ── 4. 检测完本/连载 ──
function detectCompletion(programs, channel) {
  const total = channel?.program_count || programs.length;
  const last = programs[0]; // reverse order, index 0 = newest
  const hasNext = last && last.programId && true; // 如果是通过链式获取的最后一条，肯定有next
  // 完本判定：爬到的数量 >= 频道声明的总数
  const isComplete = programs.length >= total;
  return {
    isComplete,
    totalPrograms: programs.length,
    channelTotal: total,
    lastEpisodeId: last?.programId || '',
    lastEpisodeTitle: last?.title || '',
    lastUpdateTime: last?.updateTime || new Date().toISOString(),
  };
}

// ── 5. 生成RSS ──
function generateRSS(title, desc, cover, programs) {
  const now = new Date().toUTCString();
  // 按节目编号排序后，用位置生成顺序日期（第1集最新，最后集最旧）
  // 这样苹果播客按pubDate降序排列时，节目从第1集到最后一集正序播放
  const startDate = new Date(); // 今天（第1集）
  const items = programs
    .filter(p => p.programId)
    .map((p, i) => {
      // 从今天开始每天倒退一天
      const d = new Date(startDate);
      d.setDate(d.getDate() - i);
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>https://m.qtfm.cn/vchannels/${CID}/programs/${p.programId}/</link>
      <guid isPermaLink="false">qtfm-${CID}-${p.programId}</guid>
      <description>${esc(p.title)}</description>
      <enclosure url="${esc(WORKER_BASE)}/audio/${CID}/${p.programId}" length="0" type="audio/mpeg"/>
      <itunes:duration>${fmtDur(p.duration)}</itunes:duration>
      <itunes:author>蜻蜓FM</itunes:author>
      <pubDate>${d.toUTCString()}</pubDate>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
  <channel>
    <title>${esc(title)}</title>
    <link>https://m.qtfm.cn/vchannels/${CID}/</link>
    <description>${esc(desc)}</description>
    <language>zh-cn</language>
    <itunes:author>蜻蜓FM</itunes:author>
    <itunes:summary>${esc(desc)}</itunes:summary>
    ${cover ? `<itunes:image href="${esc(cover)}"/>` : ''}
    <itunes:category text="有声书"/>
    <lastBuildDate>${now}</lastBuildDate>
    <pubDate>${now}</pubDate>
${items}
  </channel>
</rss>`;
}

// ── 6. 从gh-pages读取旧状态 ──
async function fetchExistingState() {
  try {
    const r = await fetch(`https://7452323.github.io/qtfm-podcast/state.json`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const state = await r.json();
      return state[CID] || null;
    }
  } catch (_) {}
  return null;
}

// ── 7. 增量更新：仅爬取新集数 ──
async function incrementalUpdate(existingState, programs) {
  const lastId = existingState.lastEpisodeId;
  if (!lastId) return programs; // 没有旧状态，全量

  // 已有节目中去重
  const existingIds = new Set();
  // 从已有RSS中恢复已爬的programId
  try {
    const r = await fetch(`https://7452323.github.io/qtfm-podcast/${CID}.json`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      // 直接从state里拿
    }
  } catch (_) {}

  // 找新节目：在programs里找比lastEpisodeId新的
  const idx = programs.findIndex(p => p.programId === lastId);
  if (idx === -1) {
    console.log(`[update] lastId ${lastId} not found in batch, doing full crawl`);
    return programs;
  }

  const newPrograms = programs.slice(idx + 1);
  if (newPrograms.length === 0) {
    console.log(`[update] No new programs found`);
    return null; // 无更新
  }

  console.log(`[update] ${newPrograms.length} new programs found`);
  return newPrograms;
}

// ── Main ──
async function main() {
  const T0 = Date.now();
  const log = (...a) => console.log(`[${Math.round((Date.now() - T0) / 1000)}s]`, ...a);
  log(`Scraping channel ${CID}`);

  // Step 1: 频道元数据
  const data = await fetchChannelMeta();
  const ch = data.VChannelStore.channel;
  const ver = ch.v || '';
  const title = ch.title || `Channel ${CID}`;
  const desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';
  const totalExpected = ch.program_count || 0;
  log(`${title} — ${totalExpected} eps expected`);

  // Step 2: 获取所有节目
  let programs = [];

  // 优先：API分页并行抓取
  if (ver) {
    try {
      programs = await fetchProgramsByAPI(ver);
      log(`API batch: ${programs.length} programs`);
    } catch (e) {
      console.error(`[api] API failed: ${e.message}, falling back`);
    }
  }

  // 回退：SSR数据
  if (!programs.length) {
    programs = data?.VChannelStore?.programs?.items || [];
    log(`SSR batch: ${programs.length} programs`);
  }

  // 检查是否拿全了，不全就链式遍历
  if (programs.length < totalExpected - 50) {
    log(`Have ${programs.length}, expected ~${totalExpected}, chaining...`);
    programs = await fetchProgramsChain(programs);
  } else {
    log(`Have ${programs.length}, close to expected ${totalExpected}, skipping chain`);
  }

  if (!programs.length) throw new Error('No programs found');

  // Step 3: 排序去重
  programs = sortDedup(programs);
  log(`After sort/dedup: ${programs.length}`);

  // Step 4: 检测完本
  const completion = detectCompletion(programs, ch);
  const isComplete = completion.isComplete;
  log(`Status: ${isComplete ? '✅ COMPLETE' : '🔄 ONGOING'} (${programs.length}/${totalExpected})`);

  // Step 5: 生成RSS
  const rss = generateRSS(title, desc, cover, programs);
  log(`RSS generated: ${Math.round(rss.length / 1024)}KB`);

  // Step 6: 写文件
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 写RSS
  fs.writeFileSync(path.join(OUT_DIR, `${CID}.xml`), rss, 'utf8');

  // 写元数据
  const now = new Date().toUTCString();
  const meta = {
    channelId: CID,
    title,
    programs: programs.length,
    isComplete,
    totalExpected,
    generatedAt: now,
    duration: `${Math.round((Date.now() - T0) / 1000)}s`,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${CID}.json`), JSON.stringify(meta, null, 2), 'utf8');

  // Step 7: 更新索引
  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch (_) {}
  const ex = idx.find(i => i.channelId === CID);
  if (ex) Object.assign(ex, meta);
  else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  // Step 8: 更新状态文件
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'state.json'), 'utf8')); } catch (_) {}
  state[CID] = {
    channelId: CID,
    title,
    isComplete,
    totalPrograms: programs.length,
    channelTotal: totalExpected,
    lastEpisodeId: completion.lastEpisodeId,
    lastEpisodeTitle: completion.lastEpisodeTitle,
    lastUpdateTime: completion.lastUpdateTime,
    lastCrawledAt: now,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');

  log(`DONE: ${programs.length} eps, ${isComplete ? 'COMPLETE' : 'ONGOING'} (${Math.round((Date.now() - T0) / 1000)}s)`);
}

main().catch(e => {
  const msg = e?.message || String(e || 'unknown');
  const detail = e?.errors ? e.errors.map(x => x?.message || x).join('; ') : '';
  console.error('FAIL:', msg + (detail ? ' | ' + detail : ''));
  process.exit(1);
});
