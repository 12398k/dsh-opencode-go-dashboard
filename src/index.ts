/**
 * @dsh-external/dsh-opencode-go-dashboard — 宿主端（OpenCode Go & Antigravity 双擎驱动）。
 *
 * 核心升级：
 * 1. 真实 Antigravity 配额协议：优先通过 `v1internal:retrieveUserQuotaSummary` 获取真实的 5h 滚动与 weekly 额度及重置时间。
 * 2. 账号精准归属：
 *    - qiyu (agy): cliproxy -> qiyu59370@gmail.com
 *    - wym (agy-cli): antigravity-cli -> 2539461824wym@gmail.com
 * 3. 供应商与模型智能映射 & 手动策略指定。
 */
import type { Context } from 'cordis'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
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
const SETTINGS_FILE = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'settings.yaml')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

// ─── Google / Antigravity OAuth 常量 ────────────────────────────────────────

/**
 * Antigravity（Google OAuth）客户端凭证从环境变量读取，源码内不保留任何明文密钥。
 * 取值优先级：`~/.dsh/.env` / 项目 `.env` / 进程环境（`dsh` 启动时按层合并）。
 */
const GOOGLE_CLIENT_ID = String(process.env.AGY_CLIENT_ID || '').trim()
const GOOGLE_CLIENT_SECRET = String(process.env.AGY_CLIENT_SECRET || '').trim()

/** OAuth 凭证缺失时的统一提示（自动续期与一键授权都需要它） */
const OAUTH_CREDENTIAL_HINT =
  '未配置 Antigravity OAuth 客户端凭证：请在 ~/.dsh/.env 中设置 AGY_CLIENT_ID 与 AGY_CLIENT_SECRET（可从本机 Antigravity CLI / cliproxy 的 OAuth 配置复制），保存后重启 dsh 生效'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json'
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]
const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]
const ANTIGRAVITY_UA = 'antigravity/1.23.2 windows/amd64'

// ─── 结构化类型定义 ───────────────────────────────────────────────────────

export interface UsageWindow {
  status?: 'ok' | 'rate-limited'
  usagePercent: number // 0~100 已使用百分比
  remainingPercent?: number // 0~100 剩余配额百分比
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

export interface DiscoveredKey {
  key: string
  source: string
}

// ── Antigravity 结构定义 ──

export interface AntigravityAccount {
  id: string
  email: string
  label: string
  refreshToken: string
  accessToken?: string
  expiresAt?: number
  projectId?: string
  source?: string
}

export interface AntigravityModelQuota {
  modelId: string
  displayName: string
  remainingFraction: number // 0~1
  remainingPercent: number // 0~100
  usagePercent: number // 0~100
  resetTime?: string
  isGemini: boolean
}

export interface AntigravityUsageResult {
  email: string
  label: string
  plan?: string
  rolling: UsageWindow | null // 5h 滚动综合窗口
  weekly: UsageWindow | null // 7d 每周综合窗口
  models: AntigravityModelQuota[]
  fetchedAt: string
  serverTime: number
  error?: string
}

// ── 显示路由策略 ──

/** 目标引擎（Antigravity 可附带账号提示） */
export type ProviderTarget = 'go' | 'antigravity' | 'antigravity:qiyu' | 'antigravity:wym'

/** 一条供应商正则匹配规则：按数组顺序匹配，首个命中的启用规则决定显示哪个额度 */
export interface ProviderRule {
  id: string
  /** 正则源码（不区分大小写），依次测试 provider/model、provider、model、模型显示名 */
  pattern: string
  target: ProviderTarget
  enabled: boolean
  note?: string
}

export interface DisplaySettings {
  mode: 'auto' | 'provider-rule' | 'force-go' | 'force-antigravity'
  activeAntigravityAccountId?: string
  /** 精确供应商 ID 绑定（优先级高于正则规则） */
  providerTargets: Record<string, ProviderTarget>
  /** 供应商正则匹配规则（优先级低于精确绑定，高于自动识别） */
  providerRules: ProviderRule[]
  geminiKeywords: string[]
}

export interface RecognizedModel {
  id: string
  name: string
  provider: string
  isGemini: boolean
}

export interface RecognizedProvider {
  id: string
  name: string
  modelCount: number
}

export interface OcgoState {
  apiKeys: ApiKeyEntry[]
  cookieAccounts: CookieAccount[]
  lastUsage: Record<string, UsageResult>
  antigravityAccounts: AntigravityAccount[]
  antigravityUsage: Record<string, AntigravityUsageResult>
  displaySettings: DisplaySettings
}

// ─── 状态持久化 ────────────────────────────────────────────────────────────

const MAX_PROVIDER_RULES = 60
const MAX_PATTERN_LENGTH = 200

/** 把任意输入规范化为受支持的目标引擎（兼容历史写法） */
export function normalizeProviderTarget(input: unknown): ProviderTarget | null {
  const raw = String(input ?? '').trim().toLowerCase()
  if (!raw) return null
  if (raw === 'go' || raw === 'opencode' || raw === 'opencode-go' || raw === 'opencode-go-native') return 'go'
  if (raw.includes('wym') || raw.includes('cli')) return 'antigravity:wym'
  if (raw.includes('qiyu')) return 'antigravity:qiyu'
  if (raw.startsWith('antigravity') || raw === 'agy') return 'antigravity'
  return null
}

function isValidRegexPattern(pattern: string): boolean {
  try { new RegExp(pattern, 'i'); return true } catch { return false }
}

/** 宽松清洗：丢弃非法正则 / 非法目标，补 id 与 enabled，限制条数 */
export function normalizeProviderRules(input: unknown): ProviderRule[] {
  if (!Array.isArray(input)) return []
  const out: ProviderRule[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const pattern = String((item as any).pattern ?? '').trim().slice(0, MAX_PATTERN_LENGTH)
    if (!pattern || !isValidRegexPattern(pattern)) continue
    const target = normalizeProviderTarget((item as any).target)
    if (!target) continue
    const rawId = String((item as any).id ?? '').trim()
    const note = String((item as any).note ?? '').trim().slice(0, 60)
    out.push({
      id: rawId ? rawId.slice(0, 64) : `rule-${randomUUID().slice(0, 8)}`,
      pattern,
      target,
      enabled: (item as any).enabled !== false,
      ...(note ? { note } : {}),
    })
    if (out.length >= MAX_PROVIDER_RULES) break
  }
  return out
}

/**
 * 内置默认正则规则（顺序即优先级）：
 * 1. opencode*（含 opencode-go-native 原生供应商）→ OpenCode Go
 * 2. agycli / antigravity-cli → Antigravity (wym)
 * 3. agy / antigravity / gemini → Antigravity (qiyu)
 */
export const DEFAULT_PROVIDER_RULES: ProviderRule[] = [
  { id: 'r-opencode', pattern: '^opencode|[-_/]opencode|opencode[-_.]?go$', target: 'go', enabled: true, note: 'OpenCode Go 系（含 opencode-go-native）' },
  { id: 'r-agycli', pattern: 'agy[-_.]?cli|antigravity[-_.]?cli|cli[-_.]?agy', target: 'antigravity:wym', enabled: true, note: 'Antigravity CLI（wym 账号）' },
  { id: 'r-agy', pattern: 'agy|antigravity|gemini|tab_flash', target: 'antigravity:qiyu', enabled: true, note: 'Antigravity / Gemini 系（qiyu 账号）' },
]

const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  mode: 'auto',
  providerTargets: {
    agy: 'antigravity:qiyu',
    antigravity: 'antigravity:qiyu',
    agycli: 'antigravity:wym',
    'agy-cli': 'antigravity:wym',
    opencode: 'go',
    'opencode-go': 'go',
    'opencode-go-native': 'go',
    nas: 'go',
    lmstudio: 'go',
  },
  providerRules: DEFAULT_PROVIDER_RULES,
  geminiKeywords: ['gemini', 'tab_flash', 'chat_2'],
}

/**
 * 曾被内置过、后来修正过的默认规则 pattern（按规则 id 记录）。
 * 只有当持久化的规则与旧默认值逐字相同时才静默升级，用户改过的一律不动。
 */
const SUPERSEDED_DEFAULT_PATTERNS: Record<string, string[]> = {
  'r-opencode': ['^opencode|/opencode|opencode[-_.]?go|opencode'],
}

function migrateSupersededDefaultRules(rules: ProviderRule[]): ProviderRule[] {
  return rules.map((rule) => {
    const superseded = SUPERSEDED_DEFAULT_PATTERNS[rule.id]
    if (!superseded || !superseded.includes(rule.pattern)) return rule
    const fresh = DEFAULT_PROVIDER_RULES.find((d) => d.id === rule.id)
    return fresh ? { ...rule, pattern: fresh.pattern, note: rule.note || fresh.note } : rule
  })
}

/**
 * 曾经内置过、后来细化的精确绑定默认值（key → 旧值列表）。
 * 只有当持久化值与旧默认值相同时才升级；用户手动改过的值一律保留。
 */
const SUPERSEDED_DEFAULT_TARGETS: Record<string, string[]> = {
  agy: ['antigravity'],
  antigravity: ['antigravity'],
  agycli: ['antigravity'],
  'agy-cli': ['antigravity'],
}

/** 归一化持久化的精确绑定表（丢弃非法目标值，并升级旧的模糊默认值） */
function normalizeProviderTargets(input: unknown): Record<string, ProviderTarget> {
  const out: Record<string, ProviderTarget> = { ...DEFAULT_DISPLAY_SETTINGS.providerTargets }
  if (!input || typeof input !== 'object') return out
  for (const [key, value] of Object.entries(input as AnyRecord)) {
    const id = String(key ?? '').trim()
    if (!id) continue
    const raw = String(value ?? '').trim().toLowerCase()
    const superseded = SUPERSEDED_DEFAULT_TARGETS[id]
    if (superseded && superseded.includes(raw)) {
      // 旧的「只说 antigravity、不区分账号」默认值 → 用新的精确默认值
      const fresh = DEFAULT_DISPLAY_SETTINGS.providerTargets[id]
      if (fresh) { out[id] = fresh; continue }
    }
    const target = normalizeProviderTarget(value)
    if (!target) continue
    out[id] = target
  }
  return out
}

function loadState(): OcgoState {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as any
      const apiKeys: ApiKeyEntry[] = Array.isArray(raw.apiKeys)
        ? raw.apiKeys.filter((k: any) => k && typeof k.key === 'string' && k.key.trim().startsWith('sk-'))
        : []
      if (apiKeys.length === 0 && typeof raw.apiKey === 'string' && raw.apiKey.trim().startsWith('sk-')) {
        apiKeys.push({ id: 'k1', label: 'Key 1', key: raw.apiKey.trim() })
      }

      // 规范化 Antigravity 账号 ID 与 Label：
      // qiyu (agy) 归属于 agy 供应商
      // wym (agy-cli) 归属于 agycli 供应商
      const antigravityAccounts: AntigravityAccount[] = []
      if (Array.isArray(raw.antigravityAccounts)) {
        for (const a of raw.antigravityAccounts) {
          if (!a || !a.refreshToken) continue
          if (a.email?.includes('qiyu') || a.id?.includes('qiyu')) {
            antigravityAccounts.push({
              ...a,
              id: 'agy:qiyu',
              label: 'qiyu (agy)',
              email: a.email || 'qiyu59370@gmail.com',
            })
          } else if (a.email?.includes('wym') || a.id?.includes('wym') || a.id?.includes('cli')) {
            antigravityAccounts.push({
              ...a,
              id: 'agycli:wym',
              label: 'wym (agy-cli)',
              email: a.email || '2539461824wym@gmail.com',
            })
          } else {
            antigravityAccounts.push(a)
          }
        }
      }

      return {
        apiKeys,
        cookieAccounts: Array.isArray(raw.cookieAccounts) ? raw.cookieAccounts : [],
        lastUsage: typeof raw.lastUsage === 'object' && raw.lastUsage !== null ? raw.lastUsage : {},
        antigravityAccounts,
        antigravityUsage: typeof raw.antigravityUsage === 'object' && raw.antigravityUsage !== null ? raw.antigravityUsage : {},
        displaySettings: raw.displaySettings && typeof raw.displaySettings === 'object'
          ? {
              ...DEFAULT_DISPLAY_SETTINGS,
              ...raw.displaySettings,
              providerTargets: normalizeProviderTargets(raw.displaySettings.providerTargets),
              providerRules: Array.isArray(raw.displaySettings.providerRules)
                ? migrateSupersededDefaultRules(normalizeProviderRules(raw.displaySettings.providerRules))
                : DEFAULT_PROVIDER_RULES,
              geminiKeywords: Array.isArray(raw.displaySettings.geminiKeywords) && raw.displaySettings.geminiKeywords.length > 0
                ? raw.displaySettings.geminiKeywords.map((k: any) => String(k)).filter(Boolean)
                : DEFAULT_DISPLAY_SETTINGS.geminiKeywords,
            }
          : DEFAULT_DISPLAY_SETTINGS,
      }
    }
  } catch { /* 容灾 */ }
  return {
    apiKeys: [],
    cookieAccounts: [],
    lastUsage: {},
    antigravityAccounts: [],
    antigravityUsage: {},
    displaySettings: DEFAULT_DISPLAY_SETTINGS,
  }
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
    } catch { /* 容灾 */ }
  }, 200)
}

// ─── 防御性网络请求 ───────────────────────────────────────────────────────

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

// ─── OpenCode Go 额度查询逻辑 ─────────────────────────────────────────────

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
    } catch { /* 忽略 */ }
  }
  return null
}

function sanitizeWindow(w: any): UsageWindow | null {
  if (!w || typeof w !== 'object') return null
  const percent = Number(w.percent ?? w.usagePercent)
  if (isNaN(percent)) return null
  const clamped = Math.min(100, Math.max(0, percent))
  return {
    status: w.status === 'rate-limited' ? 'rate-limited' : 'ok',
    usagePercent: clamped,
    remainingPercent: Math.max(0, 100 - clamped),
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
  } catch {
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
    const clamped = Math.min(100, Math.max(0, parsed.usagePercent))
    return {
      status: parsed.status === 'rate-limited' ? 'rate-limited' : 'ok',
      usagePercent: clamped,
      remainingPercent: Math.max(0, 100 - clamped),
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

// ─── Antigravity OAuth 与真实配额查询逻辑 ──────────────────────────────────

/** 自动发现系统中的 Antigravity 凭证（精准匹配用户账号与供应商） */
function discoverLocalAntigravityAccounts(): AntigravityAccount[] {
  const discovered: AntigravityAccount[] = []

  // 1. qiyu (agy): 对应供应商 agy，邮箱 qiyu59370@gmail.com
  const cliproxyDir = '/vol1/1000/机械内置/cliproxy/auths'
  if (existsSync(cliproxyDir)) {
    try {
      const files = readdirSync(cliproxyDir)
      for (const file of files) {
        if (file.startsWith('antigravity-') && file.endsWith('.json')) {
          try {
            const raw = JSON.parse(readFileSync(join(cliproxyDir, file), 'utf8'))
            if (raw.refresh_token || raw.access_token) {
              const id = 'agy:qiyu'
              const email = raw.email || 'qiyu59370@gmail.com'
              discovered.push({
                id,
                email,
                label: 'qiyu (agy)',
                refreshToken: raw.refresh_token || '',
                accessToken: raw.access_token,
                projectId: raw.project_id || 'aicode-consumers',
                source: 'agy (cliproxy)',
              })
            }
          } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }

  // 2. wym (agy-cli): 对应供应商 agycli，邮箱 2539461824wym@gmail.com
  const agyCliTokenPath = join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  if (existsSync(agyCliTokenPath)) {
    try {
      const raw = JSON.parse(readFileSync(agyCliTokenPath, 'utf8'))
      const tokenObj = raw.token || raw
      if (tokenObj.refresh_token || tokenObj.access_token) {
        const id = 'agycli:wym'
        discovered.push({
          id,
          email: '2539461824wym@gmail.com',
          label: 'wym (agy-cli)',
          refreshToken: tokenObj.refresh_token || '',
          accessToken: tokenObj.access_token,
          projectId: 'aicode-consumers',
          source: 'agycli (~/.gemini/antigravity-cli)',
        })
      }
    } catch { /* 忽略 */ }
  }

  return discovered
}

/** 刷新 Antigravity OAuth Token */
async function refreshAntigravityToken(acc: AntigravityAccount): Promise<string> {
  // 未配置客户端凭证时无法续期：未过期的 accessToken 仍可继续使用
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    if (acc.accessToken && (!acc.expiresAt || acc.expiresAt - Date.now() > 60_000)) return acc.accessToken
    throw new Error(OAUTH_CREDENTIAL_HINT)
  }
  if (!acc.refreshToken) {
    if (acc.accessToken) return acc.accessToken
    throw new Error('未配置 Refresh Token')
  }

  const params = new URLSearchParams()
  params.append('client_id', GOOGLE_CLIENT_ID)
  params.append('client_secret', GOOGLE_CLIENT_SECRET)
  params.append('grant_type', 'refresh_token')
  params.append('refresh_token', acc.refreshToken)

  const res = await safeFetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google OAuth 刷新失败 (HTTP ${res.status}): ${text.slice(0, 100)}`)
  }

  const data: any = await res.json()
  const accessToken = data.access_token
  if (!accessToken || typeof accessToken !== 'string') {
    throw new Error('Google OAuth 响应未包含有效的 access_token')
  }

  acc.accessToken = accessToken
  if (typeof data.expires_in === 'number') {
    acc.expiresAt = Date.now() + data.expires_in * 1000
  }
  saveState()
  return accessToken
}

function isGeminiModel(modelId: string, keywords: string[] = ['gemini', 'tab_flash', 'chat_2']): boolean {
  const lower = modelId.toLowerCase()
  return keywords.some((kw) => lower.includes(kw.toLowerCase()))
}

/** 核心：从 Google 官方 retrieveUserQuotaSummary 获取真实的 5h 滚动与 weekly 额度及重置时间 */
async function fetchAntigravityUserQuotaSummary(accessToken: string): Promise<{
  rollingRemainingFraction: number
  rollingResetTime?: string
  weeklyRemainingFraction: number
  weeklyResetTime?: string
  description?: string
} | null> {
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await safeFetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': ANTIGRAVITY_UA,
        },
        body: JSON.stringify({}),
      })

      if (res.ok) {
        const data: any = await res.json()
        const groups = Array.isArray(data?.groups) ? data.groups : []
        for (const g of groups) {
          const dName = String(g.displayName || '').toLowerCase()
          const desc = String(g.description || '').toLowerCase()
          if (dName.includes('gemini') || desc.includes('gemini')) {
            let fiveHourFrac: number | undefined
            let fiveHourReset: string | undefined
            let weeklyFrac: number | undefined
            let weeklyReset: string | undefined

            for (const b of g.buckets || []) {
              const w = String(b.window || b.bucketId || '').toLowerCase()
              if (w.includes('5h')) {
                fiveHourFrac = typeof b.remainingFraction === 'number' ? b.remainingFraction : undefined
                fiveHourReset = typeof b.resetTime === 'string' ? b.resetTime : undefined
              } else if (w.includes('weekly')) {
                weeklyFrac = typeof b.remainingFraction === 'number' ? b.remainingFraction : undefined
                weeklyReset = typeof b.resetTime === 'string' ? b.resetTime : undefined
              }
            }

            return {
              rollingRemainingFraction: fiveHourFrac ?? 1,
              rollingResetTime: fiveHourReset,
              weeklyRemainingFraction: weeklyFrac ?? 1,
              weeklyResetTime: weeklyReset,
              description: g.description,
            }
          }
        }
      }
    } catch { /* 换下一个端点重试 */ }
  }
  return null
}

/** 经由 Google CloudCode API 拉取 Antigravity 真实额度与各模型列表 */
async function fetchAntigravityQuotaDirect(acc: AntigravityAccount): Promise<AntigravityUsageResult> {
  const token = await refreshAntigravityToken(acc)

  // 1. 获取最真实权威的 5h 滚动与 weekly 额度
  const summary = await fetchAntigravityUserQuotaSummary(token)

  // 2. 获取具体模型的列表及配额
  let modelsMap: Record<string, any> = {}
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await safeFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': ANTIGRAVITY_UA,
        },
        body: JSON.stringify({ project: acc.projectId || 'aicode-consumers' }),
      })
      if (res.ok) {
        const data: any = await res.json()
        modelsMap = data?.models || {}
        break
      }
    } catch { /* 换下一个端点 */ }
  }

  const geminiModels: AntigravityModelQuota[] = []
  const keywords = state.displaySettings.geminiKeywords || ['gemini', 'tab_flash', 'chat_2']

  for (const [id, m] of Object.entries<any>(modelsMap)) {
    const isGemini = isGeminiModel(id, keywords)
    const q = m?.quotaInfo || {}
    const rem = typeof q.remainingFraction === 'number' ? Math.min(1, Math.max(0, q.remainingFraction)) : 1
    const remPct = Math.round(rem * 100)
    const reset = typeof q.resetTime === 'string' ? q.resetTime : undefined

    const item: AntigravityModelQuota = {
      modelId: id,
      displayName: m?.displayName || id,
      remainingFraction: rem,
      remainingPercent: remPct,
      usagePercent: Math.max(0, 100 - remPct),
      resetTime: reset,
      isGemini,
    }

    if (isGemini) {
      geminiModels.push(item)
    }
  }

  geminiModels.sort((a, b) => a.displayName.localeCompare(b.displayName))

  // 3. 计算 5h 与 weekly 的剩余百分比与用量百分比
  let rollingRemaining = summary?.rollingRemainingFraction ?? 1
  let rollingReset = summary?.rollingResetTime
  let weeklyRemaining = summary?.weeklyRemainingFraction ?? 1
  let weeklyReset = summary?.weeklyResetTime

  const rollingRemPct = Math.min(100, Math.max(0, Math.round(rollingRemaining * 100)))
  const weeklyRemPct = Math.min(100, Math.max(0, Math.round(weeklyRemaining * 100)))

  return {
    email: acc.email,
    label: acc.label || acc.email,
    plan: 'Google Antigravity',
    rolling: {
      status: rollingRemPct <= 1 ? 'rate-limited' : 'ok',
      usagePercent: Math.max(0, 100 - rollingRemPct),
      remainingPercent: rollingRemPct,
      resetsAt: rollingReset,
    },
    weekly: {
      status: weeklyRemPct <= 1 ? 'rate-limited' : 'ok',
      usagePercent: Math.max(0, 100 - weeklyRemPct),
      remainingPercent: weeklyRemPct,
      resetsAt: weeklyReset,
    },
    models: geminiModels,
    fetchedAt: new Date().toISOString(),
    serverTime: Date.now(),
  }
}

/** 容灾互通：从本地 dsh-agy-link 读取 */
async function fetchAntigravityQuotaFromAgyLink(): Promise<AntigravityUsageResult | null> {
  try {
    const res = await safeFetch('http://127.0.0.1:3080/plugins/agy-link/pool')
    if (!res.ok) return null
    const data: any = await res.json()
    const accounts = Array.isArray(data?.accounts) ? data.accounts : []
    const acc = accounts[0]
    if (!acc) return null

    const googleQuota = acc.quotas?.google
    const modelsList: AntigravityModelQuota[] = (googleQuota?.models || []).map((m: any) => {
      const rem = typeof m.remainingFraction === 'number' ? m.remainingFraction : 1
      const remPct = Math.round(rem * 100)
      return {
        modelId: m.modelId,
        displayName: m.displayName || m.modelId,
        remainingFraction: rem,
        remainingPercent: remPct,
        usagePercent: Math.max(0, 100 - remPct),
        resetTime: m.resetTime,
        isGemini: true,
      }
    })

    const rem5h = typeof googleQuota?.remainingFraction === 'number' ? googleQuota.remainingFraction : 1
    const remWeekly = typeof googleQuota?.weeklyFraction === 'number' ? googleQuota.weeklyFraction : 1
    const rem5hPct = Math.min(100, Math.max(0, Math.round(rem5h * 100)))
    const remWeeklyPct = Math.min(100, Math.max(0, Math.round(remWeekly * 100)))

    return {
      email: acc.email || 'wym (agy-cli)',
      label: 'wym (agy-cli)',
      plan: 'Antigravity (Link)',
      rolling: {
        status: rem5hPct <= 1 ? 'rate-limited' : 'ok',
        usagePercent: Math.max(0, 100 - rem5hPct),
        remainingPercent: rem5hPct,
        resetsAt: googleQuota?.resetTime,
      },
      weekly: {
        status: remWeeklyPct <= 1 ? 'rate-limited' : 'ok',
        usagePercent: Math.max(0, 100 - remWeeklyPct),
        remainingPercent: remWeeklyPct,
        resetsAt: googleQuota?.weeklyResetTime,
      },
      models: modelsList,
      fetchedAt: new Date().toISOString(),
      serverTime: Date.now(),
    }
  } catch {
    return null
  }
}

/** 刷新全部 Antigravity 账号额度 */
async function refreshAllAntigravity(): Promise<Record<string, AntigravityUsageResult>> {
  const results: Record<string, AntigravityUsageResult> = {}

  // 规范化账号列表：仅保留真实精准账号，去重并更新友好标签
  const discovered = discoverLocalAntigravityAccounts()
  
  // 过滤掉旧的临时 primary 账号
  state.antigravityAccounts = state.antigravityAccounts.filter((a) => a.id !== 'agy-cli:primary')
  if (state.antigravityUsage?.['agy-cli:primary']) {
    delete state.antigravityUsage['agy-cli:primary']
  }

  for (const disc of discovered) {
    const existing = state.antigravityAccounts.find((a) => a.email === disc.email || a.id === disc.id)
    if (!existing) {
      state.antigravityAccounts.push(disc)
    } else {
      existing.label = disc.label
      if (disc.refreshToken && !existing.refreshToken) existing.refreshToken = disc.refreshToken
    }
  }

  for (const acc of state.antigravityAccounts) {
    try {
      results[acc.id] = await fetchAntigravityQuotaDirect(acc)
    } catch (e) {
      const fallback = await fetchAntigravityQuotaFromAgyLink()
      if (fallback && acc.email.includes('wym')) {
        results[acc.id] = { ...fallback, label: acc.label, email: acc.email }
      } else {
        results[acc.id] = {
          email: acc.email,
          label: acc.label || acc.email,
          plan: 'Antigravity',
          rolling: null,
          weekly: null,
          models: [],
          fetchedAt: new Date().toISOString(),
          serverTime: Date.now(),
          error: errMsg(e),
        }
      }
    }
  }

  state.antigravityUsage = results
  saveState()
  return results
}

// ─── 模型与供应商系统识别 ──────────────────────────────────────────────────

function parseYamlSection(content: string, sectionKey: string): string[] {
  const lines = content.split(/\r?\n/)
  const result: string[] = []
  let inSection = false
  let sectionIndent = -1

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.search(/\S/)

    if (!inSection) {
      if (trimmed.startsWith(`${sectionKey}:`)) {
        inSection = true
        sectionIndent = indent
      }
    } else {
      if (indent <= sectionIndent && trimmed.includes(':')) {
        break
      }
      result.push(line)
    }
  }
  return result
}

function scanSystemProvidersAndModels(): {
  providers: RecognizedProvider[]
  models: RecognizedModel[]
  defaultModel: { provider: string; model: string } | null
} {
  const providersMap = new Map<string, { id: string; name: string; models: string[] }>()
  let defaultModel: { provider: string; model: string } | null = null

  providersMap.set('agy', { id: 'agy', name: 'Google Antigravity (agy · qiyu)', models: [] })
  providersMap.set('agycli', { id: 'agycli', name: 'Antigravity CLI (agycli · wym)', models: [] })
  providersMap.set('opencode', { id: 'opencode', name: 'OpenCode Go', models: [] })

  if (existsSync(SETTINGS_FILE)) {
    try {
      const content = readFileSync(SETTINGS_FILE, 'utf8')

      const admLines = parseYamlSection(content, 'agent-default-model')
      let dp = ''
      let dm = ''
      for (const l of admLines) {
        const mP = l.match(/provider:\s*([a-zA-Z0-9_-]+)/)
        if (mP) dp = mP[1].trim()
        const mM = l.match(/model:\s*([a-zA-Z0-9_./-]+)/)
        if (mM) dm = mM[1].trim()
      }
      if (dp && dm) defaultModel = { provider: dp, model: dm }

      const piLines = parseYamlSection(content, 'llm-pi-ai')
      let currentProvider = ''
      for (const line of piLines) {
        const pMatch = line.match(/^\s{2,4}([a-zA-Z0-9_-]+):/)
        if (pMatch && !['providers', 'apiKeyEnv', 'api', 'baseURL', 'models', 'compat'].includes(pMatch[1])) {
          currentProvider = pMatch[1].trim()
          if (!providersMap.has(currentProvider)) {
            providersMap.set(currentProvider, { id: currentProvider, name: currentProvider, models: [] })
          }
        }
        const mMatch = line.match(/-\s*id:\s*([a-zA-Z0-9_./-]+)/)
        if (mMatch && currentProvider) {
          const mid = mMatch[1].trim()
          const pObj = providersMap.get(currentProvider)
          if (pObj && !pObj.models.includes(mid)) pObj.models.push(mid)
        }
      }
    } catch { /* 容错 */ }
  }

  for (const u of Object.values(state.antigravityUsage)) {
    if (Array.isArray(u.models)) {
      const agyEntry = providersMap.get('agy')
      for (const m of u.models) {
        if (agyEntry && !agyEntry.models.includes(m.modelId)) {
          agyEntry.models.push(m.modelId)
        }
      }
    }
  }

  const keywords = state.displaySettings.geminiKeywords || ['gemini', 'tab_flash', 'chat_2']
  const modelsList: RecognizedModel[] = []
  const providersList: RecognizedProvider[] = []

  for (const [pid, entry] of providersMap.entries()) {
    providersList.push({
      id: pid,
      name: entry.name,
      modelCount: entry.models.length,
    })
    for (const mid of entry.models) {
      modelsList.push({
        id: mid,
        name: mid,
        provider: pid,
        isGemini: isGeminiModel(mid, keywords),
      })
    }
  }

  return {
    providers: providersList,
    models: modelsList,
    defaultModel,
  }
}

// ─── 刷新调度与退避控制 ──────────────────────────────────────────────────

let consecutiveFailures = 0

async function refreshAll(): Promise<Record<string, UsageResult>> {
  const results: Record<string, UsageResult> = {}
  let hadAnyFailure = false

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
  const systemInfo = scanSystemProvidersAndModels()
  const localAntigravity = discoverLocalAntigravityAccounts()

  return {
    apiKeys: state.apiKeys.map(({ id, label }) => ({ id, label })),
    localKeyFound: Boolean(discoverLocalApiKey()),
    canQueryQuota: state.apiKeys.length > 0 || Boolean(discoverLocalApiKey()) || state.cookieAccounts.length > 0,
    accounts: state.cookieAccounts.map(({ id, name, workspaceId }) => ({ id, name, workspaceId })),
    usage: state.lastUsage ?? {},

    antigravityAccounts: state.antigravityAccounts.map(({ id, email, label, source }) => ({ id, email, label, source })),
    discoveredAntigravityCount: localAntigravity.length,
    antigravityUsage: state.antigravityUsage ?? {},

    displaySettings: state.displaySettings,
    defaultDisplaySettings: {
      providerRules: DEFAULT_PROVIDER_RULES,
      providerTargets: DEFAULT_DISPLAY_SETTINGS.providerTargets,
    },
    providers: systemInfo.providers,
    models: systemInfo.models,
    defaultModel: systemInfo.defaultModel,

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
  ctx.logger?.info?.('[ocgo-usage] host starting with dual-engine (OpenCode Go & Antigravity)')

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

        if (req.method === 'POST' && path === '/settings/display') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          if (body.mode && ['auto', 'provider-rule', 'force-go', 'force-antigravity'].includes(body.mode)) {
            state.displaySettings.mode = body.mode
          }
          if (body.activeAntigravityAccountId) {
            state.displaySettings.activeAntigravityAccountId = String(body.activeAntigravityAccountId)
          }
          if (body.providerTargets && typeof body.providerTargets === 'object') {
            state.displaySettings.providerTargets = normalizeProviderTargets({
              ...state.displaySettings.providerTargets,
              ...body.providerTargets,
            })
          }
          if (Array.isArray(body.providerRules)) {
            state.displaySettings.providerRules = normalizeProviderRules(body.providerRules)
          }
          if (Array.isArray(body.geminiKeywords)) {
            state.displaySettings.geminiKeywords = body.geminiKeywords.map((k: any) => String(k).trim()).filter(Boolean)
          }
          saveState()
          jsonOk(res, state.displaySettings)
          return
        }

        // OpenCode Go 凭证
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

        // Antigravity 凭据管理
        if (req.method === 'POST' && path === '/antigravity/credentials') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const refreshToken = String(body.refreshToken ?? '').trim()
          if (!refreshToken) return jsonErr(res, '缺少 Refresh Token')

          const email = String(body.email ?? '').trim() || 'Google Account'
          const label = String(body.label ?? '').trim() || email
          const id = typeof body.id === 'string' && body.id ? body.id : randomUUID().slice(0, 8)

          const existing = state.antigravityAccounts.find((a) => a.id === id)
          if (existing) {
            existing.refreshToken = refreshToken
            existing.email = email
            existing.label = label
            if (body.projectId) existing.projectId = String(body.projectId).trim()
          } else {
            state.antigravityAccounts.push({
              id,
              email,
              label,
              refreshToken,
              projectId: String(body.projectId ?? 'aicode-consumers').trim(),
              source: 'manual',
            })
          }
          saveState()
          void refreshAllAntigravity()
          jsonOk(res, { accounts: state.antigravityAccounts.map(({ id: i, email: e, label: l }) => ({ id: i, email: e, label: l })) })
          return
        }
        if (req.method === 'POST' && path === '/antigravity/credentials/remove') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const body = await readBody(req)
          const before = state.antigravityAccounts.length
          state.antigravityAccounts = state.antigravityAccounts.filter((a) => a.id !== String(body.id ?? ''))
          delete state.antigravityUsage?.[String(body.id ?? '')]
          saveState()
          jsonOk(res, { removed: before - state.antigravityAccounts.length })
          return
        }
        if (req.method === 'POST' && path === '/antigravity/credentials/import-discovered') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          const discovered = discoverLocalAntigravityAccounts()
          let added = 0
          for (const item of discovered) {
            const existing = state.antigravityAccounts.find((a) => a.id === item.id || a.email === item.email)
            if (!existing) {
              state.antigravityAccounts.push(item)
              added++
            } else {
              existing.label = item.label
            }
          }
          saveState()
          void refreshAllAntigravity()
          jsonOk(res, { imported: added, total: state.antigravityAccounts.length })
          return
        }
        if (req.method === 'POST' && path === '/antigravity/refresh') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          jsonOk(res, await refreshAllAntigravity())
          return
        }

        // Google OAuth 辅助
        if (req.method === 'GET' && path === '/antigravity/oauth/auth-url') {
          if (!GOOGLE_CLIENT_ID) return jsonErr(res, OAUTH_CREDENTIAL_HINT, 400)
          const redirectUri = `${url.origin}${ROUTE_PREFIX}/antigravity/oauth/callback`
          const authUrl = `${GOOGLE_AUTH_ENDPOINT}?client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(GOOGLE_SCOPES.join(' '))}&access_type=offline&prompt=consent`
          jsonOk(res, { authUrl, clientId: GOOGLE_CLIENT_ID, redirectUri })
          return
        }
        if (req.method === 'POST' && path === '/antigravity/oauth/exchange') {
          if (!sameOrigin(req)) return jsonErr(res, 'cross-origin rejected', 403)
          if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return jsonErr(res, OAUTH_CREDENTIAL_HINT, 400)
          const body = await readBody(req)
          const code = String(body.code ?? '').trim()
          const redirectUri = String(body.redirectUri ?? `${url.origin}${ROUTE_PREFIX}/antigravity/oauth/callback`).trim()
          if (!code) return jsonErr(res, '缺少授权码 (code)')

          const params = new URLSearchParams()
          params.append('code', code)
          params.append('client_id', GOOGLE_CLIENT_ID)
          params.append('client_secret', GOOGLE_CLIENT_SECRET)
          params.append('redirect_uri', redirectUri)
          params.append('grant_type', 'authorization_code')

          const tokenRes = await safeFetch(GOOGLE_TOKEN_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
          })
          if (!tokenRes.ok) {
            const errText = await tokenRes.text()
            return jsonErr(res, `OAuth 兑换失败: ${errText.slice(0, 150)}`, 400)
          }
          const tokenData: any = await tokenRes.json()

          let email = 'Google Account'
          try {
            const userRes = await safeFetch(GOOGLE_USERINFO_ENDPOINT, {
              headers: { Authorization: `Bearer ${tokenData.access_token}` },
            })
            if (userRes.ok) {
              const uInfo: any = await userRes.json()
              if (uInfo.email) email = uInfo.email
            }
          } catch { /* 容错 */ }

          const id = randomUUID().slice(0, 8)
          state.antigravityAccounts.push({
            id,
            email,
            label: email,
            refreshToken: tokenData.refresh_token || '',
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
            projectId: 'aicode-consumers',
            source: 'oauth-web',
          })
          saveState()
          void refreshAllAntigravity()
          jsonOk(res, { email, id })
          return
        }

        jsonErr(res, 'not found', 404)
      } catch (e) {
        jsonErr(res, errMsg(e), 500)
      }
    },
  })

  ctx.effect(() => disposeRoutes, 'ocgo-usage: routes')

  // 定时自动刷新（双引擎）
  let refreshing = false
  let lastRan = 0

  const autoRefresh = async (): Promise<void> => {
    if (refreshing) return
    const hasCreds = state.apiKeys.length > 0 ||
      Boolean(discoverLocalApiKey()) ||
      state.cookieAccounts.length > 0 ||
      state.antigravityAccounts.length > 0 ||
      discoverLocalAntigravityAccounts().length > 0
    if (!hasCreds) return

    const currentInterval = Math.min(
      MAX_BACKOFF_INTERVAL_MS,
      BASE_REFRESH_INTERVAL_MS * Math.pow(2, Math.min(4, consecutiveFailures)),
    )
    if (Date.now() - lastRan < currentInterval) return

    refreshing = true
    lastRan = Date.now()
    try {
      await Promise.allSettled([
        refreshAll(),
        refreshAllAntigravity(),
      ])
    } catch { /* 容错 */ }
    finally { refreshing = false }
  }

  ctx.effect(() => ctx.setInterval(() => { void autoRefresh() }, 10000), 'ocgo-usage: auto-refresh timer')
  void autoRefresh()

  ctx.logger?.info?.('[ocgo-usage] ready — OpenCode Go & Antigravity (Gemini) 双擎就绪')
}
