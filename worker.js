// Qtfm Podcast Worker v2 — 状态管理 + 完本/连载逻辑
// Secrets: TG_TOKEN, GH_TOKEN, GH_REPO 在CF面板设置
// KV: QTFM_CACHE namespace

const CACHE_TTL = 21600; // 6h
const REFRESH_THRESHOLD = 21600 * 1000; // 6h
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

const PAGE_BASE = 'https://7452323.github.io/qtfm-podcast';

// ── Telegram ──
function tgSend(chatId, text, parseMode, env) {
  const p = new URLSearchParams({ chat_id: chatId, text });
  if (parseMode) p.set('parse_mode', parseMode);
  return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage?${p}`);
}
function tgSendHTML(chatId, text, env) {
  return tgSend(chatId, text, 'HTML', env).catch(() => tgSend(chatId, text, null, env));
}

// ── 触发更新（抽取成公共函数） ──
async function triggerUpdate(env, chatId, cid, base) {
  await tgSendHTML(chatId, `🔄 触发更新频道 ${cid}...`, env);
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        'User-Agent': 'qtfm-worker',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: 'scrape',
        client_payload: {
          channel_id: cid,
          title: '',
          worker_base: base,
          action_type: 'update',
        },
      }),
    });
    await tgSendHTML(chatId, r.ok || r.status === 204
      ? `✅ 更新已触发，约5-15分钟完成\n📖 ${PAGE_BASE}/${cid}.xml`
      : `❌ HTTP ${r.status}`, env);
  } catch (e) {
    await tgSendHTML(chatId, `❌ ${e.message}`, env);
  }
}

// ── HTTP ──
async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://m.qtfm.cn', Referer: 'https://m.qtfm.cn/' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchHTML(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', Referer: 'https://m.qtfm.cn/' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ── 从GH Pages获取全量RSS（优先） ──
async function fetchPagesRSS(env, channelId) {
  try {
    const r = await fetch(`${PAGE_BASE}/${channelId}.xml`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rss = await r.text();
    // 缓存到KV
    if (env?.QTFM_CACHE) {
      await env.QTFM_CACHE.put('rss:' + channelId, rss, { expirationTtl: CACHE_TTL });
    }
    return rss;
  } catch (_) { return null; }
}

// ── RSS生成（轻量版，给Worker用） ──
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
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtDur(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), s2 = s % 60; return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}` : `${m}:${String(s2).padStart(2, '0')}`; }

async function genRSS(env, channelId, baseUrl, forCache = true) {
  const startedAt = Date.now();
  const html = await fetchHTML(`https://m.qtfm.cn/vchannels/${channelId}/`);
  const d = extractInitStores(html);
  if (!d?.VChannelStore?.channel) throw new Error('Cannot parse channel');

  const ch = d.VChannelStore.channel;
  const title = ch.title || '未知';
  const desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';
  const totalExpected = ch.program_count || 0;

  let programs = [];
  if (ch.v) try { programs = (await fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${channelId}/programs?version=${ch.v}`)).programs || []; } catch (_) { }
  if (!programs.length) programs = d.VChannelStore.programs?.items || [];

  const nowUTC = new Date().toUTCString();
  const items = programs
    .filter(p => p.programId)
    .map(p => `    <item>
      <title>${esc(p.title)}</title>
      <link>https://m.qtfm.cn/vchannels/${channelId}/programs/${p.programId}/</link>
      <guid isPermaLink="false">qtfm-${channelId}-${p.programId}</guid>
      <description>${esc(p.title)}</description>
      <enclosure url="${baseUrl}/audio/${channelId}/${p.programId}" length="0" type="audio/mpeg"/>
      <itunes:duration>${fmtDur(p.duration || 0)}</itunes:duration>
      <itunes:author>蜻蜓FM</itunes:author>
      <pubDate>${p.updateTime ? new Date(p.updateTime).toUTCString() : nowUTC}</pubDate>
    </item>`)
    .join('\n');

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">
  <channel>
    <title>${esc(title)}</title>
    <link>https://m.qtfm.cn/vchannels/${channelId}/</link>
    <description>${esc(desc)}</description>
    <language>zh-cn</language>
    <itunes:author>蜻蜓FM</itunes:author>
    <itunes:summary>${esc(desc)}</itunes:summary>
    ${cover ? `<itunes:image href="${esc(cover)}"/>` : ''}
    <itunes:category text="有声书"/>
    <lastBuildDate>${nowUTC}</lastBuildDate>
    <pubDate>${nowUTC}</pubDate>
${items}
  </channel>
</rss>`;

  if (forCache && env?.QTFM_CACHE) {
    const isComplete = programs.length >= totalExpected;
    const last = programs[programs.length - 1];
    const meta = {
      channelId, title, programs: programs.length, totalExpected, isComplete,
      lastEpisodeId: last?.programId || '',
      lastEpisodeTitle: last?.title || '',
      lastUpdateTime: last?.updateTime || nowUTC,
      generatedAt: nowUTC, generatedTime: Date.now(),
      duration: `${Math.round((Date.now() - startedAt) / 1000)}s`,
    };
    await Promise.all([
      env.QTFM_CACHE.put('rss:' + channelId, rss, { expirationTtl: CACHE_TTL }),
      env.QTFM_CACHE.put('meta:' + channelId, JSON.stringify(meta), { expirationTtl: CACHE_TTL }),
      addActiveChannel(env, channelId, title, programs.length),
    ]);
  }
  return rss;
}

async function proxyAudio(channelId, programId) {
  try {
    const html = await fetchHTML(`https://m.qtfm.cn/vchannels/${channelId}/programs/${programId}/`);
    const m = html.match(/"audioUrl"\s*:\s*"([^"]+)"/);
    if (!m) return new Response('404', { status: 404 });
    const url = m[1].replace(/\\u0026/g, '&');
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://m.qtfm.cn/' }, redirect: 'manual' });
    const text = await r.text();
    const href = text.match(/href="([^"]+)"/);
    const loc = href ? href[1] : (r.status >= 300 && r.status < 400 ? r.headers.get('Location') : '');
    if (!loc) return new Response('404', { status: 404 });
    return Response.redirect(loc, 302);
  } catch (e) {
    return new Response('Proxy error', { status: 500 });
  }
}

async function addActiveChannel(env, channelId, title, programs) {
  if (!env?.QTFM_CACHE) return;
  const raw = await env.QTFM_CACHE.get('active_channels', { type: 'text' }).catch(() => null);
  const list = raw ? JSON.parse(raw) : [];
  const ex = list.find(c => c.id === channelId);
  if (ex) { ex.lastAccess = Date.now(); ex.programs = programs; }
  else list.push({ id: channelId, title, programs, addedAt: Date.now() });
  if (list.length > 100) list.splice(0, list.length - 100);
  await env.QTFM_CACHE.put('active_channels', JSON.stringify(list), { expirationTtl: 86400 * 30 });
}

// ── TG Bot Handler ──
async function handleTG(env, body, base) {
  const msg = body.message || body.callback_query?.message || {};
  const chatId = msg.chat?.id || body.callback_query?.from?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;

  // /start
  if (text === '/start') {
    await tgSendHTML(chatId,
      '🎧 蜻蜓FM播客机器人 v2\n\n' +
      '/novel 小说名 — 搜索并抓取\n' +
      '/status <频道ID> — 查看频道状态\n' +
      '/update <频道ID> — 更新指定频道\n' +
      '/updateall — 一键更新所有连载频道\n' +
      '/clear [频道ID] — 清除全部/指定频道缓存\n' +
      '/list — 已抓取频道列表', env);
    return;
  }

  // /status <channelId>
  if (text.startsWith('/status') || text.startsWith('/check')) {
    const cid = text.replace(/^\/(status|check)/, '').trim();
    if (!cid) { await tgSendHTML(chatId, '用法: /status 频道ID', env); return; }

    // 查KV
    const rawMeta = await env?.QTFM_CACHE?.get('meta:' + cid, { type: 'text' }).catch(() => null);
    if (rawMeta) {
      const m = JSON.parse(rawMeta);
      const ago = Math.round((Date.now() - (m.generatedTime || 0)) / 60000);
      await tgSendHTML(chatId,
        `📊 <b>${m.title}</b>\n` +
        `ID: ${cid}\n` +
        `集数: ${m.programs}/${m.totalExpected || '?'}\n` +
        `状态: ${m.isComplete ? '✅ 完本' : '🔄 连载中'}\n` +
        `缓存: ${ago}分钟前\n` +
        `📖 ${PAGE_BASE}/${cid}.xml`, env);
    } else {
      // 查GH Pages
      try {
        const r = await fetch(`${PAGE_BASE}/${cid}.json`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const m = await r.json();
          await tgSendHTML(chatId,
            `📊 <b>${m.title}</b>\n` +
            `ID: ${cid}\n` +
            `集数: ${m.programs}\n` +
            `状态: ${m.isComplete ? '✅ 完本' : '🔄 连载中'}\n` +
            `生成: ${m.generatedAt}\n` +
            `📖 ${PAGE_BASE}/${cid}.xml`, env);
        } else {
          await tgSendHTML(chatId, `❌ 频道 ${cid} 未找到`, env);
        }
      } catch (e) {
        await tgSendHTML(chatId, `❌ ${e.message}`, env);
      }
    }
    return;
  }

  // /update <channelId> — 更新指定频道
  if (text.startsWith('/update ')) {
    const cid = text.replace('/update ', '').trim();
    if (!cid) { await tgSendHTML(chatId, '用法: /update 频道ID', env); return; }
    await triggerUpdate(env, chatId, cid, base);
    return;
  }

  // /updateall 或 /refresh — 一键更新所有连载频道
  if (text === '/updateall' || text === '/refresh' || text === '/update all') {
    await tgSendHTML(chatId, '🔍 查找连载频道...', env);
    
    let ongoingChannels = [];
    
    // 从KV获取
    const raw = await env?.QTFM_CACHE?.get('active_channels', { type: 'text' }).catch(() => null);
    if (raw) {
      const list = JSON.parse(raw);
      for (const c of list) {
        const meta = await env?.QTFM_CACHE?.get('meta:' + c.id, { type: 'text' }).catch(() => null);
        if (meta) {
          const m = JSON.parse(meta);
          if (!m.isComplete) ongoingChannels.push(m);
        }
      }
    }
    
    // KV不够就从GH Pages拉
    if (!ongoingChannels.length) {
      try {
        const r = await fetch(`${PAGE_BASE}/state.json`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const state = await r.json();
          for (const [cid, s] of Object.entries(state)) {
            if (!s.isComplete) {
              ongoingChannels.push({ channelId: cid, title: s.title || cid, programs: s.totalPrograms || 0 });
            }
          }
        } else {
          // 回退到index.json
          const r2 = await fetch(`${PAGE_BASE}/index.json`, { signal: AbortSignal.timeout(5000) });
          if (r2.ok) {
            const list = await r2.json();
            for (const c of list) {
              if (!c.isComplete) {
                ongoingChannels.push({ channelId: c.channelId, title: c.title || c.channelId, programs: c.programs || 0 });
              }
            }
          }
        }
      } catch (_) {}
    }
    
    if (!ongoingChannels.length) {
      await tgSendHTML(chatId, '✅ 没有连载中的频道需要更新', env);
      return;
    }
    
    const total = ongoingChannels.length;
    await tgSendHTML(chatId, `🔄 找到 ${total} 个连载频道，开始触发更新...`, env);
    
    let success = 0, failed = 0;
    const limit = Math.min(total, 10); // 一次最多10个
    const channels = ongoingChannels.slice(0, limit);
    
    for (let i = 0; i < channels.length; i++) {
      const c = channels[i];
      try {
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'User-Agent': 'qtfm-worker',
            Authorization: `Bearer ${env.GH_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'scrape',
            client_payload: {
              channel_id: c.channelId,
              title: c.title,
              worker_base: base,
              action_type: 'update',
            },
          }),
        });
        if (r.ok || r.status === 204) {
          success++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
      // 每触发一个等500ms，避免限频
      await new Promise(r => setTimeout(r, 500));
    }
    
    let msg = `✅ 触发完成: ${success} 成功`;
    if (failed) msg += `, ${failed} 失败`;
    if (total > limit) msg += `\n💡 还有 ${total - limit} 个没触发（单次上限10个）`;
    msg += `\n\n⏳ 每个约5-30分钟完成，完成后会通知你`;
    await tgSendHTML(chatId, msg, env);
    return;
  }

  // /list
  if (text === '/list') {
    const raw = await env?.QTFM_CACHE?.get('active_channels', { type: 'text' }).catch(() => null);
    if (!raw) {
      // 从GH Pages拉
      try {
        const r = await fetch(`${PAGE_BASE}/index.json`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const list = await r.json();
          let msg = '📋 已抓取:\n';
          for (const c of list.slice(0, 15))
            msg += `\n<b>${c.title}</b> — ${c.programs}集 ${c.isComplete ? '✅' : '🔄'}\n${PAGE_BASE}/${c.channelId}.xml\n`;
          if (list.length > 15) msg += `\n...还有${list.length - 15}个`;
          await tgSendHTML(chatId, msg, env);
        } else {
          await tgSendHTML(chatId, '📭 暂无频道', env);
        }
      } catch (_) {
        await tgSendHTML(chatId, '📭 暂无频道', env);
      }
      return;
    }
    const list = JSON.parse(raw);
    let msg = '📋 已抓取:\n';
    for (const c of list.slice(0, 15))
      msg += `\n<b>${c.title}</b> — ${c.programs || '?'}集\n${base}/${c.id}\n`;
    if (list.length > 15) msg += `\n...还有${list.length - 15}个`;
    await tgSendHTML(chatId, msg, env);
    return;
  }

  // /clear [channelId] — 清除缓存
  if (text.startsWith('/clear ') || text === '/clear') {
    const target = text.replace('/clear', '').trim();
    
    if (!env?.QTFM_CACHE) {
      await tgSendHTML(chatId, '❌ KV不可用', env);
      return;
    }

    if (target) {
      // 清除指定频道
      await Promise.all([
        env.QTFM_CACHE.delete('rss:' + target).catch(() => {}),
        env.QTFM_CACHE.delete('meta:' + target).catch(() => {}),
      ]);
      // 从 active_channels 中移除
      const raw = await env.QTFM_CACHE.get('active_channels', { type: 'text' }).catch(() => null);
      if (raw) {
        let list = JSON.parse(raw);
        list = list.filter(c => c.id !== target);
        await env.QTFM_CACHE.put('active_channels', JSON.stringify(list), { expirationTtl: 86400 * 30 });
      }
      await tgSendHTML(chatId, `🗑️ 已清除频道 ${target} 的缓存`, env);
    } else {
      // 清除所有缓存
      const list = await env.QTFM_CACHE.list().catch(() => ({ keys: [] }));
      const keys = list.keys || [];
      if (!keys.length) {
        await tgSendHTML(chatId, '📭 缓存为空，无需清除', env);
        return;
      }
      // KV list() returns keys with name property
      const deletePromises = keys.map(k => env.QTFM_CACHE.delete(k.name).catch(() => {}));
      await Promise.allSettled(deletePromises);
      await tgSendHTML(chatId, `🗑️ 已清除 ${keys.length} 个缓存项\n\n下次请求会重新拉取最新数据`, env);
    }
    return;
  }

  // /update（无参数时也当updateall）
  if (text === '/update') {
    // 等同于 /updateall
    await tgSendHTML(chatId, '用法: /update 频道ID  或  /updateall 更新所有连载', env);
    return;
  }

  // /novel <小说名>
  if (text.startsWith('/novel')) {
    const kw = text.replace('/novel', '').trim();
    if (!kw) { await tgSendHTML(chatId, '请输入小说名', env); return; }

    await tgSendHTML(chatId, `🔍 搜索「${kw}」...`, env);
    try {
      const sr = await fetchJSON(`https://webapi.qtfm.cn/api/mobile/search/keyword/${encodeURIComponent(kw)}?page=1&pageSize=5`);
      const channels = sr?.channels?.data || [];
      if (!channels.length) { await tgSendHTML(chatId, '❌ 未找到', env); return; }

      const ch = channels[0];
      const cid = String(ch.id);

      // 🌟 看缓存：是否已爬取
      const rawMeta = await env?.QTFM_CACHE?.get('meta:' + cid, { type: 'text' }).catch(() => null);
      if (rawMeta) {
        const m = JSON.parse(rawMeta);
        if (m.isComplete) {
          // 完本：直接发链接
          await tgSendHTML(chatId,
            `✅ <b>${m.title}</b> (${m.programs}集) 已完本\n\n` +
            `📖 ${PAGE_BASE}/${cid}.xml\n` +
            `⏱ ${m.generatedAt}`, env);
          return;
        }
        // 连载：看是否要更新
        const age = Date.now() - (m.generatedTime || 0);
        if (age < REFRESH_THRESHOLD) {
          // 6小时内刚查过
          await tgSendHTML(chatId,
            `🔄 <b>${m.title}</b> 连载中 (${m.programs}集)\n` +
            `⏱ ${Math.round(age / 60000)}分钟前检查过\n` +
            `📖 现有订阅: ${PAGE_BASE}/${cid}.xml\n` +
            `💡 ${age < 3600000 ? '刚查过，暂不重复触发' : '需要更新？/update ' + cid}`, env);
          return;
        }
        // 超过6小时，触发更新
        await tgSendHTML(chatId,
          `🔄 <b>${m.title}</b> 连载中 (${m.programs}集)\n` +
          `⏱ 上次检查: ${Math.round(age / 60000)}分钟前\n` +
          `🚀 触发更新检查...`, env);
      } else {
        // 新频道
        await tgSendHTML(chatId,
          `📚 ${ch.title} (${ch.program_count || '?'}集)\n\n` +
          `🚀 触发抓取...`, env);
      }

      // 触发GitHub Action
      try {
        const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'User-Agent': 'qtfm-worker',
            Authorization: `Bearer ${env.GH_TOKEN}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'scrape',
            client_payload: {
              channel_id: cid,
              title: ch.title,
              worker_base: base,
              action_type: 'initial',
            },
          }),
        });

        if (r.ok || r.status === 204) {
          await tgSendHTML(chatId,
            `✅ Action已触发: ${ch.title}\n\n` +
            `⏳ 约5-30分钟后完成\n\n` +
            `📖 ${PAGE_BASE}/${cid}.xml`, env);
        } else {
          await tgSendHTML(chatId, `❌ 触发失败 HTTP ${r.status}`, env);
        }
      } catch (e) {
        await tgSendHTML(chatId, `❌ ${e.message}`, env);
      }
    } catch (e) {
      await tgSendHTML(chatId, `❌ ${e.message}`, env);
    }
    return;
  }

  // 未知命令
  await tgSendHTML(chatId, '可用: /novel 小说名 | /status 频道ID | /update 频道ID | /list', env);
}

// ── Notification Handler (来自GitHub Action的回调) ──
async function handleNotify(env, body) {
  const { channelId, title, programs, isComplete, lastEpisodeId, worker_base } = body;
  if (!channelId) return new Response('bad', { status: 400 });

  const nowUTC = new Date().toUTCString();
  const meta = {
    channelId,
    title: title || '未知',
    programs: programs || 0,
    totalExpected: body.totalExpected || programs || 0,
    isComplete: !!isComplete,
    lastEpisodeId: lastEpisodeId || '',
    lastEpisodeTitle: body.lastEpisodeTitle || '',
    lastUpdateTime: body.lastUpdateTime || nowUTC,
    generatedAt: nowUTC,
    generatedTime: Date.now(),
    duration: '0s',
  };

  if (env?.QTFM_CACHE) {
    await env.QTFM_CACHE.put('meta:' + channelId, JSON.stringify(meta), { expirationTtl: CACHE_TTL });
    if (title) await addActiveChannel(env, channelId, title, programs);
  }

  return new Response('ok');
}

// ── Update channel list from GH Pages (called on schedule) ──
async function syncFromGHPages(env) {
  if (!env?.QTFM_CACHE) return;

  // 优先state.json（新格式，含状态），回退index.json（旧格式）
  let channels = [];
  try {
    const r = await fetch(`${PAGE_BASE}/state.json`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const state = await r.json();
      channels = Object.entries(state).filter(([cid, s]) => cid && s).map(([cid, s]) => ({
        channelId: cid,
        title: s.title || '',
        programs: s.totalPrograms || 0,
        totalExpected: s.channelTotal || 0,
        isComplete: !!s.isComplete,
        lastEpisodeId: s.lastEpisodeId || '',
        lastEpisodeTitle: s.lastEpisodeTitle || '',
        lastUpdateTime: s.lastUpdateTime || '',
        generatedAt: s.lastCrawledAt || '',
        generatedTime: new Date(s.lastCrawledAt || 0).getTime() || 0,
      }));
    }
  } catch (_) {}

  // 回退index.json
  if (!channels.length) {
    try {
      const r = await fetch(`${PAGE_BASE}/index.json`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const list = await r.json();
        channels = list.filter(c => c.channelId).map(c => ({
          channelId: c.channelId,
          title: c.title || '',
          programs: c.programs || 0,
          totalExpected: c.totalExpected || c.programs || 0,
          isComplete: !!c.isComplete,
          lastEpisodeId: '',
          lastEpisodeTitle: '',
          lastUpdateTime: c.generatedAt || '',
          generatedAt: c.generatedAt || '',
          generatedTime: new Date(c.generatedAt || 0).getTime() || Date.now(),
        }));
      }
    } catch (_) {}
  }

  if (!channels.length) return;

  const promises = [];
  for (const c of channels) {
    // 自动判断完本：爬到的 >= 总数
    const autoComplete = c.isComplete || (c.totalExpected > 0 && c.programs >= c.totalExpected);
    const meta = {
      channelId: c.channelId, title: c.title,
      programs: c.programs, totalExpected: c.totalExpected,
      isComplete: autoComplete,
      lastEpisodeId: c.lastEpisodeId,
      lastEpisodeTitle: c.lastEpisodeTitle,
      lastUpdateTime: c.lastUpdateTime,
      generatedAt: c.generatedAt,
      generatedTime: c.generatedTime,
      duration: '0s',
    };
    promises.push(env.QTFM_CACHE.put('meta:' + c.channelId, JSON.stringify(meta), { expirationTtl: CACHE_TTL }));
    promises.push(addActiveChannel(env, c.channelId, c.title, c.programs));
  }
  if (promises.length) await Promise.allSettled(promises);
}

// ── Request Handler ──
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const parts = url.pathname.replace(/^\//, '').split('/').filter(Boolean);
    const base = `${url.protocol}//${url.host}`;

    // TG Webhook
    if (parts[0] === 'webhook' && method === 'POST') {
      try {
        const body = await request.json();
        await handleTG(env, body, base);
      } catch (_) { }
      return new Response('ok');
    }

    // GH Action Notification Callback
    if (parts[0] === 'notify' && method === 'POST') {
      try {
        const body = await request.json();
        return await handleNotify(env, body);
      } catch (e) {
        return new Response(e.message, { status: 500 });
      }
    }

    // Homepage
    if (!parts.length || url.pathname === '/favicon.ico')
      return htmlResp(
        `<h1>🎧 蜻蜓FM → Apple播客</h1>` +
        `<p>用法: <code>${base}/频道ID</code></p>` +
        `<p>TG: /novel 小说名</p>` +
        `<hr>` +
        `<p><a href="${base}/channels">已缓存频道</a></p>` +
        `<p>GH Pages: <a href="${PAGE_BASE}">${PAGE_BASE}</a></p>`
      );

    // Audio proxy
    if (parts[0] === 'audio' && parts[1] && parts[2])
      return await proxyAudio(parts[1], parts[2]);

    // Channels list
    if (method === 'GET' && parts[0] === 'channels') {
      const raw = await env?.QTFM_CACHE?.get('active_channels', { type: 'text' }).catch(() => null);
      const list = raw ? JSON.parse(raw) : [];
      return htmlResp(
        `<h1>📋 已缓存频道</h1><ul>` +
        list.map(c => `<li><a href="${base}/${c.id}">${c.title}</a> (${c.id}) — ${c.programs || 0}集</li>`).join('') +
        `</ul>`
      );
    }

    // Status endpoint (JSON)
    if (method === 'GET' && parts[0] === 'status' && parts[1]) {
      const meta = await env?.QTFM_CACHE?.get('meta:' + parts[1], { type: 'text' }).catch(() => null);
      if (meta) return new Response(meta, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      return new Response('{}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // Refresh endpoint (async, returns immediately)
    if (method === 'POST' && parts[0] === 'refresh' && parts[1]) {
      ctx.waitUntil(genRSS(env, parts[1], base));
      return htmlResp(`<p>🔄 Refreshing ${parts[1]}</p>`);
    }

    // Sync state from GH Pages
    if (method === 'POST' && parts[0] === 'sync') {
      ctx.waitUntil(syncFromGHPages(env));
      return htmlResp(`<p>🔄 Syncing from GH Pages</p>`);
    }

    // Set bot menu commands
    if (method === 'POST' && parts[0] === 'setmenu') {
      ctx.waitUntil((async () => {
        const cmds = [
          { command: 'start', description: '显示帮助信息' },
          { command: 'novel', description: '搜索并抓取小说' },
          { command: 'status', description: '查看频道完本/连载状态' },
          { command: 'update', description: '更新指定频道' },
          { command: 'updateall', description: '一键更新所有连载频道' },
          { command: 'clear', description: '清除全部/指定频道缓存' },
          { command: 'list', description: '已抓取频道列表' },
        ];
        await fetch(`https://api.telegram.org/b${'o'}t${env.TG_TOKEN}/setMyCommands`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands: cmds }),
        });
      })());
      return htmlResp(`<p>✅ Setting bot menu...</p>`);
    }

    // RSS proxy (频道ID)
    const channelId = parts[0];
    if (!channelId || !/^\d+$/.test(channelId))
      return textResp(`用法: ${base}/频道ID`);

    // 🌟 优先：从GH Pages取全量RSS（Action爬的）
    const pagesRSS = await fetchPagesRSS(env, channelId);
    if (pagesRSS) {
      // 后台更新meta
      if (env?.QTFM_CACHE) {
        const rawMeta = await env.QTFM_CACHE.get('meta:' + channelId, { type: 'text' }).catch(() => null);
        if (rawMeta) {
          const m = JSON.parse(rawMeta);
          if (!m.isComplete && Date.now() - (m.generatedTime || 0) > REFRESH_THRESHOLD * 0.5) {
            ctx.waitUntil(genRSS(env, channelId, base));
          }
        }
      }
      return rssResp(pagesRSS);
    }

    // 回退：KV缓存
    if (env?.QTFM_CACHE) {
      const cached = await env.QTFM_CACHE.get('rss:' + channelId, { type: 'text' }).catch(() => null);
      if (cached) {
        return rssResp(cached);
      }
    }

    // 最后回退：自己生成（只有30集，但聊胜于无）
    try {
      const rss = await genRSS(env, channelId, base);
      if (rss) return rssResp(rss);
    } catch (e) { }
    return new Response('Generate failed', { status: 503, headers: { 'Retry-After': '60' } });
  },

  // Scheduled cron: 刷新连载频道 + 同步GH Pages状态
  async scheduled(event, env, ctx) {
    // 先同步GH Pages状态
    await syncFromGHPages(env);

    // 再刷新连载频道
    const raw = await env?.QTFM_CACHE?.get('active_channels', { type: 'text' }).catch(() => null);
    if (!raw) return;
    for (const c of JSON.parse(raw)) {
      const meta = await env.QTFM_CACHE.get('meta:' + c.id, { type: 'text' }).catch(() => null);
      if (meta) {
        const m = JSON.parse(meta);
        if (m.isComplete) continue; // 完本跳过
        if (Date.now() - (m.generatedTime || 0) < REFRESH_THRESHOLD * 0.5) continue; // 最近查过跳过
      }
      await genRSS(env, c.id, 'https://qtfm-podcast.general74110.workers.dev');
      await new Promise(r => setTimeout(r, 500)); // 限速
    }
  },
};

// ── Response Helpers ──
function rssResp(b) {
  return new Response(b, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}
function textResp(b) {
  return new Response(b, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
function htmlResp(b) {
  return new Response(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2em;max-width:700px;margin:auto;line-height:1.6">${b}</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
