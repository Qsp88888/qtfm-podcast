# 🎧 蜻蜓FM → Apple播客 RSS 生成器

通过 Telegram Bot 搜索蜻蜓FM有声小说，自动全量抓取并生成标准 RSS 订阅，支持 Apple Podcasts / 任意播客客户端订阅收听。

**一句话：** Telegram 发个小说名，等几分钟，复制 RSS 链接到播客 App 就能听。

---

## ✨ 功能

- 🌐 **Telegram Bot 交互** — `/novel 小说名` 就能搜索抓取
- 🧠 **完本/连载自动识别** — 完本小说秒回链接，连载定期检查更新
- 📦 **全量抓取** — GitHub Action 无时间限制，几千集照样爬完
- 🎵 **音频在线代理** — Cloudflare Worker 实时签名，无需自己转存
- 📡 **标准 RSS** — 兼容 Apple Podcasts、Google Podcasts、Overcast、Pocket Casts 等
- ⚡ **一键更新** — `/updateall` 更新所有连载频道
- 🗑️ **缓存管理** — `/clear` 清除缓存重新拉取

---

## 🏗️ 架构

```
┌─────────────┐    ┌──────────────────┐    ┌───────────────┐
│ Telegram Bot │───▶│ Cloudflare Worker│───▶│ GitHub Action │
│  (/novel)    │    │ (搜索+状态管理)   │    │ (全量爬虫)     │
└─────────────┘    └────────┬─────────┘    └───────┬───────┘
                            │                      │
                            ▼                      ▼
                     ┌──────────────┐      ┌──────────────┐
                     │ KV Cache     │      │ GitHub Pages │
                     │ (元数据缓存)  │      │ (RSS托管)     │
                     └──────────────┘      └──────┬───────┘
                                                   │
                                                   ▼
                                          ┌────────────────┐
                                          │ Apple Podcasts  │
                                          │ Overcast / 其他 │
                                          └────────────────┘
```

### 流程

1. **用户** 给 Telegram bot 发 `/novel 凡人修仙传`
2. **Cloudflare Worker** 搜索蜻蜓FM，找频道ID
   - 已爬完本 → **秒回**订阅链接，不触发 Action
   - 连载中 → 检查过期时间，触发增量更新
   - 新频道 → 触发全量爬取
3. **GitHub Action** 接收 dispatch，启动爬虫
   - 用蜻蜓API分批获取节目列表
   - JSON API 链式遍历补齐全量（比HTML页面快3-5倍）
   - 检测完本/连载，写入状态文件
   - 生成 RSS XML + 元数据
   - 部署到 GitHub Pages
   - 回调 Worker 更新 KV 缓存
   - Telegram 通知完成

---

## 🚀 部署教程

### 前置条件

| 项目 | 需要 |
|------|------|
| GitHub 账号 | 一个仓库放代码和 Pages |
| Cloudflare 账号 | 一个 Worker + KV Namespace（免费版足够） |
| Telegram Bot Token | 从 [@BotFather](https://t.me/BotFather) 创建 |

---

### 第一步：部署 GitHub 侧

#### 1.1 Fork / Clone 仓库

```bash
git clone https://github.com/你的用户名/qtfm-podcast.git
cd qtfm-podcast
```

#### 1.2 启用 GitHub Pages

1. 进入仓库 → Settings → Pages
2. Source: **Deploy from a branch**
3. Branch: `gh-pages` → `/ (root)`
4. Save

#### 1.3 配置 Secrets

进入仓库 → Settings → Secrets and variables → Actions，添加：

| Secret | 值 | 说明 |
|--------|------|------|
| `GH_PAT` | 你的 GitHub Personal Access Token | 用于部署 Pages（可选，有 GITHUB_TOKEN 自动生成的也行） |
| `TG_BOT_TOKEN` | Telegram Bot Token | 通知消息用 |
| `TG_CHAT_ID` | 你的 Telegram User ID | 通知发到谁 |

> 💡 `TG_CHAT_ID` 不知道的话，给 [@userinfobot](https://t.me/userinfobot) 发任意消息就能看到。

---

### 第二步：部署 Cloudflare Worker

#### 2.1 创建 KV Namespace

1. 进 CF Dashboard → Workers & Pages → KV
2. 创建 Namespace，名字叫 `QTFM_CACHE`

#### 2.2 创建 Worker

1. CF Dashboard → Workers & Pages → 创建 Worker
2. 名称填 `qtfm-podcast`
3. 把 `worker.js` 的内容粘贴进去
4. 设置 KV 绑定：

   | 变量名 | KV Namespace |
   |--------|-------------|
   | `QTFM_CACHE` | 选刚才创建的 `QTFM_CACHE` |

5. 设置环境变量 (Secrets)：

   | 变量名 | 值 |
   |--------|-----|
   | `TG_TOKEN` | Telegram Bot Token（跟上面一样） |
   | `GH_TOKEN` | GitHub Personal Access Token（有 repo dispatch 权限） |
   | `GH_REPO` | `你的用户名/qtfm-podcast` |

6. 部署

#### 2.3 设置 Webhook

部署完后，在浏览器访问：

```
https://api.telegram.org/bot<你的TG_TOKEN>/setWebhook?url=https://qtfm-podcast.你的用户名.workers.dev/webhook
```

> ⚠️ 把 `<你的TG_TOKEN>` 替换成你的 bot token，`你的用户名` 替换成你的 CF 子域名

验证：

```
https://api.telegram.org/bot<你的TG_TOKEN>/getWebhookInfo
```

返回 `"url": "https://qtfm-podcast.你的用户名.workers.dev/webhook"` 即可。

#### 2.4 设置 Bot 命令菜单

用 bot 给 Worker 发：

```
https://qtfm-podcast.你的用户名.workers.dev/setmenu
```

---

### 第三步：开始使用

给 Telegram bot 发 `/start`，看到帮助信息就说明部署成功。

试试 `/novel 凡人修仙传` 搜索第一本小说。

---

## 🤖 Bot 命令一览

| 命令 | 说明 |
|------|------|
| `/start` | 显示帮助信息 |
| `/novel 小说名` | 搜索蜻蜓FM，自动判断完本/连载 |
| `/status 频道ID` | 查看频道详细状态（集数、完本/连载、缓存时间） |
| `/update 频道ID` | 强制更新指定频道 |
| `/updateall` | 一键更新所有连载频道（单次最多10个） |
| `/clear [频道ID]` | 清除全部或指定频道缓存 |
| `/list` | 显示已抓取频道列表 |

---

## ⚙️ 技术细节

### 爬虫 (`scripts/scrape.js`)

- 使用 **蜻蜓FM 移动端 API** 获取数据
- 先尝试批量 API 分页，失败则用 JSON API 链式遍历
- **速度对比**：
  - 旧版（HTML页面临析）：1000集 ≈ 15-30分钟
  - 新版（JSON API链式）：1000集 ≈ 5-10分钟
- 自动检测**完本/连载**，写入 `state.json`
- RSS 按标题编号排序（支持 `第X集/级/章`）

### Worker (`worker.js`)

- 基于 **Cloudflare Workers**，全球边缘节点响应
- 状态管理：KV 缓存频道元数据，完本长期缓存
- RSS 优先从 GitHub Pages 获取全量数据
- 音频代理：实时解析并跳转音频直链
- 定时任务：定期刷新连载频道，同步 Pages 状态

### Git 工作流

- `master` 分支：代码
- `gh-pages` 分支：RSS + 元数据（自动部署，不覆盖旧数据）
- GitHub Action：通过 `repository_dispatch` 触发

---

## ❓ 常见问题

**Q: 为什么用 GitHub Action 不用 Worker 直接爬？**
A: Worker 有 30 秒 CPU 限制，几千集爬不完。Action 无时间限制。

**Q: 播客 App 里顺序不对？**
A: 检查 RSS 链接是否来自 Pages（`general74110.github.io/qtfm-podcast/{id}.xml`），Worker 的 RSS 是完整的 Pages 代理。

**Q: 音频播放不了？**
A: 检查 Worker 的 `/audio/{频道ID}/{节目ID}` 是否能手动访问。签名可能需要刷新。

**Q: 连载频道多久检查一次更新？**
A: Worker 每 6 小时检查一次（通过 Cron 触发）。手动 `/update` 即时生效。

---

## 📝 许可证

MIT
