/**
 * 渲染回归测试：用真实 React + react-dom/server 渲染 Tab 2（RoutingTab），
 * 校验正则规则卡片在真实数据下能正常渲染（含非法正则标红分支）。
 *
 * 用法：node scripts/test-render.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'

const REACT_DIR = process.env.REACT_DIR || '/vol1/1000/机械内置/cc-connect/web/node_modules'
const require = createRequire(import.meta.url)

// 用真实 React / react-dom 引擎（仅渲染用，不联网）
const React = require(`${REACT_DIR}/react`)
const { renderToStaticMarkup } = require(`${REACT_DIR}/react-dom/server`)

let registration = null
globalThis.window = { __ModuleLoader__: { load(reg) { registration = reg } } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return require(`${REACT_DIR}/react/jsx-runtime`)
  throw new Error(`unexpected require(${id})`)
})

const mod = registration.factory((id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return require(`${REACT_DIR}/react/jsx-runtime`)
  throw new Error(`unexpected factory require(${id})`)
})

const view = {
  defaultModel: { provider: 'opencode-go-native', model: 'deepseek-v4.1-flash' },
  defaultDisplaySettings: { providerRules: mod.DEFAULT_PROVIDER_RULES },
  displaySettings: { geminiKeywords: ['gemini', 'tab_flash'], providerRules: mod.DEFAULT_PROVIDER_RULES },
  providers: [
    { id: 'agy', name: 'Google Antigravity (agy · qiyu)', modelCount: 20 },
    { id: 'opencode-go-native', name: 'OpenCode Go (native)', modelCount: 42 },
  ],
  models: [
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'opencode-go-native', isGemini: false },
    { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'agy', isGemini: true },
  ],
}

const rules = [
  ...mod.DEFAULT_PROVIDER_RULES,
  { id: 'custom-1', pattern: '(', target: 'go', enabled: false, note: '非法正则样例' },
]

const html = renderToStaticMarkup(
  React.createElement(mod.RoutingTab, {
    view,
    displayMode: 'auto',
    setDisplayMode: () => {},
    providerTargets: { 'opencode-go-native': 'go', agy: 'antigravity:qiyu' },
    setProviderTargets: () => {},
    providerRules: rules,
    setProviderRules: () => {},
    ruleError: '',
    clearRuleError: () => {},
    busy: false,
    saveDisplaySettings: () => {},
  }),
)

const checks = [
  ['渲染出模式卡片', html.includes('智能切源模式选择')],
  ['渲染出精确绑定卡片', html.includes('各供应商显示用量绑定')],
  ['渲染出正则规则卡片', html.includes('供应商正则匹配切换')],
  ['渲染出实时自检', html.includes('实时自检') && html.includes('将显示')],
  ['渲染出三条默认规则 pattern', html.includes('[-_/]opencode') && html.includes('agy[-_.]?cli')],
  [
    '渲染出自定义规则（非法正则标红 + 保留 note 提示）',
    html.includes('value="("')
      && html.includes('title="非法正则样例"')
      && /border-color:rgba\(229,105,122,\.7\)/.test(html),
  ],
  ['渲染出新增加/恢复/保存按钮', html.includes('＋ 新增规则') && html.includes('恢复默认规则') && html.includes('保存正则规则')],
  ['渲染出模型列表卡片（重新编号为 4）', html.includes('4. 系统识别到的模型列表')],
  ['提供 provider 选择项', html.includes('antigravity:wym') && html.includes('OpenCode Go 用量')],
]

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
}

// 预览逻辑：默认落在 opencode-go-native → Go
const goPreview = html.includes('将显示 OpenCode Go')
if (!goPreview) failed += 1
console.log(`${goPreview ? 'PASS' : 'FAIL'}  实时自检预览命中 OpenCode Go`)

// 底栏胶囊：有/无 modelStore 都不应抛错
for (const modelStore of [null, { getSnapshot: () => ({ current: { provider: 'opencode-go-native', model: 'x' } }), subscribe: () => () => {} }]) {
  let ok = true
  try {
    renderToStaticMarkup(React.createElement(mod.ComposerGoQuota, { modelStore }))
  } catch (e) {
    ok = false
    console.log(`      ${e.message}`)
  }
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  底栏胶囊空数据渲染 (modelStore=${modelStore ? 'present' : 'null'})`)
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
