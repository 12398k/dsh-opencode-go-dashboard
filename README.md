# dsh-opencode-go-dashboard

DeepSeek Harness (DSH) 插件：**OpenCode Go 套餐用量监控与管理面板**。

在 DSH Web GUI 中实时展示 OpenCode Go 套餐的 **5h 滚动用量 (Rolling) / 7d 每周用量 (Weekly) / 30d 每月用量 (Monthly)** 及重置倒计时。

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
帮我安装 dsh-opencode-go-dashboard 插件（OpenCode Go 套餐用量监控），步骤：
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

## ✨ 特性

- ⚡ **对话底栏快捷用量环**：在底部输入框右侧（模型选择器旁）原生对齐展示 **5h 滚动用量** 环形进度条，带颜色阈值警告（绿色正常 / 橙色告警 / 红色限速）。
- 🔍 **浮动悬窗详情 (Popover)**：鼠标悬停底栏圆环即可展示 5h / 7d / 30d 各档用量进度、百分比与精准重置倒计时。
- ⚙️ **设置页管理面板**：在 Web GUI **设置 -> Go 用量** 分区中查看全部额度详情，并支持多凭据管理。
- 🔑 **双查询通道支持**：
  1. **API Key 通道**（推荐）：支持录入多个 `sk-...` API Key，直连官方 `/zen/go/v1/usage` API，稳定且精准。同时支持自动发现本机 `auth.json` 凭证。
  2. **网页 Cookie 通道**：支持录入多工作区 (`wrk_xxx`) 与 `auth` Cookie，走 SolidStart server-fn RPC 原生接口查询。
- 🔄 **自动定时刷新**：后台每 5 分钟自动静默同步最新用量，底栏与设置页点击按钮可随时手动即时刷新。
- 🔒 **本地私密安全**：所有凭据与用量缓存仅加密保存在本机 `~/.dsh/ocgo-usage/state.json`，不上传任何第三方服务。

---

## 📖 使用指南

### 1. 配置凭据
打开 DSH Web GUI **设置 -> Go 用量 -> 凭据** 选项卡：
- **添加 API Key**：在 [opencode.ai 控制台](https://opencode.ai/console) 的 Keys 页面生成 `sk-...` 密钥，填入并保存（可添加多个备注不同的 Key）。
- **添加 Cookie 账号**：在浏览器打开 opencode 控制台，从 DevTools 的 Application -> Cookies 中复制 `auth` Cookie（以 `Fe26.` 开头）与工作区 ID (`wrk_...`)。

### 2. 查看额度
- **日常对话**：在底部输入框工具栏直接观察圆环与 5h 百分比，鼠标 Hover 查看 7d / 30d 完整重置倒计时。
- **详细面板**：在 **设置 -> Go 用量 -> 额度** 中查看每个凭据源的独立额度条。

---

## 📄 License

[MIT License](./LICENSE)
