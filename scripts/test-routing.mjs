/**
 * 路由/正则匹配回归测试：直接加载构建产物 lib/client.js（浏览器 CJS 包装），
 * 用 stub 顶掉 window / react / slots，然后验证纯函数行为。
 *
 * 用法：node scripts/test-routing.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(reg) { registration = reg },
  },
}

const REACT_STUB = {
  createElement: () => null,
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, (id) => {
  if (id === 'react' || id === 'react/jsx-runtime') return REACT_STUB
  throw new Error(`unexpected require(${id})`)
})

if (!registration) throw new Error('client bundle did not register itself')
const mod = registration.factory((id) => {
  if (id === 'react') return REACT_STUB
  throw new Error(`unexpected factory require(${id})`)
})

const { resolveRoute, matchProviderRule, buildRuleCandidates, resolveProviderFromCatalog, validateRules } = mod

// 直接用构建产物导出的默认规则，避免测试与实现漂移
const DEFAULT_RULES = mod.DEFAULT_PROVIDER_RULES

const base = {
  mode: 'auto',
  manualTarget: null,
  providerTargets: { 'opencode-go-native': 'go', agy: 'antigravity:qiyu', agycli: 'antigravity:wym' },
  providerRules: DEFAULT_RULES,
  geminiKeywords: ['gemini', 'tab_flash', 'chat_2'],
  defaultProvider: 'opencode-go-native',
  defaultModel: 'deepseek-v4.1-flash',
}

const cases = [
  {
    name: '选中 opencode-go-native 供应商（无精确绑定，靠正则）→ Go',
    input: { ...base, providerTargets: {}, provider: 'opencode-go-native', model: 'deepseek-v4.1-flash', modelName: 'DeepSeek V4.1 Flash' },
    expect: { engine: 'go' },
  },
  {
    name: '选中 opencode-go-native 的 gemini 模型 → 仍走 Go（opencode 规则先命中）',
    input: { ...base, providerTargets: {}, provider: 'opencode-go-native', model: 'gemini-3-pro', modelName: 'Gemini 3 Pro' },
    expect: { engine: 'go' },
  },
  {
    name: 'agy 供应商 → Antigravity(qiyu)',
    input: { ...base, provider: 'agy', model: 'claude-sonnet-4-5', modelName: 'Claude Sonnet 4.5' },
    expect: { engine: 'antigravity', agyHint: 'qiyu' },
  },
  {
    name: 'agycli 供应商 → Antigravity(wym)（正则优先于 agy 规则）',
    input: { ...base, providerTargets: {}, provider: 'agycli', model: 'gemini-3-pro', modelName: 'Gemini 3 Pro' },
    expect: { engine: 'antigravity', agyHint: 'wym' },
  },
  {
    name: '未知供应商 + Gemini 模型 → 自动识别 Antigravity',
    input: { ...base, providerTargets: {}, providerRules: [], provider: 'nas', model: 'gemini-3-pro', modelName: 'Gemini 3 Pro' },
    expect: { engine: 'antigravity' },
  },
  {
    name: '未知供应商 + 普通模型 → 自动识别 Go',
    input: { ...base, providerTargets: {}, providerRules: [], provider: 'nas', model: 'deepseek-v3', modelName: 'DeepSeek V3' },
    expect: { engine: 'go' },
  },
  {
    name: 'force-go 覆盖一切',
    input: { ...base, mode: 'force-go', provider: 'agy', model: 'gemini-3-pro', modelName: 'Gemini 3 Pro' },
    expect: { engine: 'go' },
  },
  {
    name: '手动切换优先于 force 之外的一切',
    input: { ...base, manualTarget: 'antigravity', provider: 'opencode-go-native', model: 'deepseek-v4.1-flash', modelName: '' },
    expect: { engine: 'antigravity' },
  },
  {
    name: 'Provider Rules 模式下精确绑定命中',
    input: { ...base, mode: 'provider-rule', provider: 'opencode-go-native', model: 'x', modelName: 'X' },
    expect: { engine: 'go' },
  },
  {
    name: '用户自定义正则（优先级按数组顺序，停用规则被跳过）',
    input: {
      ...base,
      providerTargets: {},
      providerRules: [
        { id: 'a', pattern: '^agycli$', target: 'antigravity:wym', enabled: false },
        { id: 'b', pattern: 'agycli', target: 'go', enabled: true },
      ],
      provider: 'agycli',
      model: 'gemini-3-pro',
      modelName: 'Gemini 3 Pro',
    },
    expect: { engine: 'go' },
  },
]

let failed = 0
for (const testCase of cases) {
  const route = resolveRoute(testCase.input)
  const ok = Object.entries(testCase.expect).every(([key, value]) => route[key] === value)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`)
  if (!ok) console.log(`      got ${JSON.stringify(route)} expected ${JSON.stringify(testCase.expect)}`)
}

// ── 候选串与正则引擎单测 ──
const candidates = buildRuleCandidates({ provider: 'opencode-go-native', model: 'deepseek-v4.1-flash', defaultProvider: 'agy', defaultModel: 'claude' })
const candidatesOk = candidates[0] === 'opencode-go-native/deepseek-v4.1-flash'
  && candidates.includes('opencode-go-native')
  && candidates.includes('agy')
console.log(`${candidatesOk ? 'PASS' : 'FAIL'}  候选串构建 ${JSON.stringify(candidates)}`)
if (!candidatesOk) failed += 1

const hit = matchProviderRule(DEFAULT_RULES, ['agy/go-gemini-3-pro'])
const orderOk = hit?.rule?.target === 'antigravity:qiyu'
console.log(`${orderOk ? 'PASS' : 'FAIL'}  正则顺序（agycli 规则不应抢 agy 的命中）`)
if (!orderOk) failed += 1

const invalidOk = validateRules([{ id: 'x', pattern: '(', target: 'go', enabled: true }]) !== ''
  && validateRules([{ id: 'y', pattern: '^opencode', target: 'go', enabled: true }]) === ''
console.log(`${invalidOk ? 'PASS' : 'FAIL'}  非法正则校验`)
if (!invalidOk) failed += 1

const catalogOk = resolveProviderFromCatalog('Gemini 3 Pro', [
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'agy' },
]) === 'agy'
console.log(`${catalogOk ? 'PASS' : 'FAIL'}  模型显示名反查 provider`)
if (!catalogOk) failed += 1

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
