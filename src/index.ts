/**
 * @dsh-external/dsh-ocgo-usage — 宿主半。
 *
 * OpenCode Go 套餐用量插件：
 * - 额度查询 A（API Key，支持多个）：GET https://opencode.ai/zen/go/v1/usage，Bearer <apiKey>
 *     key 来源：手动添加（多个）/ 本机 ~/.local/share/opencode/auth.json 自动发现 / 环境变量
 * - 额度查询 B（网页 Cookie，支持多账号）：优先 /_server server-fn RPC，降级抓
 *     workspace/<wrk_xxx>/go 页面正则解析（Ruinique/opencode-go-dashboard 方案）
 * - 持久化：~/.dsh/ocgo-usage/state.json（keys、cookie 账号、最近一次额度缓存）
 * - Client 经 webServer 前缀路由 /api/dsh-ocgo-usage/* 访问（JSON 信封 {ok,value|error}）。
 */
import type { Context } from 'cordis'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

type AnyRecord = Record<string, any>

type HostContext = Context & {
  webServer: {
    register(route: { kind: string; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
    host?: string
    port?: number
  }
  setInterval(fn: () => void, ms: number): any
}

export const name = "dsh-opencode-go-dashboard"
export const inject = ['webServer', 'timer']

const AUTO_REFRESH_MS = 5 * 60 * 1000

const ROUTE_PREFIX = '/api/dsh-ocgo-usage'
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ocgo-usage')
const STATE_FILE = join(STATE_DIR, 'state.json')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

// ─── 类型 ───────────────────────────────────────────────────────────────

interface UsageWindow {
  usagePercent: number
  resetInSec?: number
  resetsAt?: string
}

interface UsageResult {
  rolling: UsageWindow | null
  weekly: UsageWindow | null
  monthly: UsageWindow | null
  plan: string | null
  fetchedAt: string
  error?: string
}

interface CookieAccount {
  id: string
  name: string
  workspaceId: string
  cookie: string
}

interface ApiKeyEntry {
  id: string
  label: string
  key: string
}

interface OcgoState {
  apiKeys: ApiKeyEntry[]
  cookieAccounts: CookieAccount[]
  lastUsage?: Record<string, UsageResult>
}

// ─── 状态读写 ────────────────────────────────────────────────────────────

function loadState(): OcgoState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as any
      const apiKeys: ApiKeyEntry[] = Array.isArray(raw.apiKeys)
        ? raw.apiKeys.filter((k: any) => k && typeof k.key === 'string' && k.key)
        : []
      // 迁移旧版单 key 字段
      if (apiKeys.length === 0 && typeof raw.apiKey === 'string' && raw.apiKey) {
        apiKeys.push({ id: 'k1', label: 'Key 1', key: raw.apiKey })
      }
      return {
        apiKeys,
        cookieAccounts: Array.isArray(raw.cookieAccounts) ? raw.cookieAccounts : [],
        lastUsage: raw.lastUsage ?? {},
      }
    }
  } catch { /* 损坏即重置 */ }
  return { apiKeys: [], cookieAccounts: [], lastUsage: {} }
}

let state: OcgoState = loadState()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveState(): void {
  // 合并写（防抖），避免高频轮询时反复刷盘
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const persistable = { ...state, device: null }
      writeFileSync(STATE_FILE, JSON.stringify(persistable, null, 2), 'utf8')
    } catch { /* 写失败静默，内存态仍可用 */ }
  }, 200)
}

// ─── 本机 Key 发现 ────────────────────────────────────────────────────────

interface DiscoveredKey {
  key: string
  source: string
}

function extractApiKeyFromObject(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null
  if (typeof obj.apiKey === 'string' && obj.apiKey.startsWith('sk-')) return obj.apiKey
  if (typeof obj.key === 'string' && obj.key.startsWith('sk-')) return obj.key
  if (typeof obj.token === 'string' && obj.token.startsWith('sk-')) return obj.token
  if (obj.opencode && typeof obj.opencode === 'object') {
    if (typeof obj.opencode.key === 'string' && obj.opencode.key.startsWith('sk-')) return obj.opencode.key
    if (typeof obj.opencode.apiKey === 'string' && obj.opencode.apiKey.startsWith('sk-')) return obj.opencode.apiKey
    if (typeof obj.opencode.token === 'string' && obj.opencode.token.startsWith('sk-')) return obj.opencode.token
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.startsWith('sk-')) return val
    if (val && typeof val === 'object') {
      const nested = extractApiKeyFromObject(val)
      if (nested) return nested
    }
  }
  return null
}

function discoverLocalApiKey(): DiscoveredKey | null {
  // 1. 环境变量
  const envVars = [
    { name: 'OPENCODE_API_KEY', val: process.env.OPENCODE_API_KEY },
    { name: 'OPENCODE_KEY', val: process.env.OPENCODE_KEY },
    { name: 'ZEN_API_KEY', val: process.env.ZEN_API_KEY },
  ]
  for (const { name, val } of envVars) {
    if (val && typeof val === 'string' && val.trim().startsWith('sk-')) {
      return { key: val.trim(), source: `环境变量 (${name})` }
    }
  }

  // 2. 本机配置文件
  const candidatePaths = [
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    join(homedir(), '.config', 'opencode', 'auth.json'),
    join(homedir(), '.opencode', 'auth.json'),
    join(homedir(), '.local', 'share', 'opencode', 'opencode.json'),
    join(homedir(), '.config', 'opencode', 'opencode.json'),
  ]

  for (const p of candidatePaths) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf8'))
        const key = extractApiKeyFromObject(raw)
        if (key) {
          return { key, source: '本机 auth.json' }
        }
      }
    } catch {
      // 忽略读取/解析错误
    }
  }

  return null
}

// ─── 额度查询 A：API Key（官方 JSON API）────────────────────────────────

async function fetchQuotaByApiKey(apiKey: string): Promise<UsageResult> {
  const res = await fetch('https://opencode.ai/zen/go/v1/usage', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': UA },
  })
  if (res.status === 401) throw new Error('API Key 无效或已过期 (401)')
  if (res.status === 403) throw new Error('该 Key 没有 Go 套餐订阅 (403)')
  if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`)
  const data: any = await res.json().catch(() => null)
  const usage = data?.usage
  if (!usage?.rolling || !usage?.weekly || !usage?.monthly) {
    throw new Error('响应缺少 rolling/weekly/monthly 字段')
  }
  const win = (w: any): UsageWindow => ({
    usagePercent: Math.min(100, Math.max(0, Number(w.percent))),
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : undefined,
  })
  return {
    rolling: win(usage.rolling),
    weekly: win(usage.weekly),
    monthly: win(usage.monthly),
    plan: typeof data?.plan === 'string' ? data.plan : null,
    fetchedAt: new Date().toISOString(),
  }
}

// ─── 额度查询 B：网页 Cookie ─────────────────────────────────────────────
// 主路径：/_server RPC（SolidStart server function，实测稳定，返回内联 RSC 对象）
// 降级：抓 workspace/go 页面 HTML 正则解析（页面结构变更时可能失效）

// 查询 Go 用量的 server-fn 稳定 ID（来自 workspace/<wrk>/go 页面的实际请求抓包）
const SERVER_FN_USAGE_ID = 'c7389bd0e731f80f49593e5ee53835475f4e28594dd6bd83eb229bab753498cd'

const USAGE_PATTERNS: Record<string, RegExp> = {
  rolling: /rollingUsage:\s*\$R\[\d+\]\s*=\s*(\{[^}]*\})/,
  weekly: /weeklyUsage:\s*\$R\[\d+\]\s*=\s*(\{[^}]*\})/,
  monthly: /monthlyUsage:\s*\$R\[\d+\]\s*=\s*(\{[^}]*\})/,
}
const PLAN_PATTERN = /plan:\$R\[\d+\]="([^"]+)"/

function parseUsageObject(raw: string): UsageWindow | null {
  try {
    const jsonStr = raw.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')
    const parsed = JSON.parse(jsonStr) as { usagePercent?: number; resetInSec?: number }
    if (typeof parsed.usagePercent !== 'number') return null
    return {
      usagePercent: Math.min(100, Math.max(0, parsed.usagePercent)),
      resetInSec: typeof parsed.resetInSec === 'number' ? parsed.resetInSec : undefined,
    }
  } catch {
    return null
  }
}

function emptyUsage(): any {
  return { rolling: null, weekly: null, monthly: null, plan: null, fetchedAt: new Date().toISOString() }
}

/** 主路径：/_server server-fn RPC。 */
async function fetchQuotaViaServerFn(ws: string, cookie: string): Promise<UsageResult> {
  const args = encodeURIComponent(JSON.stringify({
    t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: ws }], o: 0 },
    f: 31,
    m: [],
  }))
  const url = `https://opencode.ai/_server?id=${SERVER_FN_USAGE_ID}&args=${args}`
  const res = await fetch(url, {
    headers: {
      Accept: '*/*',
      'User-Agent': UA,
      Cookie: `auth=${cookie}`,
      Referer: `https://opencode.ai/workspace/${ws}/usage`,
      'x-server-id': SERVER_FN_USAGE_ID,
      'x-server-instance': 'server-fn:13',
    },
  })
  if (res.status === 401 || res.status === 403) throw new Error('认证失败，Cookie 可能已过期')
  if (!res.ok) throw new Error(`server-fn 请求失败 (HTTP ${res.status})`)
  const body = await res.text()
  if (body.includes('sign-in') && !body.includes('usagePercent')) {
    throw new Error('会话已过期，请重新复制 Cookie')
  }
  const usage: any = emptyUsage()
  for (const [key, pattern] of Object.entries(USAGE_PATTERNS)) {
    const m = body.match(pattern)
    if (m) usage[key] = parseUsageObject(m[1])
  }
  if (!usage.rolling && !usage.weekly && !usage.monthly) {
    throw new Error('server-fn 响应中未找到用量数据（函数 ID 可能已变更）')
  }
  return usage
}

/** 降级：抓 workspace/go 页面 HTML 解析。 */
async function fetchQuotaViaHtml(ws: string, cookie: string): Promise<UsageResult> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(ws)}/go`
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: `auth=${cookie}`,
    },
    redirect: 'follow',
  })
  if (res.status === 401 || res.status === 403) throw new Error('认证失败，Cookie 可能已过期')
  if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`)
  if (res.url.includes('/sign-in') || res.url.includes('/login')) {
    throw new Error('会话已过期，请重新复制 Cookie')
  }
  const html = await res.text()
  if (html.includes('/sign-in') && !html.includes('rollingUsage')) {
    throw new Error('会话已过期，请重新复制 Cookie')
  }
  const usage: any = emptyUsage()
  for (const [key, pattern] of Object.entries(USAGE_PATTERNS)) {
    const m = html.match(pattern)
    if (m) usage[key] = parseUsageObject(m[1])
  }
  const pm = html.match(PLAN_PATTERN)
  if (pm) usage.plan = pm[1]
  if (!usage.rolling && !usage.weekly && !usage.monthly) {
    throw new Error('无法从页面解析额度数据，页面结构可能已变更')
  }
  return usage
}

async function fetchQuotaByCookie(workspaceId: string, authCookie: string): Promise<UsageResult> {
  const ws = workspaceId.trim()
  const cookie = authCookie.trim()
  if (!/^wrk_[a-zA-Z0-9]+$/.test(ws)) throw new Error('Workspace ID 格式无效（应为 wrk_xxx）')
  if (!cookie.startsWith('Fe26.')) throw new Error('Auth Cookie 应以 Fe26. 开头')
  try {
    return await fetchQuotaViaServerFn(ws, cookie)
  } catch (e) {
    // server-fn 失效时降级到 HTML 解析；认证类错误直接抛（换路径也一样过期）
    const msg = String((e as any)?.message ?? e)
    if (msg.includes('过期') || msg.includes('认证失败')) throw e
    return await fetchQuotaViaHtml(ws, cookie)
  }
}

// ─── 刷新全部额度源 ──────────────────────────────────────────────────────

async function refreshAll(): Promise<Record<string, UsageResult>> {
  const results: Record<string, UsageResult> = {}

  // 源 1+：每个 API Key（显式添加的多个 key）
  for (const entry of state.apiKeys) {
    const resultId = `key:${entry.id}`
    try {
      results[resultId] = await fetchQuotaByApiKey(entry.key)
      const plan = results[resultId].plan
      results[resultId].plan = plan ? `${plan} · ${entry.label}` : entry.label
    } catch (e) {
      results[resultId] = {
        rolling: null, weekly: null, monthly: null, plan: entry.label,
        fetchedAt: new Date().toISOString(), error: errMsg(e),
      }
    }
  }

  // 补充源：本机自动发现的 key（未手动添加任何 key 时才用，避免重复）
  if (state.apiKeys.length === 0) {
    const found = discoverLocalApiKey()
    if (found) {
      try {
        results.local = await fetchQuotaByApiKey(found.key)
        const plan = results.local.plan
        results.local.plan = plan ? `${plan} · ${found.source}` : found.source
      } catch (e) {
        results.local = {
          rolling: null, weekly: null, monthly: null, plan: found.source,
          fetchedAt: new Date().toISOString(), error: errMsg(e),
        }
      }
    }
  }

  // 源：每个 Cookie 账号
  for (const acc of state.cookieAccounts) {
    try {
      results[acc.id] = await fetchQuotaByCookie(acc.workspaceId, acc.cookie)
    } catch (e) {
      results[acc.id] = {
        rolling: null, weekly: null, monthly: null, plan: acc.name,
        fetchedAt: new Date().toISOString(), error: errMsg(e),
      }
    }
  }

  state.lastUsage = results
  saveState()
  return results
}

function errMsg(e: unknown): string {
  return String((e as any)?.message ?? e).slice(0, 160)
}

// ─── 公开视图（脱敏）────────────────────────────────────────────────────

function publicState() {
  return {
    apiKeys: state.apiKeys.map(({ id, label }) => ({ id, label })),
    localKeyFound: Boolean(discoverLocalApiKey()),
    // 额度可查：至少一个 key、本机自动发现、或至少一个 cookie 账号
    canQueryQuota: state.apiKeys.length > 0 || Boolean(discoverLocalApiKey()) || state.cookieAccounts.length > 0,
    accounts: state.cookieAccounts.map(({ id, name, workspaceId }) => ({ id, name, workspaceId })),
    usage: state.lastUsage ?? {},
  }
}

// ─── webServer 路由 ─────────────────────────────────────────────────────

function json(res: any, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function jsonOk(res: any, value: unknown): void {
  json(res, { ok: true, value })
}

function jsonErr(res: any, message: string, code = 400): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: { message } }))
}

async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function sameOrigin(req: any): boolean {
  const origin = req.headers.origin
  if (!origin) return true // 同源 GET 或非浏览器客户端
  try {
    const host = req.headers.host ?? ''
    return new URL(origin).host.toLowerCase() === String(host).toLowerCase()
  } catch {
    return false
  }
}

export function apply(ctx: HostContext): void {
  ctx.logger?.info?.('[ocgo-usage] host half starting')

  const disposeRoutes = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const path = url.pathname.replace(ROUTE_PREFIX, '') || '/'
      try {
        // ── 状态 ──
        if (req.method === 'GET' && path === '/state') {
          jsonOk(res, publicState())
          return
        }
        // ── API key（多个）──
        if (req.method === 'POST' && path === '/credentials/apikey') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const key = String(body.apiKey ?? '').trim()
          if (!key.startsWith('sk-')) return jsonErr(res, 'API Key 应以 sk- 开头')
          const label = String(body.label ?? '').trim() || `Key ${state.apiKeys.length + 1}`
          const id = typeof body.id === 'string' && body.id ? body.id : randomUUID().slice(0, 8)
          const existing = state.apiKeys.find((k) => k.id === id)
          if (existing) {
            existing.label = label
            existing.key = key
          } else {
            state.apiKeys.push({ id, label, key })
          }
          saveState()
          jsonOk(res, { apiKeys: state.apiKeys.map(({ id: i, label: l }) => ({ id: i, label: l })) })
          return
        }
        if (req.method === 'POST' && path === '/credentials/apikey/remove') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const before = state.apiKeys.length
          const removedIds = state.apiKeys.filter((k) => k.id === String(body.id ?? '')).map((k) => `key:${k.id}`)
          state.apiKeys = state.apiKeys.filter((k) => k.id !== String(body.id ?? ''))
          for (const rid of removedIds) delete state.lastUsage?.[rid]
          saveState()
          jsonOk(res, { removed: before - state.apiKeys.length })
          return
        }
        // ── Cookie 账号 ──
        if (req.method === 'POST' && path === '/credentials/account') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const name = String(body.name ?? '').trim() || '账号'
          const workspaceId = String(body.workspaceId ?? '').trim()
          const cookie = String(body.cookie ?? '').trim()
          if (!/^wrk_[a-zA-Z0-9]+$/.test(workspaceId)) return jsonErr(res, 'Workspace ID 格式无效（应为 wrk_xxx）')
          if (!cookie.startsWith('Fe26.')) return jsonErr(res, 'Auth Cookie 应以 Fe26. 开头')
          const id = typeof body.id === 'string' && body.id ? body.id : randomUUID().slice(0, 8)
          const existing = state.cookieAccounts.find((a) => a.id === id)
          if (existing) {
            existing.name = name
            existing.workspaceId = workspaceId
            existing.cookie = cookie
          } else {
            state.cookieAccounts.push({ id, name, workspaceId, cookie })
          }
          saveState()
          jsonOk(res, { accounts: state.cookieAccounts.map(({ id: i, name: n, workspaceId: w }) => ({ id: i, name: n, workspaceId: w })) })
          return
        }
        if (req.method === 'POST' && path === '/credentials/account/remove') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const before = state.cookieAccounts.length
          state.cookieAccounts = state.cookieAccounts.filter((a) => a.id !== String(body.id ?? ''))
          delete state.lastUsage?.[String(body.id ?? '')]
          saveState()
          jsonOk(res, { removed: before - state.cookieAccounts.length })
          return
        }
        // ── 额度 ──
        if (req.method === 'GET' && path === '/quota') {
          jsonOk(res, state.lastUsage ?? {})
          return
        }
        if (req.method === 'POST' && path === '/quota/refresh') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          jsonOk(res, await refreshAll())
          return
        }
        jsonErr(res, 'not found', 404)
      } catch (e) {
        jsonErr(res, errMsg(e), 500)
      }
    },
  })

  ctx.effect(() => disposeRoutes, 'ocgo-usage: routes')

  // ── 定时自动刷新（每 5 分钟；有凭据才刷，防重叠）──
  let refreshing = false
  const autoRefresh = async (): Promise<void> => {
    if (refreshing) return
    const hasCreds = state.apiKeys.length > 0 || Boolean(discoverLocalApiKey()) || state.cookieAccounts.length > 0
    if (!hasCreds) return
    refreshing = true
    try {
      await refreshAll()
    } catch { /* 单轮失败静默，下轮再试 */ }
    finally { refreshing = false }
  }
  ctx.effect(() => ctx.setInterval(() => { void autoRefresh() }, AUTO_REFRESH_MS), 'ocgo-usage: auto-refresh timer')
  // 启动即刷一次（异步，不阻塞装配）
  void autoRefresh()

  ctx.logger?.info?.('[ocgo-usage] ready — settings 页新增「Go 用量」分区')
}
