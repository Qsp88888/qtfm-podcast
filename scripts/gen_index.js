<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蜻蜓FM播客订阅</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:800px;margin:auto;padding:2em;line-height:1.6;background:#f5f5f7;color:#1d1d1f}
h1{font-weight:700;font-size:2em;margin-bottom:.5em}
.sub{color:#86868b;margin-bottom:2em}
.card{background:#fff;border-radius:12px;padding:1.5em;margin-bottom:1em;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card h2{margin:0 0 .3em;font-size:1.2em}
.card h2 a{text-decoration:none;color:#007aff}
.card .meta{color:#86868b;font-size:.9em}
.card .links{margin-top:.8em;display:flex;gap:1em;flex-wrap:wrap}
.card .links a{padding:.4em 1em;border-radius:8px;background:#007aff;color:#fff;text-decoration:none;font-size:.85em;display:inline-block}
.card .links a.alt{background:#34c759}
.empty{color:#86868b;text-align:center;padding:3em}
</style>
</head>
<body>
<h1>🎧 蜻蜓FM播客订阅</h1>
<p class="sub">通过GitHub Action全量抓取，CF Worker音频代理</p>
<div id="list"><div class="empty">🔄 加载中...</div></div>
<script>
fetch('index.json').then(r=>r.json()).then(data=>{
  const list=document.getElementById('list');
  if(!data||data.length===0){list.innerHTML='<div class="empty">📭 暂无频道</div>';return}
  data.sort((a,b)=>new Date(b.generatedAt)-new Date(a.generatedAt));
  list.innerHTML=data.map(c=>{
    const rssUrl=\`\${c.channelId}.xml\`;
    const proxyUrl=\`https://qtfm-podcast.general74110.workers.dev/\${c.channelId}\`;
    return \`<div class="card"><h2><a href="\${rssUrl}">\${c.title}</a></h2>
    <div class="meta">\${c.programs||0}集 · \${new Date(c.generatedAt).toLocaleDateString('zh-CN')}</div>
    <div class="links">
      <a href="\${rssUrl}">📖 RSS</a>
      <a class="alt" href="\${proxyUrl}">🎧 Worker</a>
    </div></div>\`;
  }).join('');
}).catch(()=>{
  document.getElementById('list').innerHTML='<div class="empty">❌ 加载失败</div>';
});
</script>
</body>
</html>