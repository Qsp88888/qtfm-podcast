// Qtfm Podcast Worker - v1.1
// Secrets (TG_TOKEN, GH_TOKEN, GH_REPO) are set via CF Dashboard env vars
const CACHE_TTL = 21600;
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

function tgSend(chatId, text, parseMode, env) {
  const p = new URLSearchParams({ chat_id: chatId, text });
  if (parseMode) p.set('parse_mode', parseMode);
  return fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage?${p}`);
}
function tgSendHTML(chatId, text, env) { return tgSend(chatId, text, 'HTML', env).catch(() => tgSend(chatId, text, null, env)); }

async function fetchPage(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://m.qtfm.cn/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept':'application/json', 'Origin':'https://m.qtfm.cn', 'Referer':'https://m.qtfm.cn/' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
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
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtDur(s) { const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),s2=s%60; return h>0?`${h}:${String(m).padStart(2,'0')}:${String(s2).padStart(2,'0')}`:`${m}:${String(s2).padStart(2,'0')}`; }

async function refreshChannel(env, channelId, baseUrl) {
  const startedAt = Date.now();
  const html = await fetchPage(`https://m.qtfm.cn/vchannels/${channelId}/`);
  const d = extractInitStores(html);
  if (!d?.VChannelStore?.channel) throw new Error('Cannot parse');

  const ch = d.VChannelStore.channel;
  const title = ch.title || '未知';
  const desc = (ch.description||title).replace(/<[^>]+>/g,'').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';

  let programs = [];
  if (ch.v) try { programs = (await fetchJSON(`https://webapi.qtfm.cn/api/mobile/channels/${channelId}/programs?version=${ch.v}`)).programs || []; } catch(_) {}
  if (!programs.length) programs = d.VChannelStore.programs?.items || [];

  const nowUTC = new Date().toUTCString();
  let items = '';
  for (const p of programs) {
    const pid = p.programId;
    if (!pid) continue;
    items += `    <item>
      <title>${esc(p.title)}</title>
      <link>https://m.qtfm.cn/vchannels/${channelId}/programs/${pid}/</link>
      <guid isPermaLink="false">qtfm-${channelId}-${pid}</guid>
      <description>${esc(p.title)}</description>
      <enclosure url="${baseUrl}/audio/${channelId}/${pid}" length="0" type="audio/mpeg"/>
      <itunes:duration>${fmtDur(p.duration||0)}</itunes:duration>
      <itunes:author>蜻蜓FM</itunes:author>
      <pubDate>${p.updateTime ? new Date(p.updateTime).toUTCString() : nowUTC}</pubDate>
    </item>\n`;
  }

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
${items}  </channel>
</rss>`;

  if (env?.QTFM_CACHE) {
    const meta = { channelId, title, programs: programs.length, generatedAt: nowUTC, generatedTime: Date.now(), duration: `${Math.round((Date.now()-startedAt)/1000)}s` };
    await Promise.all([
      env.QTFM_CACHE.put('rss:'+channelId, rss, { expirationTtl: CACHE_TTL }),
      env.QTFM_CACHE.put('meta:'+channelId, JSON.stringify(meta), { expirationTtl: CACHE_TTL }),
      addActiveChannel(env, channelId, title, programs.length),
    ]);
  }
  return rss;
}

async function proxyAudio(channelId, programId) {
  try {
    const html = await fetchPage(`https://m.qtfm.cn/vchannels/${channelId}/programs/${programId}/`);
    const m = html.match(/"audioUrl"\s*:\s*"([^"]+)"/);
    if (!m) return new Response('404', { status: 404 });
    const url = m[1].replace(/\\u0026/g, '&');
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://m.qtfm.cn/' }, redirect: 'manual' });
    const text = await r.text();
    const href = text.match(/href="([^"]+)"/);
    const loc = href ? href[1] : (r.status>=300&&r.status<400 ? r.headers.get('Location') : '');
    if (!loc) return new Response('404', { status: 404 });
    return Response.redirect(loc, 302);
  } catch(e) { return new Response('Proxy error', { status: 500 }); }
}

async function addActiveChannel(env, channelId, title, programs) {
  if (!env?.QTFM_CACHE) return;
  const raw = await env.QTFM_CACHE.get('active_channels', { type:'text' }).catch(()=>null);
  const list = raw ? JSON.parse(raw) : [];
  const ex = list.find(c => c.id === channelId);
  if (ex) { ex.lastAccess=Date.now(); ex.programs=programs; }
  else list.push({ id: channelId, title, programs, addedAt: Date.now() });
  if (list.length > 100) list.splice(0, list.length-100);
  await env.QTFM_CACHE.put('active_channels', JSON.stringify(list), { expirationTtl: 86400*30 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const parts = url.pathname.replace(/^\//,'').split('/').filter(Boolean);
    const base = `${url.protocol}//${url.host}`;

    if (parts[0]==='webhook' && method==='POST') {
      try {
        const body = await request.json();
        const msg = body.message || body.callback_query?.message || {};
        const chatId = msg.chat?.id || body.callback_query?.from?.id;
        const text = (msg.text||'').trim();
        if (!chatId||!text) return new Response('ok');
        if (text==='/start') {
          await tgSendHTML(chatId, '🎧 蜻蜓FM播客机器人\n/novel 小说名 — 搜索抓取\n/list — 已抓取频道', env);
          return new Response('ok');
        }
        if (text.startsWith('/novel')) {
          const kw = text.replace('/novel','').trim();
          if (!kw) { await tgSendHTML(chatId, '请输入小说名', env); return new Response('ok'); }
          await tgSendHTML(chatId, `🔍 搜索「${kw}」...`, env);
          try {
            const sr = await fetchJSON(`https://webapi.qtfm.cn/api/mobile/search/keyword/${encodeURIComponent(kw)}?page=1&pageSize=5`);
            const channels = sr?.channels?.data || [];
            if (!channels.length) { await tgSendHTML(chatId, '❌ 未找到', env); return new Response('ok'); }
            const ch = channels[0];
            await tgSendHTML(chatId, `📚 ${ch.title} (${ch.program_count||'?'}集)\n\n🚀 触发GitHub Action抓取...`, env);
            try {
              const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
                method:'POST',
                headers:{ 'User-Agent':'qtfm-worker','Authorization':`Bearer ${env.GH_TOKEN}`,'Accept':'application/vnd.github.v3+json','Content-Type':'application/json' },
                body: JSON.stringify({ event_type:'scrape', client_payload:{ channel_id:String(ch.id), title:ch.title, worker_base:base } })
              });
              await tgSendHTML(chatId, r.ok||r.status===204
                ? `✅ Action已触发\n频道：${ch.title}\n\n⏳ 约5-30分钟后完成\n\n📖 订阅:\nhttps://general74110.github.io/qtfm-podcast/${ch.id}.xml`
                : `❌ 失败 HTTP ${r.status}`, env);
            } catch(e) { await tgSendHTML(chatId, `❌ ${e.message}`, env); }
          } catch(e) { await tgSendHTML(chatId, `❌ ${e.message}`, env); }
          return new Response('ok');
        }
        if (text==='/list') {
          const raw = await env?.QTFM_CACHE?.get('active_channels', { type:'text' }).catch(()=>null);
          if (!raw) { await tgSendHTML(chatId, '📭 暂无', env); return new Response('ok'); }
          const list = JSON.parse(raw);
          let msg = '📋 已抓取:\n';
          for (const c of list.slice(0,10)) msg += `\n<b>${c.title}</b> — ${c.programs||'?'}集\n${base}/${c.id}\n`;
          if (list.length>10) msg += `\n...还有${list.length-10}个`;
          await tgSendHTML(chatId, msg, env);
          return new Response('ok');
        }
        await tgSendHTML(chatId, '可用: /novel 小说名', env);
        return new Response('ok');
      } catch(e) { return new Response('ok'); }
    }

    if (!parts.length || url.pathname==='/favicon.ico')
      return htmlResp(`<h1>🎧 蜻蜓FM → Apple播客</h1><p>用法: <code>${base}/频道ID</code></p><p>TG: /novel 小说名</p><hr><p><a href="${base}/channels">已缓存频道</a></p>`);

    if (parts[0]==='yhproxy' && method==='POST') {
      try {
        const body = await request.json();
        const r = await fetch(body._url||'https://yhwsapi2.wdyynk.com/api/v1/member/login', { method:body._method||'POST', headers:{...(body._headers||{'content-type':'application/json'}), timestamp:Date.now()+'', token:body._token||''}, body:JSON.stringify(body._body||body) });
        return new Response(await r.text(), { status:r.status, headers:{'Content-Type':r.headers.get('content-type')||'application/json','Access-Control-Allow-Origin':'*'} });
      } catch(e) { return new Response(JSON.stringify({error:e.message}), { status:500 }); }
    }

    if (parts[0]==='audio' && parts[1] && parts[2]) return await proxyAudio(parts[1], parts[2]);
    if (method==='POST' && parts[0]==='refresh' && parts[1]) {
      ctx.waitUntil(refreshChannel(env, parts[1], base));
      return htmlResp(`<p>🔄 Refreshing ${parts[1]}</p>`);
    }
    if (method==='GET' && parts[0]==='status' && parts[1]) {
      const meta = await env?.QTFM_CACHE?.get('meta:'+parts[1], { type:'text' }).catch(()=>null);
      return htmlResp(meta ? `<pre>${JSON.stringify(JSON.parse(meta),null,2)}</pre>` : '<p>Not cached</p>');
    }
    if (method==='GET' && parts[0]==='channels') {
      const raw = await env?.QTFM_CACHE?.get('active_channels', { type:'text' }).catch(()=>null);
      const list = raw ? JSON.parse(raw) : [];
      return htmlResp(`<h1>📋 已缓存频道</h1><ul>${list.map(c=>`<li><a href="${base}/${c.id}">${c.title}</a> (${c.id}) — ${c.programs||0}集</li>`).join('')}</ul>`);
    }

    const channelId = parts[0];
    if (!channelId||!/^\d+$/.test(channelId)) return textResp(`用法: ${base}/频道ID`);
    
    if (env?.QTFM_CACHE) {
      const cached = await env.QTFM_CACHE.get('rss:'+channelId, { type:'text' }).catch(()=>null);
      if (cached) {
        const meta = await env.QTFM_CACHE.get('meta:'+channelId, { type:'text' }).catch(()=>null);
        if (meta) { const m=JSON.parse(meta); if (Date.now()-m.generatedTime > CACHE_TTL*1000*0.5) ctx.waitUntil(refreshChannel(env, channelId, base)); }
        return rssResp(cached);
      }
    }
    try {
      const rss = await refreshChannel(env, channelId, base);
      if (rss) return rssResp(rss);
    } catch(e) {}
    return new Response('Generate failed', { status:503, headers:{'Retry-After':'60'} });
  },

  async scheduled(event, env, ctx) {
    const raw = await env?.QTFM_CACHE?.get('active_channels', { type:'text' }).catch(()=>null);
    if (!raw) return;
    for (const c of JSON.parse(raw)) {
      const meta = await env.QTFM_CACHE.get('meta:'+c.id, { type:'text' }).catch(()=>null);
      if (meta) { const m=JSON.parse(meta); if (Date.now()-m.generatedTime < CACHE_TTL*1000*0.5) continue; }
      await refreshChannel(env, c.id, 'https://qtfm-podcast.general74110.workers.dev');
      await new Promise(r=>setTimeout(r,500));
    }
  }
};

function rssResp(b) { return new Response(b, { headers:{'Content-Type':'application/rss+xml; charset=utf-8','Cache-Control':`public, max-age=${CACHE_TTL}`,'Access-Control-Allow-Origin':'*'} }); }
function textResp(b) { return new Response(b, { headers:{'Content-Type':'text/plain; charset=utf-8'} }); }
function htmlResp(b) { return new Response(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2em;max-width:700px;margin:auto;line-height:1.6">${b}</body></html>`, { headers:{'Content-Type':'text/html; charset=utf-8'} }); }
