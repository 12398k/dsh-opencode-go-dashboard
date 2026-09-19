/**
 * @dsh-external/dsh-opencode-go-dashboard — Client 渲染端（OpenCode Go & Antigravity 双擎驱动）。
 *
 * 核心升级：
 * 1. 解决浮窗交互：点击胶囊展开常驻面板（Click-outside 关闭），内部按钮均可从容点击操作。
 * 2. 真实剩余配额与重置倒计时显示：Antigravity 显示真实权威的剩余配额百分比（如 80% 剩余）与精确倒计时。
 * 3. 账号精准归属与切换：清晰标识 qiyu (agy) 与 wym (agy-cli)，支持一键点选切换当前账号。
 * 4. 智能自适应路由与手动供应商映射策略。
 */
import React from 'react'

type AnyRecord = Record<string, any>

const ROUTE = '/api/dsh-ocgo-usage'

type ClientContext = {
  slots: any
  effect(fn: () => () => void, label?: string): void
  /** cordis 服务查询（用于惰性读取 modelDirectories，无需声明 inject） */
  get?: (name: string, strict?: boolean) => any
}

export const inject = ['slots']

// ─── 本地时钟校准状态 ───────────────────────────────────────────────────

let clientServerSkewMs = 0

function updateClockSkew(serverTime?: number): void {
  if (typeof serverTime === 'number' && serverTime > 0) {
    clientServerSkewMs = Date.now() - serverTime
  }
}

function getSyncedNow(): number {
  return Date.now() - clientServerSkewMs
}

// ─── HTTP 封装 ──────────────────────────────────────────────────────────

async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${ROUTE}${path}`, { credentials: 'same-origin' })
  const envelope: any = await res.json().catch(() => null)
  if (!res.ok || !envelope || !envelope.ok) {
    throw new Error(envelope?.error?.message ?? `HTTP ${res.status}`)
  }
  if (envelope.value?.serverTime) {
    updateClockSkew(envelope.value.serverTime)
  }
  return envelope.value
}

async function apiPost(path: string, body?: AnyRecord): Promise<any> {
  const res = await fetch(`${ROUTE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const envelope: any = await res.json().catch(() => null)
  if (!res.ok || !envelope || !envelope.ok) {
    throw new Error(envelope?.error?.message ?? `HTTP ${res.status}`)
  }
  return envelope.value
}

// ─── 样式系统 ────────────────────────────────────────────────────────────

const card: AnyRecord = {
  display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px',
  border: '1px solid rgba(128,128,128,.22)', borderRadius: '10px',
  background: 'rgba(128,128,128,.06)',
}
const row: AnyRecord = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
const input: AnyRecord = {
  background: 'rgba(128,128,128,.14)', color: 'inherit',
  border: '1px solid rgba(128,128,128,.3)', borderRadius: '6px',
  padding: '5px 8px', fontSize: '12px', outline: 'none', width: '100%',
  boxSizing: 'border-box', fontFamily: 'monospace',
}
const selectStyle: AnyRecord = {
  background: 'rgba(128,128,128,.18)', color: 'inherit',
  border: '1px solid rgba(128,128,128,.35)', borderRadius: '6px',
  padding: '4px 8px', fontSize: '12px', outline: 'none', cursor: 'pointer',
}
const btn: AnyRecord = {
  cursor: 'pointer', padding: '5px 12px', fontSize: '12px',
  border: '1px solid rgba(128,128,128,.35)', borderRadius: '6px',
  background: 'transparent', color: 'inherit',
}
const btnPrimary: AnyRecord = { ...btn, background: 'rgba(99,102,241,.25)', borderColor: 'rgba(99,102,241,.5)' }
const btnDanger: AnyRecord = { ...btn, color: '#e5697a', borderColor: 'rgba(229,105,122,.4)' }
const muted: AnyRecord = { opacity: 0.65, fontSize: '12px' }
const errText: AnyRecord = { color: '#e5697a', fontSize: '12px', wordBreak: 'break-all' }
const okText: AnyRecord = { color: '#59b978', fontSize: '12px' }

// ─── 防御性工具函数 ──────────────────────────────────────────────────────

function shortErr(e: unknown): string {
  if (!e) return '未知错误'
  const msg = (e as any)?.message ?? String(e)
  return msg.slice(0, 160)
}

function fmtReset(w: AnyRecord | null, fetchedAt?: string): string {
  if (!w || typeof w !== 'object') return ''
  let remainingMs: number | null = null

  if (typeof w.resetsAt === 'string') {
    const target = Date.parse(w.resetsAt)
    if (!Number.isNaN(target)) {
      remainingMs = target - getSyncedNow()
    }
  }

  if (remainingMs === null && typeof w.resetInSec === 'number') {
    const fetchTime = fetchedAt ? Date.parse(fetchedAt) : getSyncedNow()
    const elapsed = Number.isNaN(fetchTime) ? 0 : Math.max(0, getSyncedNow() - fetchTime)
    remainingMs = w.resetInSec * 1000 - elapsed
  }

  if (remainingMs === null) return ''
  if (remainingMs <= 0) return '即将重置'

  const totalMin = Math.floor(remainingMs / 60000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60

  const parts: string[] = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

function pctColor(p: number): string {
  if (p >= 90) return 'var(--dsw-alias-state-error-primary, #e5697a)'
  if (p >= 70) return 'var(--dsw-alias-state-warn-label, #e0a34a)'
  return 'var(--dsw-alias-state-success-primary, #59b978)'
}

function remainingColor(rem: number): string {
  if (rem <= 15) return 'var(--dsw-alias-state-error-primary, #e5697a)'
  if (rem <= 40) return 'var(--dsw-alias-state-warn-label, #e0a34a)'
  return '#818cf8' // 充足时紫色
}

// ─── 供应商正则匹配与活跃模型探测 ────────────────────────────────────────

type ProviderTarget = 'go' | 'antigravity' | 'antigravity:qiyu' | 'antigravity:wym'
type ActiveEngine = 'go' | 'antigravity'

interface ProviderRule {
  id: string
  pattern: string
  target: ProviderTarget
  enabled: boolean
  note?: string
}

interface DetectedModel {
  /** 模型 id 或显示名（已去掉 "· 推理等级" 后缀） */
  model: string
  /** 仅当文案里带 `provider/model` 形式时才有值 */
  provider: string
  /** 原始文案 */
  raw: string
}

interface RouteDecision {
  engine: ActiveEngine
  agyHint: '' | 'qiyu' | 'wym'
  /** 为什么这么判定（用于界面提示与排错） */
  reason: string
  /** 命中的样例字符串 */
  hit?: string
}

const FALLBACK_GEMINI_KEYWORDS = ['gemini', 'tab_flash', 'chat_2']
const ANTIGRAVITY_PROVIDER_IDS = ['agy', 'agycli', 'agy-cli', 'antigravity', 'antigravity-cli']

function detectCurrentModelFromDom(): DetectedModel | null {
  try {
    const triggers = document.querySelectorAll('button[aria-label*="选择模型"], button[title*="·"]')
    for (const btnEl of Array.from(triggers)) {
      const aria = btnEl.getAttribute('aria-label') || ''
      const title = btnEl.getAttribute('title') || ''
      const ariaCurrent = aria.includes('当前') ? aria.slice(aria.indexOf('当前') + 2) : ''
      const raw = (ariaCurrent || title || aria).trim()
      if (!raw) continue
      // 去掉 " · 推理等级" / "，推理等级 x" 之类的尾巴
      const cleaned = raw.split('·')[0].split('，')[0].split(',')[0].trim()
      if (!cleaned) continue
      let provider = ''
      let model = cleaned
      if (cleaned.includes('/')) {
        const parts = cleaned.split('/')
        provider = (parts.shift() || '').trim()
        model = parts.join('/').trim()
      }
      return { model, provider, raw }
    }
  } catch { /* 容错 */ }
  return null
}

/** 通过宿主扫描出的模型清单把「模型显示名」反查成 provider id */
export function resolveProviderFromCatalog(modelStr: string, models: AnyRecord[]): string {
  const needle = String(modelStr ?? '').trim().toLowerCase()
  if (!needle || !Array.isArray(models)) return ''
  const flat = models.filter((m) => m && typeof m === 'object')
  const exact = (m: AnyRecord): boolean => {
    const id = String(m.id ?? '').toLowerCase()
    const nm = String(m.name ?? '').toLowerCase()
    const pid = String(m.provider ?? '').toLowerCase()
    return needle === id || needle === nm || (pid !== '' && needle === `${pid}/${id}`) || (pid !== '' && needle === `${pid}/${nm}`)
  }
  const loose = (m: AnyRecord): boolean => {
    const id = String(m.id ?? '').toLowerCase()
    const nm = String(m.name ?? '').toLowerCase()
    if (id.length < 3 || !needle.includes(id)) {
      if (nm.length < 3 || !needle.includes(nm)) return false
    }
    return true
  }
  for (const m of flat) if (exact(m)) return String(m.provider ?? '')
  for (const m of flat) if (loose(m)) return String(m.provider ?? '')
  return ''
}

/** 规则测试用的候选字符串（顺序即优先级） */
export function buildRuleCandidates(input: {
  provider?: string
  model?: string
  modelName?: string
  defaultProvider?: string
  defaultModel?: string
}): string[] {
  const out: string[] = []
  const push = (v?: string): void => {
    const s = String(v ?? '').trim()
    if (s && !out.includes(s)) out.push(s)
  }
  const provider = String(input.provider ?? '').trim()
  const model = String(input.model ?? '').trim()
  if (provider && model) push(`${provider}/${model}`)
  push(provider)
  push(model)
  push(input.modelName)
  const dp = String(input.defaultProvider ?? '').trim()
  const dm = String(input.defaultModel ?? '').trim()
  if (dp && dm) push(`${dp}/${dm}`)
  push(dp)
  push(dm)
  return out
}

function compileRule(pattern: string): RegExp | null {
  try { return new RegExp(pattern, 'i') } catch { return null }
}

export function matchProviderRule(
  rules: ProviderRule[],
  candidates: string[],
): { rule: ProviderRule; hit: string } | null {
  if (!Array.isArray(rules)) return null
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    const pattern = String(rule.pattern ?? '').trim()
    if (!pattern) continue
    const re = compileRule(pattern)
    if (!re) continue
    for (const candidate of candidates) {
      if (re.test(candidate)) return { rule, hit: candidate }
    }
  }
  return null
}

/**
 * 客户端内置默认规则（与宿主 src/index.ts 的 DEFAULT_PROVIDER_RULES 保持一致）：
 * 仅在宿主未下发 defaultDisplaySettings 时作为「恢复默认规则」的兜底。
 */
export const DEFAULT_PROVIDER_RULES: ProviderRule[] = [
  { id: 'r-opencode', pattern: '^opencode|[-_/]opencode|opencode[-_.]?go$', target: 'go', enabled: true, note: 'OpenCode Go 系（含 opencode-go-native）' },
  { id: 'r-agycli', pattern: 'agy[-_.]?cli|antigravity[-_.]?cli|cli[-_.]?agy', target: 'antigravity:wym', enabled: true, note: 'Antigravity CLI（wym 账号）' },
  { id: 'r-agy', pattern: 'agy|antigravity|gemini|tab_flash', target: 'antigravity:qiyu', enabled: true, note: 'Antigravity / Gemini 系（qiyu 账号）' },
]

const TARGET_OPTIONS: Array<{ value: ProviderTarget; label: string }> = [
  { value: 'go', label: '⚡ 显示 OpenCode Go 用量' },
  { value: 'antigravity:qiyu', label: '🪐 Antigravity (qiyu · agy)' },
  { value: 'antigravity:wym', label: '🪐 Antigravity (wym · agycli)' },
  { value: 'antigravity', label: '🪐 Antigravity (默认账号)' },
]

let ruleSeq = 0

function createRule(partial?: Partial<ProviderRule>): ProviderRule {
  ruleSeq += 1
  return {
    id: `rule-${Date.now().toString(36)}-${ruleSeq}`,
    pattern: '',
    target: 'go',
    enabled: true,
    ...(partial || {}),
  }
}

/** 校验规则列表，返回第一条错误描述（无错误返回空串） */
export function validateRules(rules: ProviderRule[]): string {
  if (!Array.isArray(rules)) return ''
  for (let i = 0; i < rules.length; i += 1) {
    const pattern = String(rules[i]?.pattern ?? '').trim()
    if (!pattern) return `第 ${i + 1} 条规则的正则不能为空（可先删除该条）`
    if (!compileRule(pattern)) return `第 ${i + 1} 条规则的正则语法无效：${pattern}`
  }
  return ''
}

function decisionOf(target: string, reason: string, hit?: string): RouteDecision {
  const value = String(target ?? '').trim().toLowerCase()
  if (value.startsWith('antigravity')) {
    return { engine: 'antigravity', agyHint: value.includes('wym') || value.includes('cli') ? 'wym' : 'qiyu', reason, hit }
  }
  return { engine: 'go', agyHint: '', reason, hit }
}

/**
 * 解析当前应该显示哪个额度：
 * 手动切换 > 固定模式 > 精确供应商绑定 > 供应商正则规则 > 自动识别（Gemini 关键词）。
 */
export function resolveRoute(opts: {
  mode: string
  manualTarget: ActiveEngine | null
  provider: string
  model: string
  modelName: string
  providerTargets: AnyRecord
  providerRules: ProviderRule[]
  geminiKeywords: string[]
  defaultProvider: string
  defaultModel: string
}): RouteDecision {
  if (opts.manualTarget) return decisionOf(opts.manualTarget, '手动切换')
  if (opts.mode === 'force-go') return decisionOf('go', '固定显示 OpenCode Go')
  if (opts.mode === 'force-antigravity') return decisionOf('antigravity', '固定显示 Antigravity')

  const provider = String(opts.provider ?? '').trim()
  const targets = opts.providerTargets && typeof opts.providerTargets === 'object' ? opts.providerTargets : {}
  if (provider) {
    const key = Object.keys(targets).find((k) => String(k).toLowerCase() === provider.toLowerCase())
    if (key) {
      const target = String((targets as AnyRecord)[key] ?? '')
      if (target) return decisionOf(target, `精确绑定 ${key}`, provider)
    }
  }

  // 候选串分两组：真实选中的数据优先，配置默认值只在真实信息缺席时兜底。
  // （否则「配置默认 = opencode-go-native」会把选中 agy/agycli 的场景误判成 Go）
  const liveCandidates = buildRuleCandidates({
    provider,
    model: opts.model,
    modelName: opts.modelName,
  })
  const fallbackCandidates = buildRuleCandidates({
    provider: opts.defaultProvider,
    model: opts.defaultModel,
  })
  const matched = matchProviderRule(opts.providerRules || [], liveCandidates)
    ?? matchProviderRule(opts.providerRules || [], fallbackCandidates)
  if (matched) {
    const label = matched.rule.note ? `${matched.rule.pattern}（${matched.rule.note}）` : matched.rule.pattern
    return decisionOf(matched.rule.target, `正则匹配 ${label}`, matched.hit)
  }

  const keywords = Array.isArray(opts.geminiKeywords) && opts.geminiKeywords.length > 0
    ? opts.geminiKeywords
    : FALLBACK_GEMINI_KEYWORDS
  const modelBlob = `${opts.model ?? ''} ${opts.modelName ?? ''}`.toLowerCase()
  const providerLower = provider.toLowerCase()
  const looksGemini = keywords.some((k) => {
    const kw = String(k ?? '').trim().toLowerCase()
    return kw !== '' && modelBlob.includes(kw)
  }) || ANTIGRAVITY_PROVIDER_IDS.includes(providerLower)

  if (looksGemini) {
    return decisionOf(providerLower.includes('cli') ? 'antigravity:wym' : 'antigravity:qiyu', '自动识别 Gemini / Antigravity')
  }
  return decisionOf('go', '自动识别 非 Gemini → OpenCode Go')
}

/** 读取 `ctx.modelDirectories`（模型选择服务）里当前会话的真实选择 */
function readDirectorySelection(store: any): { provider: string; model: string } | null {
  try {
    const snapshot = typeof store?.getSnapshot === 'function' ? store.getSnapshot() : null
    const current = snapshot?.current
    if (current && typeof current === 'object') {
      return { provider: String(current.provider ?? ''), model: String(current.model ?? '') }
    }
  } catch { /* 容错 */ }
  return null
}

function useLiveModelSelection(store: any): { provider: string; model: string } | null {
  const [selection, setSelection] = React.useState(() => readDirectorySelection(store))
  React.useEffect(() => {
    if (!store || typeof store.subscribe !== 'function') {
      setSelection(null)
      return
    }
    setSelection(readDirectorySelection(store))
    let alive = true
    let unsubscribe: any = null
    try {
      unsubscribe = store.subscribe(() => {
        if (alive) setSelection(readDirectorySelection(store))
      })
    } catch { /* 容错 */ }
    return () => {
      alive = false
      try { unsubscribe?.() } catch { /* 容错 */ }
    }
  }, [store])
  return selection
}

/** 客户端上下文（apply 时写入），用于惰性取 modelDirectories 服务 */
let clientContext: any = null

function resolveModelStore(sessionId: string): any {
  try {
    if (!clientContext || !sessionId) return null
    const service = typeof clientContext.get === 'function' ? clientContext.get('modelDirectories') : null
    const directory = service?.directoryFor?.(sessionId)
    return directory?.store ?? null
  } catch { /* 服务缺失时退回 DOM 探测 */ }
  return null
}

// ─── 组件：用量/配额进度行 ────────────────────────────────────────────────

function UsageRow(props: {
  label: string
  window: AnyRecord | null
  fetchedAt?: string
}): any {
  const h = React.createElement
  const w = props.window
  if (!w || typeof w !== 'object') {
    return h('div', { style: row },
      h('span', { style: { ...muted, width: 72 } }, props.label),
      h('span', { style: muted }, '—'),
    )
  }

  const used = typeof w.usagePercent === 'number' ? Math.min(100, Math.max(0, Math.round(w.usagePercent))) : 0
  const reset = fmtReset(w, props.fetchedAt)
  const color = pctColor(used)

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' } },
      h('span', { style: { color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.7))', fontWeight: 500 } }, props.label),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { color, fontWeight: 600 } }, `${used}%`),
        reset ? h('span', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45))', fontSize: '11px' } }, `(in ${reset})`) : null,
      ),
    ),
    h('div', {
      style: {
        height: '4px', borderRadius: '999px', overflow: 'hidden',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2))',
      },
    },
      h('div', {
        style: {
          width: `${used}%`, height: '100%', transition: 'width .3s ease',
          background: color,
          borderRadius: '999px',
        },
      }),
    ),
  )
}

function UsageCard(props: { title: string; usage: AnyRecord | null }): any {
  const h = React.createElement
  const u = props.usage
  return h('div', { style: { ...card, gap: '8px' } },
    h('div', { style: row },
      h('strong', { style: { fontSize: '13px' } }, props.title),
      u?.plan ? h('span', { style: muted }, String(u.plan)) : null,
    ),
    h(UsageRow, { label: '5h 滚动', window: u?.rolling ?? null, fetchedAt: u?.fetchedAt }),
    h(UsageRow, { label: '7d 每周', window: u?.weekly ?? null, fetchedAt: u?.fetchedAt }),
    h(UsageRow, { label: '30d 每月', window: u?.monthly ?? null, fetchedAt: u?.fetchedAt }),
    u?.error ? h('div', { style: errText }, String(u.error)) : null,
    u?.fetchedAt
      ? h('div', { style: { ...muted, fontSize: '11px' } }, `更新于 ${new Date(u.fetchedAt).toLocaleString()}`)
      : null,
  )
}

function AntigravityCard(props: { accountKey: string; usage: AnyRecord | null }): any {
  const h = React.createElement
  const u = props.usage
  const models = Array.isArray(u?.models) ? u.models : []

  return h('div', { style: { ...card, gap: '8px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
      h('div', { style: row },
        h('strong', { style: { fontSize: '13px', color: '#818cf8' } }, `🪐 ${u?.label || u?.email || 'Google 账号'}`),
        h('span', { style: { fontSize: '11px', color: '#818cf8', background: 'rgba(99,102,241,0.15)', padding: '1px 6px', borderRadius: '4px' } }, 'Gemini'),
      ),
      u?.fetchedAt
        ? h('span', { style: { ...muted, fontSize: '11px' } }, new Date(u.fetchedAt).toLocaleTimeString())
        : null,
    ),

    h(UsageRow, { label: '5h 滚动', window: u?.rolling ?? null, fetchedAt: u?.fetchedAt }),
    h(UsageRow, { label: '7d 每周', window: u?.weekly ?? null, fetchedAt: u?.fetchedAt }),

    models.length > 0
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
          h('div', { style: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-caption)' } }, 'Gemini 系列模型当前用量明细：'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '6px' } },
            models.map((m: any) => {
              const used = typeof m.usagePercent === 'number' ? m.usagePercent : 0
              const reset = m.resetTime ? fmtReset({ resetsAt: m.resetTime }) : ''
              return h('div', {
                key: m.modelId,
                style: {
                  padding: '6px 8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)',
                  fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '3px',
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' } }, m.displayName || m.modelId),
                  h('span', { style: { color: pctColor(used), fontWeight: 600 } }, `${used}%`),
                ),
                reset ? h('div', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' } }, `重置: ${reset}`) : null,
              )
            }),
          ),
        )
      : null,

    u?.error ? h('div', { style: errText }, String(u.error)) : null,
  )
}

// ─── 组件：底栏圆环 (conversation.input.right) ────────────────────────────

function CircularProgress({ percent, size = 14, strokeWidth = 2, colorOverride }: { percent: number; size?: number; strokeWidth?: number; colorOverride?: string }): any {
  const h = React.createElement
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const validPct = Math.min(100, Math.max(0, percent))
  const strokeDashoffset = circumference - (validPct / 100) * circumference
  const color = colorOverride || pctColor(validPct)

  return h('svg', {
    width: size,
    height: size,
    viewBox: `0 0 ${size} ${size}`,
    style: { transform: 'rotate(-90deg)', display: 'block', flexShrink: 0 },
    'aria-hidden': 'true',
  },
    h('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: 'var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25))',
      strokeWidth,
    }),
    h('circle', {
      cx: size / 2,
      cy: size / 2,
      r: radius,
      fill: 'none',
      stroke: color,
      strokeWidth,
      strokeDasharray: circumference,
      strokeDashoffset,
      strokeLinecap: 'round',
      style: { transition: 'stroke-dashoffset 0.4s ease, stroke 0.3s ease' },
    }),
  )
}

export function ComposerGoQuota(props: { modelStore?: any }): any {
  const h = React.createElement
  const useStateShim = React.useState as any
  const [view, setView] = useStateShim(null as AnyRecord | null)
  const [isOpen, setIsOpen] = useStateShim(false)
  const [refreshing, setRefreshing] = useStateShim(false)
  const [manualTarget, setManualTarget] = useStateShim(null as 'go' | 'antigravity' | null)
  const [activeAgyAccountId, setActiveAgyAccountId] = useStateShim('')
  const [, setTick] = useStateShim(0)
  const containerRef = React.useRef(null as HTMLDivElement | null)

  const load = React.useCallback(async () => {
    try {
      const v = await apiGet('/state')
      setView(v)
    } catch { /* 容错 */ }
  }, [])

  // 节能定时器
  React.useEffect(() => {
    let intervalId: any = null
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        if (!intervalId) {
          intervalId = setInterval(() => {
            if (document.visibilityState === 'visible') void load()
          }, 30000)
        }
      } else {
        if (intervalId) {
          clearInterval(intervalId)
          intervalId = null
        }
      }
    }
    handleVisibility()
    document.addEventListener('visibilitychange', handleVisibility)
    const tickTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        setTick((t: number) => t + 1)
      }
    }, 30000)
    return () => {
      if (intervalId) clearInterval(intervalId)
      clearInterval(tickTimer)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [load])

  // Click-Outside 监听：点击容器外部时关闭浮窗
  React.useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  // ── 智能感知当前应该展示 Go 还是 Antigravity ──
  // 优先使用 DSH 模型选择服务的真实选择（provider/model），
  // 其次是 DOM 探测到的模型名（反查 provider），最后才是配置默认值。
  const liveSelection = useLiveModelSelection(props?.modelStore ?? null)
  const displaySettings = view?.displaySettings || {}
  const mode = displaySettings.mode || 'auto'
  const providerTargets = displaySettings.providerTargets || {}
  const providerRules = (displaySettings.providerRules || []) as ProviderRule[]
  const geminiKeywords = Array.isArray(displaySettings.geminiKeywords) && displaySettings.geminiKeywords.length > 0
    ? displaySettings.geminiKeywords
    : FALLBACK_GEMINI_KEYWORDS
  const detectedFromDom = detectCurrentModelFromDom()
  const defaultProvider = String(view?.defaultModel?.provider ?? '')
  const defaultModel = String(view?.defaultModel?.model ?? '')
  const domProvider = detectedFromDom?.provider
    || resolveProviderFromCatalog(detectedFromDom?.model ?? '', view?.models ?? [])
  const activeProvider = String(liveSelection?.provider || domProvider || defaultProvider || '')
  const activeModelName = String(detectedFromDom?.model ?? '')
  const activeModelStr = String(liveSelection?.model || activeModelName || defaultModel || '')

  const modelBlob = `${activeModelStr} ${activeModelName}`.toLowerCase()
  const isGeminiDetected = geminiKeywords.some((k: any) => {
    const kw = String(k ?? '').trim().toLowerCase()
    return kw !== '' && modelBlob.includes(kw)
  }) || ANTIGRAVITY_PROVIDER_IDS.includes(activeProvider.toLowerCase())

  const route = resolveRoute({
    mode,
    manualTarget,
    provider: activeProvider,
    model: activeModelStr,
    modelName: activeModelName,
    providerTargets,
    providerRules,
    geminiKeywords,
    defaultProvider,
    defaultModel,
  })
  const activeEngine: 'go' | 'antigravity' = route.engine
  const targetAgyAccountHint = route.agyHint

  // ── 准备数据 ──
  const goUsageMap: Record<string, AnyRecord> = view?.usage ?? {}
  const agyUsageMap: Record<string, AnyRecord> = view?.antigravityUsage ?? {}
  const agyAccountKeys = Object.keys(agyUsageMap)

  // 供应商与账号精准对应：
  // agy -> qiyu (agy)
  // agycli -> wym (agy-cli)
  let defaultAgyKey = ''
  if (targetAgyAccountHint === 'wym' || activeProvider === 'agycli' || activeProvider === 'agy-cli') {
    defaultAgyKey = agyAccountKeys.find((k) => k.includes('wym')) || ''
  } else if (targetAgyAccountHint === 'qiyu' || activeProvider === 'agy' || activeProvider === 'antigravity') {
    defaultAgyKey = agyAccountKeys.find((k) => k.includes('qiyu')) || ''
  }
  if (!defaultAgyKey) {
    defaultAgyKey = agyAccountKeys.find((k) => k.includes('qiyu')) || agyAccountKeys[0] || ''
  }

  const currentAgyKey = activeAgyAccountId && agyUsageMap[activeAgyAccountId]
    ? activeAgyAccountId
    : defaultAgyKey

  const currentAgyUsage = agyUsageMap[currentAgyKey] || null
  const agyRollingUsed = currentAgyUsage?.rolling?.usagePercent ?? 0

  // OpenCode Go 水位统计
  let goTopRollingPercent = 0
  let goTotalRollingSum = 0
  let goAccountsCount = 0
  const goItems: Array<{ id: string; title: string; usage: AnyRecord }> = []
  for (const [id, u] of Object.entries(goUsageMap)) {
    if (!u || typeof u !== 'object') continue
    let title = id
    if (id.startsWith('key:')) {
      const k = (view?.apiKeys || []).find((x: any) => x.id === id.slice(4))
      title = k?.label ? `Key · ${k.label}` : 'API Key'
    } else if (id === 'local') {
      title = '本机 Key'
    } else {
      const acc = (view?.accounts || []).find((a: any) => a.id === id)
      title = acc?.name ? `Cookie · ${acc.name}` : 'Cookie 账号'
    }
    if (u?.rolling && typeof u.rolling.usagePercent === 'number') {
      const p = Math.min(100, Math.max(0, Math.round(u.rolling.usagePercent)))
      if (p > goTopRollingPercent) goTopRollingPercent = p
      goTotalRollingSum += p
      goAccountsCount++
    }
    goItems.push({ id, title, usage: u })
  }
  const goAvgRolling = goAccountsCount > 0 ? Math.round(goTotalRollingSum / goAccountsCount) : 0

  const isAntigravityMode = activeEngine === 'antigravity'
  // 全面显示当前的已用用量，绝不显示余多少
  const displayPercent = isAntigravityMode ? agyRollingUsed : goTopRollingPercent
  const displayTag = isAntigravityMode ? (currentAgyKey.includes('wym') ? 'AgyCli' : 'Agy') : 'Go'

  // 手动刷新
  const handleManualRefresh = async (e: any) => {
    e.stopPropagation()
    setRefreshing(true)
    try {
      if (isAntigravityMode) {
        await apiPost('/antigravity/refresh')
      } else {
        await apiPost('/quota/refresh')
      }
      await load()
    } catch { /* 忽略 */ }
    finally { setRefreshing(false) }
  }

  // 切换显示引擎
  const toggleEngine = (e: any) => {
    e.stopPropagation()
    setManualTarget(activeEngine === 'go' ? 'antigravity' : 'go')
  }

  const hasData = isAntigravityMode
    ? Object.keys(agyUsageMap).length > 0 || view?.antigravityAccounts?.length > 0
    : Object.keys(goUsageMap).length > 0 || view?.canQueryQuota

  if (!hasData && !isGeminiDetected) return null

  return h('div', {
    ref: containerRef,
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      userSelect: 'none',
      height: '28px',
    },
  },
    // 胶囊按钮：点击即可展开/收起浮窗
    h('button', {
      type: 'button',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '28px',
        padding: '0 6px',
        borderRadius: '24px',
        background: isOpen ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2))' : 'transparent',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        transition: 'background 0.15s ease',
        boxSizing: 'border-box',
      },
      onClick: () => setIsOpen((prev: boolean) => !prev),
      title: `${isAntigravityMode
        ? `🪐 Antigravity (Gemini) 5h用量: ${displayPercent}%`
        : `OpenCode Go 5h用量: ${displayPercent}%`}\n当前供应商: ${activeProvider || '未探测到'} / ${activeModelStr || '—'}\n切源依据: ${route.reason}\n点击展开控制面板与明细`,
    },
      h(CircularProgress, {
        percent: displayPercent,
        size: 14,
        strokeWidth: 2,
      }),
      h('span', {
        style: {
          fontWeight: 600,
          color: pctColor(displayPercent),
          fontVariantNumeric: 'tabular-nums',
        },
      }, `${displayPercent}%`),
      h('span', {
        style: {
          color: isAntigravityMode ? '#818cf8' : 'var(--dsw-alias-label-caption, rgba(128,128,128,0.7))',
          fontSize: '11px',
          fontWeight: isAntigravityMode ? 600 : 400,
        },
      }, displayTag),
    ),

    // ── 悬浮卡片面板（点击打开后常驻，绝不因鼠标移走而消失）──
    isOpen
      ? h('div', {
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            width: isAntigravityMode ? '340px' : (goItems.length >= 2 ? '300px' : '260px'),
            maxHeight: '480px',
            overflowY: 'auto',
            padding: '12px',
            background: 'var(--dsw-specific-menu, #1b1b1f)',
            color: 'var(--dsw-alias-label-primary, #fff)',
            borderRadius: '12px',
            boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.5))',
            border: '1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,.3))',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            fontSize: '12px',
            backdropFilter: 'blur(16px)',
            cursor: 'default',
          },
          onClick: (e: any) => e.stopPropagation(), // 阻止冒泡关闭
        },
          // 头部操作条
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              h('span', { style: { fontWeight: 600, fontSize: '13px', color: isAntigravityMode ? '#818cf8' : 'var(--dsw-alias-label-primary)' } },
                isAntigravityMode ? '🪐 Antigravity 额度' : (goItems.length >= 2 ? `OpenCode Go (${goItems.length}个)` : 'OpenCode Go 用量'),
              ),
              isGeminiDetected && isAntigravityMode
                ? h('span', { style: { fontSize: '10px', background: 'rgba(99,102,241,0.2)', color: '#818cf8', padding: '1px 5px', borderRadius: '4px' } }, 'Gemini识别')
                : null,
            ),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
              // 切源按钮
              h('button', {
                type: 'button',
                style: {
                  background: 'rgba(99,102,241,0.2)',
                  border: '1px solid rgba(99,102,241,0.4)',
                  color: '#c7d2fe',
                  fontSize: '11px',
                  padding: '2px 8px',
                  cursor: 'pointer',
                  borderRadius: '12px',
                  fontWeight: 500,
                },
                onClick: toggleEngine,
              }, isAntigravityMode ? '切为 Go ⇄' : '切为 Agy ⇄'),
              // 刷新按钮
              h('button', {
                type: 'button',
                style: {
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--dsw-alias-label-tertiary, #aaa)',
                  fontSize: '11px',
                  padding: '2px 4px',
                  cursor: 'pointer',
                  borderRadius: '4px',
                  opacity: refreshing ? 0.5 : 1,
                },
                onClick: handleManualRefresh,
                disabled: refreshing,
              }, refreshing ? '刷新中…' : '↻ 刷新'),
              // 关闭按钮
              h('button', {
                type: 'button',
                style: {
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--dsw-alias-label-tertiary, #888)',
                  fontSize: '12px',
                  padding: '2px 4px',
                  cursor: 'pointer',
                },
                onClick: () => setIsOpen(false),
              }, '✕'),
            ),
          ),

          // 当前识别到的模型信息
          (activeModelStr || activeProvider)
            ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)', borderBottom: '1px solid rgba(128,128,128,0.15)', paddingBottom: '6px', display: 'flex', flexDirection: 'column', gap: '2px' } },
                h('span', null, `当前供应商/模型: ${activeProvider || '未探测到'}${activeModelStr ? ` / ${activeModelStr.slice(0, 40)}` : ''}`),
                h('span', { style: { opacity: 0.8 } }, `切源依据: ${route.reason}${route.hit ? `（命中: ${route.hit.slice(0, 40)}）` : ''}`),
              )
            : null,

          // ── Antigravity 模式内容 ──
          isAntigravityMode
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                // 账号切换 Tab（明确标记 qiyu (agy) 和 wym (agy-cli)）
                agyAccountKeys.length > 1
                  ? h('div', { style: { display: 'flex', gap: '4px', padding: '2px', background: 'rgba(128,128,128,0.12)', borderRadius: '6px' } },
                      agyAccountKeys.map((key) => {
                        const acc = agyUsageMap[key]
                        const isSelected = key === currentAgyKey
                        const label = acc?.label || (key.includes('qiyu') ? 'qiyu (agy)' : 'wym (agy-cli)')
                        return h('button', {
                          key,
                          type: 'button',
                          style: {
                            flex: 1,
                            padding: '3px 6px',
                            fontSize: '11px',
                            borderRadius: '4px',
                            border: 'none',
                            cursor: 'pointer',
                            background: isSelected ? 'rgba(99,102,241,0.35)' : 'transparent',
                            color: isSelected ? '#fff' : 'var(--dsw-alias-label-secondary)',
                            fontWeight: isSelected ? 600 : 400,
                          },
                          onClick: () => setActiveAgyAccountId(key),
                        }, label)
                      }),
                    )
                  : null,

                currentAgyUsage
                  ? h(AntigravityCard, { accountKey: currentAgyKey, usage: currentAgyUsage })
                  : h('div', { style: { padding: '12px 0', textAlign: 'center', color: muted.color } },
                      h('div', null, '尚未配置或拉取到 Antigravity 额度'),
                      h('div', { style: { fontSize: '11px', marginTop: '4px' } }, '可在设置页的「凭据管理」中添加或导入账号。'),
                    ),
              )
            // ── OpenCode Go 模式内容 ──
            : (
                goItems.length > 0
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                      goItems.length >= 2
                        ? h('div', {
                            style: {
                              display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px',
                              borderRadius: '8px', background: 'rgba(99, 102, 241, 0.12)', border: '1px solid rgba(99, 102, 241, 0.25)',
                            },
                          },
                            h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600 } },
                              h('span', null, '📊 号池均值'),
                              h('span', { style: { color: pctColor(goTopRollingPercent) } }, `最高: ${goTopRollingPercent}%`),
                            ),
                            h(UsageRow, { label: '5h 均值', window: { usagePercent: goAvgRolling } }),
                          )
                        : null,
                      goItems.map((item) =>
                        h('div', {
                          key: item.id,
                          style: {
                            display: 'flex', flexDirection: 'column', gap: '8px',
                            padding: goItems.length >= 2 ? '8px' : '0',
                            borderRadius: '8px',
                            background: goItems.length >= 2 ? 'rgba(128,128,128,0.08)' : 'transparent',
                          },
                        },
                          goItems.length >= 2 ? h('div', { style: { fontSize: '11px', fontWeight: 600 } }, item.title) : null,
                          h(UsageRow, { label: '5h 滚动', window: item.usage?.rolling ?? null, fetchedAt: item.usage?.fetchedAt }),
                          h(UsageRow, { label: '7d 每周', window: item.usage?.weekly ?? null, fetchedAt: item.usage?.fetchedAt }),
                          h(UsageRow, { label: '30d 每月', window: item.usage?.monthly ?? null, fetchedAt: item.usage?.fetchedAt }),
                        ),
                      ),
                    )
                  : h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '8px 0' } }, '暂无 Go 额度数据，点击刷新')
              ),
        )
      : null,
  )
}

// ─── 组件：Tab 2 · 供应商显示策略（独立组件便于单测渲染） ──────────────

export function RoutingTab(props: {
  view: AnyRecord | null
  displayMode: string
  setDisplayMode: (value: string) => void
  providerTargets: AnyRecord
  setProviderTargets: (updater: any) => void
  providerRules: ProviderRule[]
  setProviderRules: (updater: any) => void
  ruleError: string
  clearRuleError: () => void
  busy: boolean
  saveDisplaySettings: () => void | Promise<void>
}): any {
  const h = React.createElement
  const {
    view, displayMode, setDisplayMode, providerTargets, setProviderTargets,
    providerRules, setProviderRules, ruleError, clearRuleError, busy, saveDisplaySettings,
  } = props

  const providers: AnyRecord[] = view?.providers ?? []
  const models: AnyRecord[] = view?.models ?? []

  // ── 正则规则实时自检（用未保存的本地规则做预览） ──
  const defaultRules: ProviderRule[] = Array.isArray(view?.defaultDisplaySettings?.providerRules)
    && view.defaultDisplaySettings.providerRules.length > 0
    ? view.defaultDisplaySettings.providerRules
    : DEFAULT_PROVIDER_RULES
  const previewDetected = detectCurrentModelFromDom()
  const previewDefaultProvider = String(view?.defaultModel?.provider ?? '')
  const previewDefaultModel = String(view?.defaultModel?.model ?? '')
  const previewProvider = String(
    previewDetected?.provider
      || resolveProviderFromCatalog(previewDetected?.model ?? '', models)
      || previewDefaultProvider,
  )
  const previewModelName = String(previewDetected?.model ?? '')
  const previewModel = String(previewModelName || previewDefaultModel)
  const previewDecision = resolveRoute({
    mode: displayMode,
    manualTarget: null,
    provider: previewProvider,
    model: previewModel,
    modelName: previewModelName,
    providerTargets,
    providerRules,
    geminiKeywords: Array.isArray(view?.displaySettings?.geminiKeywords) ? view.displaySettings.geminiKeywords : FALLBACK_GEMINI_KEYWORDS,
    defaultProvider: previewDefaultProvider,
    defaultModel: previewDefaultModel,
  })

  const updateRule = (id: string, patch: Partial<ProviderRule>): void => {
    setProviderRules((prev: ProviderRule[]) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
        // 显示模式选择卡片
        h('div', { style: card },
          h('strong', { style: { fontSize: '13px' } }, '1. 智能切源模式选择'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' } },
            [
              { id: 'auto', label: '智能自动 (Auto - 推荐)', desc: '读取会话真实选中的供应商/模型：先套用精确绑定与正则规则，未命中时 Gemini 系列显示 Antigravity、其余显示 OpenCode Go' },
              { id: 'provider-rule', label: '按供应商规则指定 (Provider Rules)', desc: '同上的判定顺序，适合完全按供应商/模型 ID 精确控制显示哪个额度' },
              { id: 'force-antigravity', label: '全局固定显示 Antigravity (Gemini)', desc: '无论选用何种模型，底栏与悬浮窗始终展示 Antigravity 配额' },
              { id: 'force-go', label: '全局固定显示 OpenCode Go', desc: '无论选用何种模型，底栏与悬浮窗始终展示 OpenCode Go 配额' },
            ].map((opt) =>
              h('label', {
                key: opt.id,
                style: {
                  display: 'flex', alignItems: 'flex-start', gap: '8px', cursor: 'pointer',
                  padding: '8px 10px', borderRadius: '6px',
                  background: displayMode === opt.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                  border: displayMode === opt.id ? '1px solid rgba(99,102,241,0.35)' : '1px solid transparent',
                },
              },
                h('input', {
                  type: 'radio',
                  name: 'displayMode',
                  value: opt.id,
                  checked: displayMode === opt.id,
                  onChange: () => setDisplayMode(opt.id),
                  style: { marginTop: '3px' },
                }),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
                  h('span', { style: { fontWeight: 600, fontSize: '12px' } }, opt.label),
                  h('span', { style: { ...muted, fontSize: '11px' } }, opt.desc),
                ),
              ),
            ),
          ),
          h('div', { style: { ...row, marginTop: '8px' } },
            h('button', { style: btnPrimary, onClick: () => void saveDisplaySettings(), disabled: busy }, '保存策略'),
          ),
        ),

        // 供应商映射配置
        h('div', { style: card },
          h('div', { style: row },
            h('strong', { style: { fontSize: '13px' } }, '2. 各供应商显示用量绑定'),
            h('span', { style: muted }, '（手动选择切换到某个/某些供应商时显示哪个用量）'),
          ),
          providers.length === 0
            ? h('div', { style: muted }, '暂未检测到系统中已安装的额外供应商配置')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
                providers.map((p) => {
                  let currentTarget = providerTargets[p.id]
                  if (!currentTarget) {
                    if (p.id === 'agycli' || p.id === 'agy-cli') currentTarget = 'antigravity:wym'
                    else if (p.id === 'agy' || p.id === 'antigravity') currentTarget = 'antigravity:qiyu'
                    else currentTarget = 'go'
                  }
                  return h('div', {
                    key: p.id,
                    style: {
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 12px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)',
                    },
                  },
                    h('div', { style: { display: 'flex', flexDirection: 'column' } },
                      h('span', { style: { fontWeight: 600 } }, p.name || p.id),
                      h('span', { style: { ...muted, fontSize: '11px' } }, `ID: ${p.id} · 模型数: ${p.modelCount}`),
                    ),
                    h('select', {
                      style: selectStyle,
                      value: currentTarget,
                      onChange: (e: any) => {
                        const val = e.target.value
                        setProviderTargets((prev: any) => ({ ...prev, [p.id]: val }))
                      },
                    },
                      h('option', { value: 'antigravity:qiyu' }, '🪐 显示 Antigravity (qiyu · agy) 用量'),
                      h('option', { value: 'antigravity:wym' }, '🪐 显示 Antigravity (wym · agycli) 用量'),
                      h('option', { value: 'go' }, '⚡ 显示 OpenCode Go 用量'),
                    ),
                  )
                }),
              ),
          h('div', { style: { ...row, marginTop: '8px' } },
            h('button', { style: btnPrimary, onClick: () => void saveDisplaySettings(), disabled: busy }, '保存供应商配置'),
          ),
        ),

        // 供应商正则匹配规则
        h('div', { style: card },
          h('div', { style: row },
            h('strong', { style: { fontSize: '13px' } }, '3. 供应商正则匹配切换'),
            h('span', { style: muted }, '（按顺序匹配，首个命中的启用规则生效）'),
          ),
          h('div', { style: { ...muted, fontSize: '11px', lineHeight: 1.7 } },
            '依次把每条正则（不区分大小写）应用在 ',
            h('code', { style: { opacity: 0.9 } }, 'provider/model'),
            ' → ',
            h('code', { style: { opacity: 0.9 } }, 'provider'),
            ' → ',
            h('code', { style: { opacity: 0.9 } }, 'model'),
            ' → 模型显示名。适合 ID 不固定的供应商（如 ',
            h('code', { style: { opacity: 0.9 } }, 'opencode-go-native'),
            '、',
            h('code', { style: { opacity: 0.9 } }, 'agy'),
            '、',
            h('code', { style: { opacity: 0.9 } }, 'agycli'),
            '）。优先级：手动切换 > 固定模式 > 精确绑定（上表）> 正则规则 > 自动识别。',
          ),

          // 实时自检
          h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: 'rgba(99,102,241,0.08)', display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px' } },
            h('div', { style: row },
              h('span', { style: { fontWeight: 600 } }, '实时自检：'),
              h('span', { style: { opacity: 0.85 } }, `${previewProvider || '未探测到供应商'} / ${previewModel || '—'}`),
            ),
            h('div', { style: row },
              h('span', { style: { opacity: 0.85 } },
                `→ 将显示 ${previewDecision.engine === 'antigravity'
                  ? `Antigravity（${previewDecision.agyHint === 'wym' ? 'wym' : 'qiyu'}）`
                  : 'OpenCode Go'}`,
              ),
              h('span', { style: { opacity: 0.7 } }, `｜依据: ${previewDecision.reason}`),
              previewDecision.hit ? h('span', { style: { opacity: 0.7 } }, `｜命中: ${previewDecision.hit.slice(0, 48)}`) : null,
            ),
          ),

          providerRules.length === 0
            ? h('div', { style: muted }, '暂无规则（此时回落到「自动识别」：Gemini 关键词 → Antigravity，其余 → Go）')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '2px' } },
                providerRules.map((rule: ProviderRule, index: number) =>
                  h('div', {
                    key: rule.id,
                    style: {
                      display: 'grid',
                      gridTemplateColumns: 'auto minmax(140px, 1.6fr) minmax(150px, 1fr) auto',
                      gap: '6px', alignItems: 'center',
                      padding: '6px 8px', borderRadius: '6px',
                      background: rule.enabled === false ? 'rgba(128,128,128,0.04)' : 'rgba(128,128,128,0.08)',
                      opacity: rule.enabled === false ? 0.6 : 1,
                    },
                  },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                      h('input', {
                        type: 'checkbox',
                        checked: rule.enabled !== false,
                        title: '启用/停用该规则',
                        onChange: (e: any) => updateRule(rule.id, { enabled: Boolean(e.target.checked) }),
                      }),
                      h('span', { style: { ...muted, fontSize: '10px', width: '14px', textAlign: 'right' } }, `${index + 1}`),
                    ),
                    h('input', {
                      style: { ...input, fontFamily: 'monospace', borderColor: compileRule(rule.pattern) ? 'rgba(128,128,128,.3)' : 'rgba(229,105,122,.7)' },
                      placeholder: '正则，如 ^opencode 或 agy[-_]?cli',
                      value: rule.pattern,
                      onChange: (e: any) => updateRule(rule.id, { pattern: e.target.value }),
                    }),
                    h('select', {
                      style: selectStyle,
                      value: TARGET_OPTIONS.some((o) => o.value === rule.target) ? rule.target : 'go',
                      onChange: (e: any) => updateRule(rule.id, { target: e.target.value as ProviderTarget }),
                    },
                      TARGET_OPTIONS.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
                    ),
                    h('button', {
                      style: { ...btnDanger, padding: '4px 8px' },
                      title: rule.note || '删除该规则',
                      onClick: () => setProviderRules((prev: ProviderRule[]) => prev.filter((r) => r.id !== rule.id)),
                    }, '✕'),
                  ),
                ),
              ),

          ruleError ? h('div', { style: errText }, ruleError) : null,

          h('div', { style: { ...row, marginTop: '8px' } },
            h('button', {
              style: btn,
              disabled: busy,
              onClick: () => setProviderRules((prev: ProviderRule[]) => [...prev, createRule()]),
            }, '＋ 新增规则'),
            h('button', {
              style: btn,
              disabled: busy || defaultRules.length === 0,
              title: '恢复内置默认规则（opencode → Go、agycli → wym、agy/gemini → qiyu）',
              onClick: () => {
                clearRuleError()
                setProviderRules(defaultRules.map((r) => createRule({ pattern: r.pattern, target: r.target, enabled: r.enabled, note: r.note })))
              },
            }, '恢复默认规则'),
            h('button', { style: btnPrimary, onClick: () => void saveDisplaySettings(), disabled: busy }, '保存正则规则'),
          ),
        ),

        // 识别到的模型列表预览
        h('div', { style: card },
          h('div', { style: row },
            h('strong', { style: { fontSize: '13px' } }, `4. 系统识别到的模型列表 (${models.length} 个)`),
            view?.defaultModel ? h('span', { style: { ...muted, fontSize: '11px' } }, `(当前默认: ${view.defaultModel.provider}/${view.defaultModel.model})`) : null,
          ),
          models.length === 0
            ? h('div', { style: muted }, '暂未获取到模型列表')
            : h('div', { style: { maxHeight: '240px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } },
                models.map((m: any) =>
                  h('div', {
                    key: `${m.provider}/${m.id}`,
                    style: {
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '4px 8px', borderRadius: '4px', background: 'rgba(128,128,128,0.06)',
                      fontSize: '11px',
                    },
                  },
                    h('div', { style: row },
                      h('span', { style: { fontWeight: 500 } }, m.name || m.id),
                      h('span', { style: muted }, `[${m.provider}]`),
                    ),
                    m.isGemini
                      ? h('span', { style: { color: '#818cf8', fontWeight: 600, fontSize: '10px', background: 'rgba(99,102,241,0.15)', padding: '1px 5px', borderRadius: '3px' } }, 'Gemini系列 · 映射Agy')
                      : h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '10px' } }, 'OpenCode Go'),
                  ),
                ),
              ),
        ),
  )
}

// ─── 设置页主组件 ──────────────────────────────────────────────────────────

function OcgoSection(): any {
  const h = React.createElement
  const useStateShim = React.useState as any
  const [view, setView] = useStateShim(null as AnyRecord | null)
  const [tab, setTab] = useStateShim('quota' as 'quota' | 'routing' | 'creds')
  const [busy, setBusy] = useStateShim(false)
  const [status, setStatus] = useStateShim('')
  const [statusIsError, setStatusIsError] = useStateShim(false)

  // Go 凭据表单
  const [keyLabel, setKeyLabel] = useStateShim('')
  const [keyDraft, setKeyDraft] = useStateShim('')
  const [accName, setAccName] = useStateShim('')
  const [accWs, setAccWs] = useStateShim('')
  const [accCookie, setAccCookie] = useStateShim('')

  // Antigravity 凭据表单
  const [agyEmail, setAgyEmail] = useStateShim('')
  const [agyRefreshToken, setAgyRefreshToken] = useStateShim('')
  const [oauthCode, setOauthCode] = useStateShim('')

  // 路由策略设置本地暂存
  const [displayMode, setDisplayMode] = useStateShim('auto')
  const [providerTargets, setProviderTargets] = useStateShim({} as Record<string, string>)
  const [providerRules, setProviderRules] = useStateShim([] as ProviderRule[])
  const [ruleError, setRuleError] = useStateShim('')

  const flash = (text: string, isError = false): void => { setStatus(text); setStatusIsError(isError) }

  const loadState = React.useCallback(async (): Promise<void> => {
    try {
      const v = await apiGet('/state')
      setView(v)
      if (v?.displaySettings) {
        setDisplayMode(v.displaySettings.mode || 'auto')
        setProviderTargets(v.displaySettings.providerTargets || {})
        setProviderRules(Array.isArray(v.displaySettings.providerRules) ? v.displaySettings.providerRules : [])
      }
    } catch (e) {
      flash(`状态读取失败: ${shortErr(e)}`, true)
    }
  }, [])

  React.useEffect(() => { void loadState() }, [loadState])

  const saveDisplaySettings = async (): Promise<void> => {
    const invalid = validateRules(providerRules)
    if (invalid) { flash(invalid, true); setRuleError(invalid); return }
    setRuleError('')
    setBusy(true); flash('保存路由策略中…')
    try {
      await apiPost('/settings/display', {
        mode: displayMode,
        providerTargets,
        providerRules,
      })
      await loadState()
      flash('显示策略已保存！')
    } catch (e) {
      flash(shortErr(e), true)
    } finally { setBusy(false) }
  }

  const refreshAllQuotas = async (): Promise<void> => {
    setBusy(true); flash('刷新用量数据中…')
    try {
      await Promise.allSettled([
        apiPost('/quota/refresh'),
        apiPost('/antigravity/refresh'),
      ])
      await loadState()
      flash('额度已全部更新')
    } catch (e) {
      flash(shortErr(e), true)
    } finally { setBusy(false) }
  }

  const addKey = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiPost('/credentials/apikey', { label: keyLabel, apiKey: keyDraft.trim() })
      setKeyLabel(''); setKeyDraft('')
      flash('API Key 已保存')
      await loadState()
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const removeKey = async (id: string): Promise<void> => {
    if (!window.confirm('确定要删除该 API Key 吗？')) return
    setBusy(true)
    try {
      await apiPost('/credentials/apikey/remove', { id })
      await loadState()
      flash('API Key 已删除')
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const saveAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiPost('/credentials/account', { name: accName, workspaceId: accWs, cookie: accCookie })
      setAccName(''); setAccWs(''); setAccCookie('')
      flash('账号已保存')
      await loadState()
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const removeAccount = async (id: string): Promise<void> => {
    if (!window.confirm('确定要删除该账号凭据吗？')) return
    setBusy(true)
    try {
      await apiPost('/credentials/account/remove', { id })
      await loadState()
      flash('账号凭据已删除')
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const saveAntigravityAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      await apiPost('/antigravity/credentials', {
        email: agyEmail.trim() || undefined,
        refreshToken: agyRefreshToken.trim(),
      })
      setAgyEmail(''); setAgyRefreshToken('')
      flash('Antigravity OAuth 凭据已保存')
      await loadState()
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const removeAntigravityAccount = async (id: string): Promise<void> => {
    if (!window.confirm('确定要删除该 Antigravity 账号吗？')) return
    setBusy(true)
    try {
      await apiPost('/antigravity/credentials/remove', { id })
      await loadState()
      flash('Antigravity 账号已删除')
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const importDiscoveredAntigravity = async (): Promise<void> => {
    setBusy(true); flash('导入本地凭据中…')
    try {
      const res = await apiPost('/antigravity/credentials/import-discovered')
      flash(`成功同步 ${res.imported} 个账号！`)
      await loadState()
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const startGoogleOAuth = async (): Promise<void> => {
    setBusy(true)
    try {
      const data = await apiGet('/antigravity/oauth/auth-url')
      if (data?.authUrl) {
        window.open(data.authUrl, '_blank', 'width=600,height=700')
        flash('已在浏览器新窗口打开 Google 授权页，授权后复制 code 粘贴于下方输入框即可完成绑定。')
      }
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const exchangeOAuthCode = async (): Promise<void> => {
    if (!oauthCode.trim()) return
    setBusy(true); flash('兑换 Google 令牌中…')
    try {
      const res = await apiPost('/antigravity/oauth/exchange', { code: oauthCode.trim() })
      setOauthCode('')
      flash(`绑定成功！已接入 Google 账号: ${res.email}`)
      await loadState()
    } catch (e) { flash(shortErr(e), true) }
    finally { setBusy(false) }
  }

  const apiKeys: AnyRecord[] = view?.apiKeys ?? []
  const accounts: AnyRecord[] = view?.accounts ?? []
  const goUsage: AnyRecord = view?.usage ?? {}
  const agyAccounts: AnyRecord[] = view?.antigravityAccounts ?? []
  const agyUsage: AnyRecord = view?.antigravityUsage ?? {}
  const providers: AnyRecord[] = view?.providers ?? []
  const models: AnyRecord[] = view?.models ?? []


  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
    // 顶部 Tab 栏
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' } },
      h('div', { style: row },
        h('button', { style: tab === 'quota' ? btnPrimary : btn, onClick: () => setTab('quota'), disabled: busy }, '额度总览'),
        h('button', { style: tab === 'routing' ? btnPrimary : btn, onClick: () => setTab('routing'), disabled: busy }, '⚙ 供应商显示策略'),
        h('button', { style: tab === 'creds' ? btnPrimary : btn, onClick: () => setTab('creds'), disabled: busy }, '凭据管理'),
      ),
      h('div', { style: row },
        h('button', { style: btn, onClick: () => void refreshAllQuotas(), disabled: busy }, busy ? '刷新中…' : '↻ 全局刷新'),
        status ? h('span', { style: statusIsError ? errText : okText }, status) : null,
      ),
    ),

    // ── TAB 1：额度总览 ──
    tab === 'quota'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
          // Antigravity (Gemini) 配额区域
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('div', { style: row },
                h('strong', { style: { fontSize: '14px', color: '#818cf8' } }, '🪐 Google Antigravity (Gemini 真实配额)'),
                Object.keys(agyUsage).length > 0 ? h('span', { style: okText }, '已连接') : h('span', { style: muted }, '未连接'),
              ),
            ),
            Object.keys(agyUsage).length === 0
              ? h('div', { style: card },
                  h('span', { style: muted }, '未读取到 Antigravity 配额。'),
                  view?.discoveredAntigravityCount > 0
                    ? h('div', { style: row },
                        h('span', null, `检测到本地有 ${view.discoveredAntigravityCount} 个可用凭据：`),
                        h('button', { style: btnPrimary, onClick: () => void importDiscoveredAntigravity(), disabled: busy }, '一键导入并拉取额度'),
                      )
                    : h('div', { style: row },
                        h('span', null, '请前往「凭据管理」添加 Google OAuth 凭据。'),
                      ),
                )
              : Object.entries(agyUsage).map(([id, u]) =>
                  h(AntigravityCard, { key: id, accountKey: id, usage: u as AnyRecord }),
                ),
          ),

          // OpenCode Go 配额区域
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            h('strong', { style: { fontSize: '14px' } }, '⚡ OpenCode Go (套餐用量)'),
            !view?.canQueryQuota
              ? h('div', { style: card },
                  h('strong', null, '还没有可查 Go 额度的凭据'),
                  h('div', { style: row }, h('span', null, '① 在「凭据」里添加 API Key：'),
                    h('a', { href: 'https://opencode.ai/console', target: '_blank', rel: 'noopener', style: { fontSize: '12px' } }, '打开 opencode.ai 控制台 ↗')),
                  h('div', { style: row }, h('span', null, '② 或添加网页 Cookie 账号。')),
                )
              : Object.keys(goUsage).length === 0
                ? h('div', { style: muted }, '暂无 Go 数据')
                : Object.entries(goUsage).map(([id, u]) =>
                    h(UsageCard, { key: id, title: id.startsWith('key:') ? 'API Key' : (id === 'local' ? '本机 Key' : 'Cookie 账号'), usage: u as AnyRecord }),
                  ),
          ),
        )

      // ── TAB 2：供应商显示策略与识别模型列表 ──
      : tab === 'routing'
        ? h(RoutingTab, {
            view,
            displayMode,
            setDisplayMode,
            providerTargets,
            setProviderTargets,
            providerRules,
            setProviderRules,
            ruleError,
            clearRuleError: () => setRuleError(''),
            busy,
            saveDisplaySettings,
          })

        // ── TAB 3：凭据管理 ──
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
            // ① Antigravity OAuth 凭据管理
            h('div', { style: card },
              h('div', { style: row },
                h('strong', { style: { color: '#818cf8' } }, '🪐 Google Antigravity OAuth 凭证'),
                agyAccounts.length > 0 ? h('span', { style: okText }, `${agyAccounts.length} 个账号`) : null,
              ),

              // 自动发现导入提示
              view?.discoveredAntigravityCount > 0
                ? h('div', { style: { padding: '8px 10px', borderRadius: '6px', background: 'rgba(99,102,241,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                    h('span', { style: { fontSize: '12px' } }, `💡 发现本地存在可用凭据：qiyu (agy) 与 wym (agy-cli)`),
                    h('button', { style: btnPrimary, onClick: () => void importDiscoveredAntigravity(), disabled: busy }, '同步并导入'),
                  )
                : null,

              // 已配置列表
              agyAccounts.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                    agyAccounts.map((a) =>
                      h('div', { key: a.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', borderRadius: '6px', background: 'rgba(128,128,128,0.08)' } },
                        h('div', { style: { display: 'flex', flexDirection: 'column' } },
                          h('span', { style: { fontWeight: 600, fontSize: '12px', color: '#818cf8' } }, a.label || a.email),
                          h('span', { style: { ...muted, fontSize: '10px' } }, `邮箱: ${a.email} · 来源: ${a.source || '手动添加'}`),
                        ),
                        h('button', { style: btnDanger, onClick: () => void removeAntigravityAccount(a.id), disabled: busy }, '删除'),
                      ),
                    ),
                  )
                : h('div', { style: muted }, '暂未配置 Antigravity 账号'),

              // 手动配置 / 粘贴 Refresh Token
              h('div', { style: { fontSize: '12px', fontWeight: 600, marginTop: '4px' } }, '方式 A：手动粘贴 Refresh Token'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '6px' } },
                h('input', { style: input, placeholder: '备注（如 主 Google 账号）', value: agyEmail, onChange: (e: any) => setAgyEmail(e.target.value) }),
                h('input', { style: input, type: 'password', placeholder: '1//... (Google OAuth Refresh Token)', value: agyRefreshToken, onChange: (e: any) => setAgyRefreshToken(e.target.value) }),
              ),
              h('div', { style: row },
                h('button', { style: btnPrimary, onClick: () => void saveAntigravityAccount(), disabled: busy || !agyRefreshToken.trim() }, '保存 Token'),
                h('span', { style: muted }, '使用官方 Client ID 自动轮询刷新。'),
              ),

              // 网页 OAuth 授权
              h('div', { style: { fontSize: '12px', fontWeight: 600, marginTop: '8px' } }, '方式 B：Google 网页 OAuth 快捷登录'),
              h('div', { style: row },
                h('button', { style: btn, onClick: () => void startGoogleOAuth(), disabled: busy }, '打开 Google 授权窗口 ↗'),
                h('input', { style: { ...input, width: '220px' }, placeholder: '粘贴返回的 authorization code', value: oauthCode, onChange: (e: any) => setOauthCode(e.target.value) }),
                h('button', { style: btnPrimary, onClick: () => void exchangeOAuthCode(), disabled: busy || !oauthCode.trim() }, '兑换并绑定'),
              ),
            ),

            // ② OpenCode Go API Key 管理
            h('div', { style: card },
              h('div', { style: row },
                h('strong', null, '⚡ OpenCode Go API Key'),
                apiKeys.length > 0 ? h('span', { style: okText }, `${apiKeys.length} 个`) : null,
              ),
              apiKeys.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    apiKeys.map((k) => h('div', { style: row, key: k.id },
                      h('span', { style: { fontSize: '12px' } }, k.label),
                      h('button', { style: btnDanger, onClick: () => void removeKey(k.id), disabled: busy }, '删除'),
                    )),
                  )
                : h('div', { style: muted }, view?.localKeyFound ? '未添加（额度页会用本机 auth.json 自动发现兜底）' : '未添加'),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '6px' } },
                h('input', { style: input, placeholder: '备注（可选）', value: keyLabel, onChange: (e: any) => setKeyLabel(e.target.value) }),
                h('input', { style: input, type: 'password', placeholder: 'sk-...（opencode.ai 控制台 Keys 页生成）', value: keyDraft, onChange: (e: any) => setKeyDraft(e.target.value) }),
              ),
              h('div', { style: row },
                h('button', { style: btnPrimary, onClick: () => void addKey(), disabled: busy || !keyDraft.trim() }, '添加 Key'),
                h('span', { style: muted }, '可添加多个 Key。'),
              ),
            ),

            // ③ OpenCode Go 网页 Cookie
            h('div', { style: card },
              h('div', { style: row },
                h('strong', null, '⚡ OpenCode Go 网页 Cookie 账号'),
              ),
              h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
                h('input', { style: input, placeholder: '备注名（如 主号）', value: accName, onChange: (e: any) => setAccName(e.target.value) }),
                h('input', { style: input, placeholder: 'wrk_xxx（工作区 URL）', value: accWs, onChange: (e: any) => setAccWs(e.target.value) }),
              ),
              h('textarea', {
                style: { ...input, minHeight: '54px', resize: 'vertical' },
                placeholder: '浏览器 DevTools 复制的 auth Cookie（Fe26.…）',
                value: accCookie, onChange: (e: any) => setAccCookie(e.target.value),
              }),
              h('div', { style: row },
                h('button', { style: btnPrimary, onClick: () => void saveAccount(), disabled: busy }, '添加/更新账号'),
              ),
              accounts.length > 0
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    accounts.map((a) => h('div', { style: row, key: a.id },
                      h('span', { style: { fontSize: '12px' } }, `${a.name} (${a.workspaceId})`),
                      h('button', { style: btnDanger, onClick: () => void removeAccount(a.id), disabled: busy }, '删除'),
                    )),
                  )
                : null,
            ),
          ),
  )
}

export function apply(ctx: ClientContext): void {
  clientContext = ctx as any

  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'ocgo-usage',
      order: 46,
      label: 'Go / Agy 用量',
    }, OcgoSection),
  ), '@dsh-external/dsh-ocgo-usage: settings section')

  ctx.effect(() => ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'ocgo-usage-composer-ring',
      order: 10,
      // 用 DSH 模型选择服务的真实选择（provider/model）驱动切源，而不是配置默认值
      inject: (sessionId: string) => ({ modelStore: resolveModelStore(sessionId) }),
    }, ComposerGoQuota),
  ), '@dsh-external/dsh-ocgo-usage: composer input ring')
}
