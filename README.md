# dsh-opencode-go-dashboard

DeepSeek Harness (DSH) 插件：**OpenCode Go & Google Antigravity (Gemini) 智能用量双擎监控面板**。

在 DSH Web GUI 中实时识别当前使用的模型与供应商：
- **OpenCode Go 系列**：展示 **5h 滚动用量 (Rolling) / 7d 每周用量 (Weekly) / 30d 每月用量 (Monthly)** 及重置倒计时。
- **Google Antigravity 系列**：识别到 Gemini 系列模型时，自动无缝切换到 Antigravity 的实时用量显示，支持 Google OAuth 动态刷新与拉取 Gemini 3.8/3.7/3.6/3.1/2.5 等全部模型的实时配额。
- **灵活供应商路由**：支持手动自由选择切换到某个/某些供应商时显示 Go 还是 Antigravity。

---

## 🚀 安装

### 方式一：终端命令行安装（推荐）

在运行 DSH 的服务器或本机终端执行：

```bash
dsh plugin --profile web add dsh-opencode-go-dashboard@latest
```

安装完成后在浏览器中硬刷新 Web GUI（`Ctrl+Shift+R` 或 `Cmd+Shift+R`）即可生效。

---

### 方式二：让 DSH 智能体自动安装

直接把下面这段话发给任意一个 DSH 会话：

```text
帮我安装 dsh-opencode-go-dashboard 插件（OpenCode Go & Antigravity 双擎用量监控），步骤：
1. 在终端执行 dsh plugin --profile web add dsh-opencode-go-dashboard@latest
2. 安装成功后提醒我硬刷新浏览器（Ctrl+Shift+R / Cmd+Shift+R）
```

---

### 方式三：源码本地开发注入（无需 npm）

在本地开发调试时，可通过超级注入器运行时免重启注入：

```bash
# 构建
npm run build

# 在 DSH 会话中调用工具注入
dev_inject_plugin {"dir": "/绝对路径/dsh-opencode-go-dashboard"}
```

---

## ✨ 核心特性

- 🤖 **智能模型识别与自动切源**：
  - 实时感知会话当前选中的模型（如 `gemini-3.8-flash-tiered`, `gemini-3.6-flash`, `gemini-2.5-pro` 等）；
  - 检测到属于 Gemini 系列模型或 `agy` 供应商时，自动无缝切换到底栏 Antigravity 的用量与重置时间；
  - 切换到其他模型或供应商时，自动恢复展示 OpenCode Go 的用量水位。
- ⚙️ **供应商显示路由策略自定义**（用户按需手动设定）：
  - **智能自动 (Auto - 推荐)**：真实读取会话当前选中的 `provider/model`，命中正则规则即按规则切源，否则 Gemini 系列自动切 Antigravity、其余显示 Go；
  - **按供应商规则映射 (Provider Rules)**：为每一个系统检测到的供应商（如 `agy`, `nas`, `lmstudio` 等）单独绑定显示 OpenCode Go 还是 Antigravity 用量；
  - **供应商正则匹配**：用正则（不区分大小写）批量匹配供应商/模型，依次测试 `provider/model` → `provider` → `model` → 模型显示名，首个命中的启用规则生效，适合 ID 不固定的供应商（`opencode-go-native`、`agy`、`agycli` 等）；内置默认 `opencode*` → Go、`agycli` → Antigravity(wym)、`agy|antigravity|gemini` → Antigravity(qiyu)，可增删/停用/恢复默认；
  - **判定优先级**：手动切源 > 固定模式 > 精确绑定 > 正则规则 > 自动识别；界面提供「实时自检」显示当前供应商/模型与命中的规则；
  - **手动全局锁定**：支持强制固定显示 OpenCode Go 或 Antigravity；
  - **底栏快捷切源**：Composer 悬浮卡片顶部随时一键手动切源 (`[切为 Go ⇄]` / `[切为 Agy ⇄]`)。
- 🪐 **Antigravity Google OAuth 引擎**：
  - 支持 Google OAuth 凭证的保存与动态刷新（Token 过期自动使用官方 Client ID 自动续期）；
  - 自动发现：支持自动探测本机 `cliproxy/auths`、`antigravity-cli` 及同机 `dsh-agy-link` 凭证；
  - 动态拉取与监控各 Gemini 模型的配额百分比（`remainingFraction`）与重置倒计时。
- ⚡ **OpenCode Go 工业级多源号池**：
  - 支持录入多个 API Key，直连 `/zen/go/v1/usage`，监控多 Key 汇总与最高水位；
  - 支持录入网页 Cookie (`wrk_xxx` + `Fe26...`)，SolidStart server-fn RPC 原生接口查询。
- 📊 **对话底栏快捷圆环 (Composer Ring)**：
  - 输入框右侧原生对齐展示 5h 进度圆环（`Go` 标或 `Agy` 标），颜色根据水位自动变色；
  - 点击胶囊展开常驻悬浮卡片（点击卡片外部自动关闭），卡片内按钮可从容点击；
  - 卡片顶部提供一键切源：`[切为 Go ⇄]` / `[切为 Agy ⇄]`；
  - 卡片内显示精确重置倒计时，客户端定时与宿主 `serverTime` 对齐，系统时钟不准也不会出现跳变或负数。
- 🔄 **自适应静默刷新**：默认 30 秒后台自动同步，失败自动指数退避（最长 5 分钟一次），避免触发上游限流（429）。
- 🔒 **本地私密安全**：所有凭证保存在本地 `~/.dsh/ocgo-usage/state.json`，不经第三方转发。

---

## 📖 使用指南

### 配置供应商显示策略
打开 DSH Web GUI **设置 -> Go / Agy 用量 -> 供应商显示策略**：
- 可选择“智能自动模式”或“按供应商规则指定”（两种模式下精确绑定与正则规则都会生效）；
- 针对列表中识别到的供应商（如 `agy`, `nas`, `lmstudio` 等），自由选择绑定显示哪个用量引擎；
- 在「供应商正则匹配切换」卡片里增删正则规则：`pattern` 为不区分大小写的正则，`目标` 选择 Go / Antigravity(qiyu) / Antigravity(wym)；
  卡片顶部「实时自检」会显示当前探测到的 `供应商 / 模型` 与最终判定依据，改完点「保存正则规则」即刻生效（无需重启）。

### 配置 Antigravity OAuth 客户端凭证（前置）

Antigravity 的 OAuth 需要一对 Google OAuth 客户端凭证来换取 / 续期 Token。本插件**源码内不保存任何明文密钥**，请写进 `~/.dsh/.env`（`dsh` 启动时会自动加载该文件；也可改用系统环境变量注入）：

```dotenv
# ~/.dsh/.env
AGY_CLIENT_ID=你的 Google OAuth Client ID
AGY_CLIENT_SECRET=你的 Google OAuth Client Secret
```

取值可从本机已装好的 Antigravity CLI / cliproxy 的 OAuth 配置里复制（`~/.antigravity/`、`cliproxy/auths/` 等处通常已有）。进程环境优先，缺失时插件会直接兜底解析 `~/.dsh/.env`，因此**写入后无需重启 dsh**，点一次「刷新」即可生效；若两项都缺失，Antigravity 的自动续期与「网页一键授权」会直接返回该提示，但不影响已缓存 access token 的读取。

### 配置 Antigravity OAuth 凭证
在 **设置 -> Go / Agy 用量 -> 凭据管理 -> Google Antigravity**：
- **方式一（本地自动发现）**：若本机已登录 cliproxy 或 agy CLI，直接点击“一键导入”；
- **方式二（手动粘贴 Refresh Token）**：输入 Google OAuth Refresh Token 并保存；
- **方式三（网页一键授权）**：点击“打开 Google 授权窗口”，登录后粘贴 authorization code 兑换。

### 配置 OpenCode Go 凭证
在 **凭据管理 -> OpenCode Go**：
- **添加 API Key**：输入 `sk-...` 密钥并保存；
- **添加 Cookie 账号**：输入工作区 ID 与 auth Cookie。

---

## 💾 数据存放位置

| 内容 | 路径 |
| --- | --- |
| OAuth 客户端凭证 | `~/.dsh/.env`（`AGY_CLIENT_ID` / `AGY_CLIENT_SECRET`，权限 0600） |
| 凭据与用量缓存 | `~/.dsh/ocgo-usage/state.json`（权限 0600） |
| 显示策略（写回宿主配置） | `~/.dsh/settings.yaml` |

所有请求都由宿主进程发起，浏览器侧仅访问同源内存接口 `/api/dsh-ocgo-usage/*`，不向第三方端点直接发送凭证。

---

## 🧪 开发与自测

```bash
npm run build       # 编译宿主端 + 打包客户端 bundle（输出 lib/）
npm run typecheck   # TypeScript 全量类型检查
npm test            # 路由判定 + 设置页渲染回归测试（26 项断言）
```

`npm test` 覆盖供应商正则优先级、精确绑定、手动切源与界面渲染契约；发布前 `prepack` 会自动执行构建，保证 npm 包内 `lib/` 与源码一致。

---

## ❓ 常见问题

**底栏圆环显示 `—` 或提示「可在设置页的「凭据管理」中添加或导入账号」**
说明当前引擎没有任何可用凭证，按上面「使用指南」配置对应引擎的凭据即可。

**切了模型，底栏没跟着换引擎**
先看设置页卡片顶部的「实时自检」：它会显示当前探测到的 `供应商 / 模型` 与命中的规则。若供应商 ID 是未知的（如自建 localhost 供应商），用正则规则或精确绑定把它绑到目标引擎。

**Cookie 通道报「认证失败，Cookie 可能已过期」**
`Fe26...` Cookie 属于会话态，退出 opencode 控制台登录后即失效，重新复制一次即可。

**Antigravity 提示「未配置 Antigravity OAuth 客户端凭证」**
按「使用指南」第一步把 `AGY_CLIENT_ID` / `AGY_CLIENT_SECRET` 写进 `~/.dsh/.env` 即可（插件直接读取该文件，无需重启）；若你的宿主版本较旧，重启一次 dsh。已缓存的 access token 在此提示期间仍可正常读取。

**Antigravity 提示 Token 失效**
插件会用内置 Client ID 自动续期；若 Refresh Token 本身被撤销（改密码 / 撤销授权），需要重新导入或走「网页一键授权」。

**用量数字长时间不刷新**
宿主侧失败会指数退避到最长 5 分钟；在设置页点「刷新」可立即重试一次。

---

## 📝 更新日志

### 0.2.0
- 新增 **Google Antigravity (Gemini) 双擎**：Google OAuth 自动续期、多账号（`qiyu (agy)` / `wym (agy-cli)`）精准归属、`retrieveUserQuotaSummary` 真实配额与重置时间。
- Google OAuth 客户端凭证改由 `AGY_CLIENT_ID` / `AGY_CLIENT_SECRET` 提供（优先进程环境，兜底解析 `~/.dsh/.env`），源码与 npm 包内不保存明文密钥。
- 新增**供应商路由策略**：智能自动识别 / 按供应商精确绑定 / 正则匹配规则（可增删、停用、恢复默认），并按 `手动切换 > 固定模式 > 精确绑定 > 正则 > 自动识别` 的优先级判定，界面提供「实时自检」。
- 重构底栏圆环与悬浮卡片：点击展开常驻面板、点击外部关闭、卡片内一键切源，倒计时与宿主机时钟对齐。
- 刷新调度升级为 30 秒基准 + 指数退避（最长 5 分钟），降低 429 概率。
- 完善防御性渲染与空值守卫，新增 `npm test` 回归测试（路由判定 + 设置页渲染）。

### 0.1.3
- 生产级加固：请求超时、限流退避、时钟对齐、干净的打包产物与 schema 守卫。

### 0.1.2
- 30 秒自动刷新、多账号号池视图、单账号清爽展示。

### 0.1.1
- 补齐 `cordis.patch.yml` 与 `dsh.bundle` 声明，`dsh plugin add` 后自动挂载。

### 0.1.0
- 首个版本：OpenCode Go（API Key / 网页 Cookie 双通道）用量监控、设置页面板与底栏 5h 圆环。

---

## 📄 License

[MIT License](./LICENSE)
