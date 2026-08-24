// 本插件只把 React 当运行时外部依赖使用（tsdown externals），类型面从宽处理：
// 页面侧由 ModuleLoader 注入真实 React，这里仅声明模块存在以通过 tsc。
declare module 'react'
