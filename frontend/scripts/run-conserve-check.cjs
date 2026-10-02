/**
 * 修复单领域规则的本地行为检查：纯 Node、无浏览器依赖。
 *
 * 仓库没有引入测试框架，这里用 TypeScript 编译器 API 把 TS 即时转成 CJS，
 * 再用自定义 require 解析 `@/` 路径别名，localStorage 用内存垫片代替。
 *
 * 运行：node scripts/run-conserve-check.cjs
 */
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const vm = require('vm')

const root = path.join(__dirname, '..')
// 缓存 module 对象（不是 exports），键统一去掉 .ts 后缀，避免同一模块被实例化两次。
const cache = new Map()

// localStorage 内存垫片必须在任何数据模块被 require 之前就位：
// local-store 加载时就会读取 window.localStorage。
const memory = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(k, String(v)),
    removeItem: (k) => memory.delete(k),
  },
}

function compile(abs) {
  const source = fs.readFileSync(abs, 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: abs,
  }).outputText
}

function loadTs(rawAbs, stack = []) {
  const abs = path.normalize(rawAbs).replace(/\.ts$/, '')
  if (cache.has(abs)) return cache.get(abs).exports
  if (stack.includes(abs)) throw new Error('循环依赖: ' + abs)

  const fileAbs = abs + '.ts'
  const module = { exports: {} }
  cache.set(abs, module)

  const localRequire = (spec) => {
    let target
    if (spec.startsWith('@/')) target = path.join(root, 'src', spec.slice(2))
    else if (spec.startsWith('./') || spec.startsWith('../')) target = path.resolve(path.dirname(fileAbs), spec)
    else return require(spec)
    if (!/\.(ts|js|cjs|mjs)$/.test(target)) target += '.ts'
    return loadTs(target, [...stack, abs])
  }

  const code = compile(fileAbs)
  const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${code}\n})`
  const fn = vm.runInThisContext(wrapper, { filename: fileAbs })
  fn(module.exports, localRequire, module, fileAbs, path.dirname(fileAbs))
  return module.exports
}

loadTs(path.join(root, 'scripts', 'check-conserve.ts'))
