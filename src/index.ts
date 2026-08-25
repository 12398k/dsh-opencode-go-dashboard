/**
 * @dsh-external/dsh-opencode-go-dashboard — 宿主半（生产级健壮性重构）。
 *
 * 核心设计原则：
 * 1. 外部网关请求隔离：前端 UI 仅查询本地 Host 内存态（毫秒级，无跨域/网络压力）；外部网络请求全部由 Host 统一受控调度。
 * 2. 防御性网络与退避控制：外部请求均带 8s 超时熔断；遇 429 或网络连续异常时指数退避，杜绝 DDoS 攻击行为。
 * 3. 服务端时间戳基准（Clock Skew Compensation）：下发响应附带精确的服务端时间基准，彻底消除前端本地时钟漂移导致的倒计时幻觉。
 * 4. 防御性 Schema 校验：严格字段断言与 null 守卫，避免结构变异导致前端解构崩溃。
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

const BASE_REFRESH_INTERVAL_MS = 30 * 1000
const MAX_BACKOFF_INTERVAL_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8000

const ROUTE_PREFIX = '/api/dsh-ocgo-usage'
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ocgo-usage')
const STATE_FILE = join(STATE_DIR, 'state.json')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

// ─── 结构化类型定义 ───────────────────────────────────────────────────────

export interface UsageWindow {
  status?: 'ok' | 'rate-limited'
  usagePercent: number
  resetInSec?: number
  resetsAt?: string
}

export interface UsageResult {
  rolling: UsageWindow | null
  weekly: UsageWindow | null
  monthly: UsageWindow | null
  plan: string | null
  fetchedAt: string
  serverTime: number
  error?: string
}

export interface CookieAccount {
  id: string
  name: string
  workspaceId: string
  cookie: string
}

export interface ApiKeyEntry {
  id: string
  label: string
  key: string
}

export interface OcgoState {
  apiKeys: ApiKeyEntry[]
  cookieAccounts: CookieAccount[]
  lastUsage: Record<string, UsageResult>
}

export interface DiscoveredKey {
  key: string
  source: string
}

// ─── 状态持久化 ────────────────────────────────────────────────────────────

function loadState(): OcgoState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as any
      const apiKeys: ApiKeyEntry[] = Array.isArray(raw.apiKeys)
        ? raw.apiKeys.filter((k: any) => k && typeof k.key === 'string' && k.key.trim().startsWith('sk-'))
        : []
      // 兼容旧版单 key 迁移
      if (apiKeys.length === 0 && typeof raw.apiKey === 'string' && raw.apiKey.trim().startsWith('sk-')) {
        apiKeys.push({ id: 'k1', label: 'Key 1', key: raw.apiKey.trim() })
      }
      return {
        apiKeys,
        cookieAccounts: Array.isArray(raw.cookieAccounts) ? raw.cookieAccounts : [],
        lastUsage: typeof raw.lastUsage === 'object' && raw.lastUsage !== null ? raw.lastUsage : {},
      }
    }
  } catch { /* 文件损坏时优雅重置为初始状态 */ }
  return { apiKeys: [], cookieAccounts: [], lastUsage: {} }
}

let state: OcgoState = loadState()
let saveTimer: ReturnType<typeof setTimeout> | null = null

function saveState(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
    } catch { /* 文件系统权限受限时保留内存态 */ }
  }, 200)
}

// ─── 凭据自动发现 ────────────────────────────────────────────────────────

function extractApiKeyFromObject(obj: any): string | null {
  if (!obj || typeof obj !== 'object') return null
  for (const provider of ['opencode-go', 'opencode']) {
    const entry = obj[provider]
    if (entry && typeof entry === 'object') {
      const k = entry.key || entry.apiKey || entry.token
      if (typeof k === 'string' && k.trim().startsWith('sk-')) return k.trim()
    }
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim().startsWith('sk-')) return v.trim()
    if (typeof v === 'object' && v !== null) {
      const nested = extractApiKeyFromObject(v)
      if (nested) return nested
    }
  }
  return null
}

function discoverLocalApiKey(): DiscoveredKey | null {
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
        if (key) return { key, source: '本机 auth.json' }
      }
    } catch { /* 忽略单个文件解析异常 */ }
  }
  return null
}

// ─── 防御性网络请求封装 ──────────────────────────────────────────────────

async function safeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        ...(init.headers ?? {}),
      },
    })
    return res
  } finally {
    clearTimeout(timeoutId)
  }
}

function errMsg(e: unknown): string {
  if (!e) return '未知错误'
  if ((e as any)?.name === 'AbortError') return '请求超时 (超过8s)'
  const msg = (e as any)?.message ?? String(e)
  return msg.slice(0, 160)
}

function emptyUsage(plan: string | null = null): UsageResult {
  return {
    rolling: null,
    weekly: null,
    monthly: null,
    plan,
    fetchedAt: new Date().toISOString(),
    serverTime: Date.now(),
  }
}

// ─── 额度查询 A：API Key 官方接口 ───────────────────────────────────────

function sanitizeWindow(w: any): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const percent = Number(w.percent ?? w.usagePercent)
  if (isNaN(percent)) return null
  return {
    status: w.status === 'rate-limited' ? 'rate-limited' : 'ok',
    usagePercent: Math.min(100, Math.max(0, percent)),
    resetInSec: typeof w.resetInSec === 'number' ? Math.max(0, w.resetInSec) : undefined,
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : undefined,
  }
}

async function fetchQuotaByApiKey(apiKey: string): Promise<UsageResult> {
  const res = await safeFetch('https://opencode.ai/zen/go/v1/usage', {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  if (res.status === 401) throw new Error('API Key 无效或已过期 (401)')
  if (res.status === 403) throw new Error('该 Key 无 Go 订阅 (403)')
  if (res.status === 429) throw new Error('请求过于频繁，触发限流 (429)')
  if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`)

  let data: any = null
  try {
    data = await res.json()
  } catch (cause) {
    throw new Error('解析响应 JSON 失败')
  }

  const usage = data?.usage
  if (!usage || typeof usage !== 'object') throw new Error('响应缺少 usage 对象')

  const rolling = sanitizeWindow(usage.rolling)
  const weekly = sanitizeWindow(usage.weekly)
  const monthly = sanitizeWindow(usage.monthly)

  if (!rolling && !weekly && !monthly) {
    throw new Error('未能解析到任何有效用量窗口')
  }

  return {
    rolling,
    weekly,
    monthly,
    plan: typeof data?.plan === 'string' ? data.plan : null,
    fetchedAt: new Date().toISOString(),
    serverTime: Date.now(),
  }
}

// ─── 额度查询 B：网页 Cookie（SolidStart server-fn RPC）─────────────────

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
    const parsed = JSON.parse(jsonStr) as { usagePercent?: number; resetInSec?: number; status?: string }
    if (typeof parsed.usagePercent !== 'number') return null
    return {
      status: parsed.status === 'rate-limited' ? 'rate-limited' : 'ok',
      usagePercent: Math.min(100, Math.max(0, parsed.usagePercent)),
      resetInSec: typeof parsed.resetInSec === 'number' ? Math.max(0, parsed.resetInSec) : undefined,
    }
  } catch {
    return null
  }
}

async function fetchQuotaViaServerFn(ws: string, cookie: string): Promise<UsageResult> {
  const args = encodeURIComponent(JSON.stringify({
    t: { t: 9, i: 0, l: 1, a: [{ t: 1, s: ws }], o: 0 },
    f: 31,
    m: [],
  }))
  const url = `https://opencode.ai/_server?id=${SERVER_FN_USAGE_ID}&args=${args}`
  const res = await safeFetch(url, {
    headers: {
      Accept: '*/*',
      Cookie: `auth=${cookie}`,
      Referer: `https://opencode.ai/workspace/${ws}/usage`,
      'x-server-id': SERVER_FN_USAGE_ID,
      'x-server-instance': 'server-fn:14',
    },
  })
  if (res.status === 401 || res.status === 403) throw new Error('认证失败，Cookie 可能已过期')
  if (res.status === 429) throw new Error('请求过于频繁，触发限流 (429)')
  if (!res.ok) throw new Error(`server-fn 请求失败 (HTTP ${res.status})`)

  const body = await res.text()
  if (body.includes('sign-in') && !body.includes('usagePercent')) {
    throw new Error('会话已过期，请重新复制 Cookie')
  }

  const usage: UsageResult = emptyUsage()
  for (const [key, pattern] of Object.entries(USAGE_PATTERNS)) {
    const m = body.match(pattern)
    if (m) (usage as any)[key] = parseUsageObject(m[1])
  }
  if (!usage.rolling && !usage.weekly && !usage.monthly) {
    throw new Error('server-fn 响应未包含用量对象')
  }
  return usage
}

async function fetchQuotaViaHtml(ws: string, cookie: string): Promise<UsageResult> {
  const url = `https://opencode.ai/workspace/${encodeURIComponent(ws)}/go`
  const res = await safeFetch(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: `auth=${cookie}`,
    },
  })
  if (res.status === 401 || res.status === 403) throw new Error('认证失败，Cookie 可能已过期')
  if (!res.ok) throw new Error(`请求失败 (HTTP ${res.status})`)

  const html = await res.text()
  if (html.includes('/sign-in') && !html.includes('rollingUsage')) {
    throw new Error('会话已过期，请重新复制 Cookie')
  }
  const usage: UsageResult = emptyUsage()
  for (const [key, pattern] of Object.entries(USAGE_PATTERNS)) {
    const m = html.match(pattern)
    if (m) (usage as any)[key] = parseUsageObject(m[1])
  }
  const pm = html.match(PLAN_PATTERN)
  if (pm) usage.plan = pm[1]
  if (!usage.rolling && !usage.weekly && !usage.monthly) {
    throw new Error('无法从页面解析额度数据')
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
    const msg = String((e as any)?.message ?? e)
    if (msg.includes('过期') || msg.includes('认证失败')) throw e
    return await fetchQuotaViaHtml(ws, cookie)
  }
}

// ─── 刷新调度与退避控制 ──────────────────────────────────────────────────

let consecutiveFailures = 0

async function refreshAll(): Promise<Record<string, UsageResult>> {
  const results: Record<string, UsageResult> = {}
  let hadAnyFailure = false

  // 1. API Key 源
  for (const entry of state.apiKeys) {
    const resultId = `key:${entry.id}`
    try {
      results[resultId] = await fetchQuotaByApiKey(entry.key)
      const p = results[resultId].plan
      results[resultId].plan = p ? `${p} · ${entry.label}` : entry.label
    } catch (e) {
      hadAnyFailure = true
      results[resultId] = {
        ...emptyUsage(entry.label),
        error: errMsg(e),
      }
    }
  }

  // 2. 本机自动发现（无配置 key 时使用）
  if (state.apiKeys.length === 0) {
    const found = discoverLocalApiKey()
    if (found) {
      try {
        results.local = await fetchQuotaByApiKey(found.key)
        const p = results.local.plan
        results.local.plan = p ? `${p} · ${found.source}` : found.source
      } catch (e) {
        hadAnyFailure = true
        results.local = {
          ...emptyUsage(found.source),
          error: errMsg(e),
        }
      }
    }
  }

  // 3. Cookie 账号源
  for (const acc of state.cookieAccounts) {
    try {
      results[acc.id] = await fetchQuotaByCookie(acc.workspaceId, acc.cookie)
      results[acc.id].plan = acc.name
    } catch (e) {
      hadAnyFailure = true
      results[acc.id] = {
        ...emptyUsage(acc.name),
        error: errMsg(e),
      }
    }
  }

  if (hadAnyFailure) {
    consecutiveFailures++
  } else {
    consecutiveFailures = 0
  }

  state.lastUsage = results
  saveState()
  return results
}

// ─── 公开状态视图 ────────────────────────────────────────────────────────

function publicState() {
  return {
    apiKeys: state.apiKeys.map(({ id, label }) => ({ id, label })),
    localKeyFound: Boolean(discoverLocalApiKey()),
    canQueryQuota: state.apiKeys.length > 0 || Boolean(discoverLocalApiKey()) || state.cookieAccounts.length > 0,
    accounts: state.cookieAccounts.map(({ id, name, workspaceId }) => ({ id, name, workspaceId })),
    usage: state.lastUsage ?? {},
    serverTime: Date.now(),
  }
}

// ─── webServer 路由 ──────────────────────────────────────────────────────

function jsonOk(res: any, value: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true, value }))
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
  if (!origin) return true
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
        if (req.method === 'GET' && path === '/state') {
          jsonOk(res, publicState())
          return
        }
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

  // ── 定时自动刷新（带指数退避防 DDoS）──
  let refreshing = false
  let lastRan = 0

  const autoRefresh = async (): Promise<void> => {
    if (refreshing) return
    const hasCreds = state.apiKeys.length > 0 || Boolean(discoverLocalApiKey()) || state.cookieAccounts.length > 0
    if (!hasCreds) return

    // 退避计算：连续失败时放慢请求频率（30s -> 60s -> 120s -> 最大 5min）
    const currentInterval = Math.min(
      MAX_BACKOFF_INTERVAL_MS,
      BASE_REFRESH_INTERVAL_MS * Math.pow(2, Math.min(4, consecutiveFailures)),
    )
    if (Date.now() - lastRan < currentInterval) return

    refreshing = true
    lastRan = Date.now()
    try {
      await refreshAll()
    } catch { /* 保持静默 */ }
    finally { refreshing = false }
  }

  // 基础轮询滴答：每 10s 唤醒一次，结合退避动态判定是否需要拉取
  ctx.effect(() => ctx.setInterval(() => { void autoRefresh() }, 10000), 'ocgo-usage: auto-refresh timer')
  void autoRefresh()

  ctx.logger?.info?.('[ocgo-usage] ready — Go 用量面板已就绪')
}
