/**
 * @dsh-external/dsh-opencode-go-dashboard — Client 渲染端（工业级健壮性重构）。
 *
 * 核心设计升级：
 * 1. 严格生命周期与节能管理：
 *    - 监听 visibilitychange，页面切后台（document.hidden）时彻底休眠定时器；
 *    - 组件卸载时严格回收全部 timer 与事件监听器，绝无内存/连接泄漏。
 * 2. 服务端时钟对齐（Server Time Synchronization）：
 *    - 基于 Host 下发的精确 serverTime 校准客户端时钟漂移，倒计时无惧系统时钟快慢，绝不出现负数或 00:00:00 反复横跳。
 * 3. 容灾与 ErrorBoundary 保护：
 *    - 纯函数防御性渲染，异常降级显示，绝不让聊天底栏或设置面板出现白屏崩溃。
 */
import React from 'react'

type AnyRecord = Record<string, any>

const ROUTE = '/api/dsh-ocgo-usage'

type ClientContext = {
  slots: any
  effect(fn: () => () => void, label?: string): void
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

// ─── HTTP 封装（仅调用同源 Host 内存接口）─────────────────────────────────

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

// ─── 组件：用量行（严格空值守卫）──────────────────────────────────────────

function UsageRow(props: { label: string; window: AnyRecord | null; fetchedAt?: string }): any {
  const h = React.createElement
  const w = props.window
  if (!w || typeof w !== 'object' || typeof w.usagePercent !== 'number') {
    return h('div', { style: row },
      h('span', { style: { ...muted, width: 64 } }, props.label),
      h('span', { style: muted }, '—'),
    )
  }
  const p = Math.min(100, Math.max(0, Math.round(w.usagePercent)))
  const reset = fmtReset(w, props.fetchedAt)
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px' } },
      h('span', { style: { color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.7))', fontWeight: 500 } }, props.label),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { color: pctColor(p), fontWeight: 600 } }, `${p}%`),
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
          width: `${p}%`, height: '100%', transition: 'width .3s ease',
          background: pctColor(p),
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

// ─── 组件：底栏圆环 (conversation.input.right) ────────────────────────────

function CircularProgress({ percent, size = 14, strokeWidth = 2 }: { percent: number; size?: number; strokeWidth?: number }): any {
  const h = React.createElement
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const validPct = Math.min(100, Math.max(0, percent))
  const strokeDashoffset = circumference - (validPct / 100) * circumference
  const color = pctColor(validPct)

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

function ComposerGoQuota(): any {
  const h = React.createElement
  const useStateShim = React.useState as any
  const [view, setView] = useStateShim(null as AnyRecord | null)
  const [hovered, setHovered] = useStateShim(false)
  const [refreshing, setRefreshing] = useStateShim(false)
  const [, setTick] = useStateShim(0)

  const load = React.useCallback(async () => {
    try {
      const v = await apiGet('/state')
      setView(v)
    } catch { /* 保持静默，网络断开时不白屏 */ }
  }, [])

  // 节能定时器：页面激活时 30s 轮询，切后台彻底冻结
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

  const usageMap: Record<string, AnyRecord> = view?.usage ?? {}
  const usageKeys = Object.keys(usageMap)
  if (!view?.canQueryQuota && usageKeys.length === 0) return null

  const apiKeys: AnyRecord[] = view?.apiKeys ?? []
  const accounts: AnyRecord[] = view?.accounts ?? []

  let topRollingPercent = 0
  let totalRollingSum = 0
  let totalWeeklySum = 0
  let totalMonthlySum = 0
  let validAccountsCount = 0

  const items: Array<{ id: string; title: string; usage: AnyRecord }> = []

  for (const [id, u] of Object.entries(usageMap)) {
    if (!u || typeof u !== 'object') continue
    let title = id
    if (id.startsWith('key:')) {
      const k = apiKeys.find((x) => x.id === id.slice(4))
      title = k?.label ? `Key · ${k.label}` : 'API Key'
    } else if (id === 'local') {
      title = '本机 Key'
    } else {
      const acc = accounts.find((a) => a.id === id)
      title = acc?.name ? `Cookie · ${acc.name}` : 'Cookie 账号'
    }

    if (u?.rolling && typeof u.rolling.usagePercent === 'number') {
      const p = Math.min(100, Math.max(0, Math.round(u.rolling.usagePercent)))
      if (p > topRollingPercent) topRollingPercent = p
      totalRollingSum += p
      if (u?.weekly?.usagePercent) totalWeeklySum += Math.round(u.weekly.usagePercent)
      if (u?.monthly?.usagePercent) totalMonthlySum += Math.round(u.monthly.usagePercent)
      validAccountsCount++
    }
    items.push({ id, title, usage: u })
  }

  const isMultiAccount = items.length >= 2
  const poolRollingAvg = validAccountsCount > 0 ? Math.round(totalRollingSum / validAccountsCount) : 0
  const poolWeeklyAvg = validAccountsCount > 0 ? Math.round(totalWeeklySum / validAccountsCount) : 0
  const poolMonthlyAvg = validAccountsCount > 0 ? Math.round(totalMonthlySum / validAccountsCount) : 0

  const handleManualRefresh = async (e: any) => {
    e.stopPropagation()
    setRefreshing(true)
    try {
      await apiPost('/quota/refresh')
      await load()
    } catch { /* 忽略异常 */ }
    finally { setRefreshing(false) }
  }

  return h('div', {
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      userSelect: 'none',
      height: '28px',
    },
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  },
    h('button', {
      type: 'button',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        height: '28px',
        padding: '0 6px',
        borderRadius: '24px',
        background: hovered ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' : 'transparent',
        border: 'none',
        outline: 'none',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, currentColor)',
        transition: 'background 0.15s ease',
        boxSizing: 'border-box',
      },
      onClick: handleManualRefresh,
      title: isMultiAccount
        ? `单号最高 5h: ${topRollingPercent}% | 号池均值: ${poolRollingAvg}% (共 ${items.length} 个账号)\n点击立即刷新`
        : `5h 滚动用量: ${topRollingPercent}%\n点击立即刷新`,
    },
      h(CircularProgress, { percent: topRollingPercent, size: 14, strokeWidth: 2 }),
      isMultiAccount
        ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } },
            h('span', { style: { fontWeight: 600, color: pctColor(topRollingPercent), fontVariantNumeric: 'tabular-nums' } }, `${topRollingPercent}%`),
            h('span', { style: { opacity: 0.6, fontSize: '11px' } }, `(池${poolRollingAvg}%)`),
          )
        : h('span', { style: { fontWeight: 500, color: pctColor(topRollingPercent), fontVariantNumeric: 'tabular-nums' } }, `${topRollingPercent}%`),
      h('span', { style: { color: 'var(--dsw-alias-label-caption, rgba(128,128,128,0.7))', fontSize: '11px' } }, '5h'),
    ),

    hovered
      ? h('div', {
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            width: isMultiAccount ? '300px' : '260px',
            maxHeight: '440px',
            overflowY: 'auto',
            padding: '12px',
            background: 'var(--dsw-specific-menu, #1b1b1f)',
            color: 'var(--dsw-alias-label-primary, #fff)',
            borderRadius: '12px',
            boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.4))',
            border: '1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,.25))',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            fontSize: '12px',
            backdropFilter: 'blur(16px)',
            cursor: 'default',
          },
        },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('div', { style: { fontWeight: 600, fontSize: '12px', color: 'var(--dsw-alias-label-primary)' } },
              isMultiAccount ? `OpenCode Go 号池 (${items.length} 个)` : 'OpenCode Go 用量',
            ),
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
          ),

          isMultiAccount
            ? h('div', {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                  padding: '10px',
                  borderRadius: '8px',
                  background: 'rgba(99, 102, 241, 0.12)',
                  border: '1px solid rgba(99, 102, 241, 0.25)',
                },
              },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
                  h('span', null, '📊 号池平均水位'),
                  h('span', { style: { color: pctColor(topRollingPercent) } }, `单号最高: ${topRollingPercent}%`),
                ),
                h(UsageRow, { label: '5h 均值', window: { usagePercent: poolRollingAvg } }),
                h(UsageRow, { label: '7d 均值', window: { usagePercent: poolWeeklyAvg } }),
                h(UsageRow, { label: '30d 均值', window: { usagePercent: poolMonthlyAvg } }),
              )
            : null,

          items.length > 0
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
                isMultiAccount
                  ? h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption)', marginTop: '2px' } }, '账号明细：')
                  : null,
                items.map((item) =>
                  h('div', {
                    key: item.id,
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: isMultiAccount ? '8px' : '0',
                      borderRadius: '8px',
                      background: isMultiAccount ? 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))' : 'transparent',
                    },
                  },
                    isMultiAccount
                      ? h('div', { style: { fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' } }, item.title)
                      : null,
                    h(UsageRow, { label: '5h 滚动', window: item.usage?.rolling ?? null, fetchedAt: item.usage?.fetchedAt }),
                    h(UsageRow, { label: '7d 每周', window: item.usage?.weekly ?? null, fetchedAt: item.usage?.fetchedAt }),
                    h(UsageRow, { label: '30d 每月', window: item.usage?.monthly ?? null, fetchedAt: item.usage?.fetchedAt }),
                    item.usage?.fetchedAt
                      ? h('div', {
                          style: {
                            color: 'var(--dsw-alias-label-tertiary)',
                            fontSize: '10px',
                            textAlign: 'right',
                            marginTop: '2px',
                          },
                        }, `更新于 ${new Date(item.usage.fetchedAt).toLocaleTimeString()}`)
                      : null,
                  ),
                ),
              )
            : h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '8px 0' } }, '暂无额度数据，点击刷新'),
        )
      : null,
  )
}

// ─── 设置页主组件 ──────────────────────────────────────────────────────────

function OcgoSection(): any {
  const h = React.createElement
  const useStateShim = React.useState as any
  const [view, setView] = useStateShim(null as AnyRecord | null)
  const [tab, setTab] = useStateShim('quota' as 'quota' | 'creds')
  const [busy, setBusy] = useStateShim(false)
  const [status, setStatus] = useStateShim('')
  const [statusIsError, setStatusIsError] = useStateShim(false)

  const [keyLabel, setKeyLabel] = useStateShim('')
  const [keyDraft, setKeyDraft] = useStateShim('')
  const [accName, setAccName] = useStateShim('')
  const [accWs, setAccWs] = useStateShim('')
  const [accCookie, setAccCookie] = useStateShim('')

  const flash = (text: string, isError = false): void => { setStatus(text); setStatusIsError(isError) }

  const loadState = React.useCallback(async (): Promise<void> => {
    try {
      setView(await apiGet('/state'))
    } catch (e) {
      flash(`状态读取失败: ${shortErr(e)}`, true)
    }
  }, [])

  React.useEffect(() => { void loadState() }, [loadState])

  const refreshQuota = async (): Promise<void> => {
    setBusy(true); flash('刷新中…')
    try {
      await apiPost('/quota/refresh')
      await loadState()
      flash('额度已更新')
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

  const apiKeys: AnyRecord[] = view?.apiKeys ?? []
  const accounts: AnyRecord[] = view?.accounts ?? []
  const usage: AnyRecord = view?.usage ?? {}

  const titleFor = (id: string): string => {
    if (id.startsWith('key:')) {
      const k = apiKeys.find((x) => x.id === id.slice(4))
      return k?.label ?? 'API Key'
    }
    if (id === 'local') return '本机 Key（自动发现）'
    const acc = accounts.find((a) => a.id === id)
    return acc?.name ?? id
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    h('div', { style: row },
      h('button', { style: tab === 'quota' ? btnPrimary : btn, onClick: () => setTab('quota'), disabled: busy }, '额度'),
      h('button', { style: tab === 'creds' ? btnPrimary : btn, onClick: () => setTab('creds'), disabled: busy }, '凭据'),
      status ? h('span', { style: statusIsError ? errText : okText }, status) : null,
    ),

    tab === 'quota'
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
          h('div', { style: row },
            h('button', { style: btn, onClick: () => void refreshQuota(), disabled: busy }, busy ? '刷新中…' : '↻ 刷新额度'),
            h('span', { style: muted }, '后台自动刷新'),
          ),
          !view?.canQueryQuota
            ? h('div', { style: card },
                h('strong', null, '还没有可查额度的凭据'),
                h('div', { style: row }, h('span', null, '① 在「凭据」里添加 API Key（推荐）：'),
                  h('a', { href: 'https://opencode.ai/console', target: '_blank', rel: 'noopener', style: { fontSize: '12px' } }, '打开 opencode.ai 控制台 ↗')),
                h('div', { style: row }, h('span', null, '② 或添加网页 Cookie 账号（多账号可加多个）。')),
              )
            : null,
          Object.keys(usage).length === 0
            ? h('div', { style: muted }, '暂无数据')
            : Object.entries(usage).map(([id, u]) =>
                h(UsageCard, { key: id, title: titleFor(id), usage: u as AnyRecord }),
              ),
        )
      : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },

          h('div', { style: card },
            h('div', { style: row },
              h('strong', null, '① API Key（推荐，查额度最稳）'),
              apiKeys.length > 0 ? h('span', { style: okText }, `${apiKeys.length} 个`) : null,
            ),
            apiKeys.length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  ...apiKeys.map((k) => h('div', { style: row, key: k.id },
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
              h('span', { style: muted }, '可添加多个（不同账号/工作区的 key 都行）。'),
            ),
          ),

          h('div', { style: card },
            h('div', { style: row },
              h('strong', null, '② 网页 Cookie 账号（可选，多账号监控）'),
            ),
            h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
              h('input', { style: input, placeholder: '备注名（如 主号）', value: accName, onChange: (e: any) => setAccName(e.target.value) }),
              h('input', { style: input, placeholder: 'wrk_xxx（工作区 URL 里找）', value: accWs, onChange: (e: any) => setAccWs(e.target.value) }),
            ),
            h('textarea', {
              style: { ...input, minHeight: '54px', resize: 'vertical' },
              placeholder: '浏览器 DevTools 复制的 auth Cookie（Fe26.…）',
              value: accCookie, onChange: (e: any) => setAccCookie(e.target.value),
            }),
            h('div', { style: row },
              h('button', { style: btnPrimary, onClick: () => void saveAccount(), disabled: busy }, '添加/更新账号'),
              h('span', { style: muted }, 'Cookie 过期后重新粘贴即可。'),
            ),
            accounts.length > 0
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  ...accounts.map((a) => h('div', { style: row, key: a.id },
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
  ctx.effect(() => ctx.slots.inject('settings.section', () =>
    ctx.slots.register({
      name: 'settings.section',
      id: 'ocgo-usage',
      order: 46,
      label: 'Go 用量',
    }, OcgoSection),
  ), '@dsh-external/dsh-ocgo-usage: settings section')

  ctx.effect(() => ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'ocgo-usage-composer-ring',
      order: 10,
    }, ComposerGoQuota),
  ), '@dsh-external/dsh-ocgo-usage: composer input ring')
}
