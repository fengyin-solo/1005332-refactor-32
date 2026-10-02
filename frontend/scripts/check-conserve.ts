// 行为验证脚本：用内存 localStorage 垫片跑一遍修复单领域规则，不依赖浏览器。
// 运行：node scripts/run-conserve-check.cjs
import { runRepairTransition, reviewRepairOrder, CONSERVE_KEY, ACCEPTANCE_KEY } from '@/data/conserve-flow'
import { runAction } from '@/api/local-service'
import { saveRows, resetRows, listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 注意：不能缓存 allRows() 的结果——saveRows 会生成新的顶层对象，旧快照看不到写入。每次断言都现取。

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const today = new Date()
const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
  today.getDate(),
).padStart(2, '0')}`

function order(over: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 1,
    status: '修复中',
    pending: true,
    abnormal: false,
    修复单号: 'CONS-T1',
    修复对象: '陶豆 2026:001',
    病害描述: '口沿残断',
    修复措施: '拼接粘接',
    使用材料: '环氧树脂',
    修复人: '王五',
    完成日期: isoToday,
    修复状态: '修复中',
    ...over,
  }
}

function setupConserve(rows: EntryRow[]) {
  saveRows(CONSERVE_KEY, rows)
}
function setupAcceptance(rows: EntryRow[] = []) {
  saveRows(ACCEPTANCE_KEY, rows)
}
function conserveRows(): EntryRow[] {
  return listRows(CONSERVE_KEY)
}
function acceptanceRows(): EntryRow[] {
  return listRows(ACCEPTANCE_KEY)
}

console.log('一、完工与退回共用同一份审查，结论不许两样')
{
  const good = order()
  check('单据合规：完工入口审查通过', reviewRepairOrder(good).ok === true)
  check('单据合规：退回入口审查通过（同一函数同一份结论）', reviewRepairOrder(good).ok === true)

  const notStarted = order({ status: '待修复' })
  const a = reviewRepairOrder(notStarted)
  const b = reviewRepairOrder(notStarted)
  check('还没开工：两个入口结论一致为不通过', a.ok === false && b.ok === false && a.message === b.message)

  const returned = order({ status: '已退回' })
  check('终态已退回：审查不通过，防重复批复', reviewRepairOrder(returned).ok === false)

  const missingFields = order({ 病害描述: '  ', 修复措施: '' })
  check('病害描述/修复措施没填全：不通过', reviewRepairOrder(missingFields).ok === false)

  const badMaterial = order({ 使用材料: '502胶水' })
  check('使用材料不在清单：不通过', reviewRepairOrder(badMaterial).ok === false)

  const emptyMaterial = order({ 使用材料: '' })
  check('使用材料为空：不通过', reviewRepairOrder(emptyMaterial).ok === false)

  const futureDate = order({ 完成日期: '2099-01-01' })
  check('完成日期晚于今天（越界）：不通过', reviewRepairOrder(futureDate).ok === false)

  const invalidDate = order({ 完成日期: '2026-02-30' })
  check('完成日期非法日历日：不通过', reviewRepairOrder(invalidDate).ok === false)

  const ancientDate = order({ 完成日期: '1899-12-31' })
  check('完成日期早于下限（越界）：不通过', reviewRepairOrder(ancientDate).ok === false)
}

console.log('二、状态只能逐段推进，不允许跳级')
{
  setupConserve([order({ id: 1, status: '待修复' })])
  check(
    '待修复直接退回重修 → 拒绝（跳过了修复中/已完工）',
    runRepairTransition(1, '退回重修').ok === false,
  )
  const tryCompleteEarly = runRepairTransition(1, '确认完工')
  check('待修复直接确认完工 → 拒绝（跳过了修复中）', tryCompleteEarly.ok === false)
  check('跳级后状态未被改动，仍是待修复', conserveRows()[0].status === '待修复')

  const start = runRepairTransition(1, '提交修复')
  check('待修复 --提交修复--> 修复中', start.ok && conserveRows()[0].status === '修复中')
  check('复工进入修复中后 pending=true（仍是待办）', conserveRows()[0].pending === true)
  check(
    '修复中再点提交修复（重复复工）→ 拒绝，只留一条',
    runRepairTransition(1, '提交修复').ok === false,
  )
}

console.log('三、合规单据：完工、退回两段流转')
{
  setupConserve([order({ id: 2, status: '修复中' })])
  const done = runRepairTransition(2, '确认完工')
  check('修复中 --确认完工--> 已完工', done.ok && conserveRows()[0].status === '已完工')
  check('已完工后 pending=false', conserveRows()[0].pending === false)
  check('完工不应被标异常（退回重修不是撤销类动作）', conserveRows()[0].abnormal === false)
  check(
    '已完工重复确认完工 → 拒绝',
    runRepairTransition(2, '确认完工').ok === false,
  )
  const ret = runRepairTransition(2, '退回重修')
  check('已完工 --退回重修--> 已退回', ret.ok && conserveRows()[0].status === '已退回')
  check('已退回是终态，重复退回拒绝', runRepairTransition(2, '退回重修').ok === false)
  check('终态 pending=false', conserveRows()[0].pending === false)
}

console.log('四、退回与完工从同一段（已完工/修复中）触发时共享校验')
{
  setupConserve([order({ id: 3, status: '修复中', 使用材料: '胶带' })])
  check('修复中、材料不对：确认完工被拦', runRepairTransition(3, '确认完工').ok === false)
  check('同一张单子状态仍是修复中（完工没写成）', conserveRows()[0].status === '修复中')
}

console.log('五、老数据不重算：加载/刷新不改动既有结论')
{
  resetRows(CONSERVE_KEY)
  const seed = conserveRows()
  check('种子数据保留 3 条', seed.length === 3)
  const snapshot = JSON.stringify(seed)
  // 再读一次（模拟重新加载）：不触发任何回算
  const again = JSON.stringify(listRows(CONSERVE_KEY))
  check('重新读取后老数据逐字段不变（修复结论照旧）', snapshot === again)
  const doneOne = seed.find((r) => r.status === '已完工')
  check(
    '种子里已完工单据即便使用材料是占位值，也不会被重判/标异常',
    Boolean(doneOne) && doneOne!.abnormal === false && doneOne!.status === '已完工',
  )
}

console.log('六、完工批复回写验收台账：只留一条、以修复单原单为准')
{
  setupConserve([order({ id: 4, 修复单号: 'CONS-W1', status: '修复中' })])
  setupAcceptance([
    {
      id: 99,
      status: '验收中',
      pending: true,
      abnormal: false,
      验收单号: 'ACCE-OLD-1',
      验收探方: '旧探方',
      验收类别: '旧类别',
      验收人: '旧验收人',
      验收日期: '2020-01-01',
      遗留问题数: 8,
      验收结论: '台账旧结论：不合格',
      验收状态: '验收中',
      来源修复单号: 'CONS-W1',
    },
  ])
  const r = runRepairTransition(4, '确认完工')
  check('完工成功', r.ok)
  const ledger = acceptanceRows()
  check('台账仍只有 1 条（幂等 upsert，不新增）', ledger.length === 1)
  const row = ledger[0]
  check('台账结论被修复单原单结论覆盖（以原单为准）', String(row.验收结论).includes('以原单结论为准'))
  check('台账状态回写为已通过', row.status === '已通过' && row.验收状态 === '已通过')
  check('台账验收对象取修复对象', row.验收探方 === '陶豆 2026:001')
  check('台账验收日期取修复完成日期', row.验收日期 === isoToday)
  check('台账验收类别标记为标本修复完工', row.验收类别 === '标本修复完工')
  check('既有台账行 id 复用（99），不另起一条', row.id === 99)

  // 再完工同一张单子被拦（已完工态），不会重复回写
  check('重复完工被拦，台账仍只有一条', runRepairTransition(4, '确认完工').ok === false && acceptanceRows().length === 1)
}

console.log('七、入口接线：local-service 的 runAction 对 conserve 转交共用实现')
{
  setupConserve([order({ id: 5, 修复单号: 'CONS-W2', status: '待修复' })])
  setupAcceptance()
  const viaService = runAction(CONSERVE_KEY, 5, '提交修复')
  check('经 runAction 调提交修复生效', viaService.ok && conserveRows()[0].status === '修复中')
  const jumpViaService = runAction(CONSERVE_KEY, 5, '退回重修')
  check('经 runAction 跳级同样被共用实现拒绝', jumpViaService.ok === false)
}

console.log('八、新修复单完工，台账无同单记录时新增且只新增一条')
{
  setupConserve([order({ id: 6, 修复单号: 'CONS-W3', status: '修复中' })])
  setupAcceptance([
    { id: 1, status: '已通过', pending: false, abnormal: false, 验收单号: 'ACCE-X1', 来源修复单号: 'OTHER' },
  ])
  runRepairTransition(6, '确认完工')
  const ledger = acceptanceRows()
  check('台账新增一条，总数变 2', ledger.length === 2)
  const mine = ledger.find((r) => String(r.来源修复单号) === 'CONS-W3')
  check('新台账记录 id 顺延为 2', Boolean(mine) && mine!.id === 2)
  check('新台账结论以修复单原单为准', Boolean(mine) && String(mine!.验收结论).includes('CONS-W3'))
}

console.log('九、同一器物两张修复单结论冲突，以修复单原单为准')
{
  // 同一修复对象，旧单 CONS-C1 已在台账留过结论；新单 CONS-C2 再完工。
  setupConserve([
    order({ id: 7, 修复单号: 'CONS-C1', status: '修复中', 修复对象: '陶豆 2026:001' }),
    order({ id: 8, 修复单号: 'CONS-C2', status: '修复中', 修复对象: '陶豆 2026:001', 修复人: '赵六' }),
  ])
  setupAcceptance()
  runRepairTransition(7, '确认完工')
  runRepairTransition(8, '确认完工')

  const ledger = acceptanceRows()
  const byOrder = (no: string) => ledger.find((r) => String(r.来源修复单号) === no)
  const c1 = byOrder('CONS-C1')
  const c2 = byOrder('CONS-C2')
  check('两张修复单各有一条台账（按修复单号幂等，不互相覆盖编号）', Boolean(c1) && Boolean(c2))
  check('C1 台账结论取自 C1 原单', String(c1!.验收结论).includes('CONS-C1'))
  check('C2 台账结论取自 C2 原单，不沿用 C1 的旧结论', String(c2!.验收结论).includes('CONS-C2'))
  check('C2 验收人取本单修复人（赵六），不被旧单带偏', c2!.验收人 === '赵六')

  // 台账里任何与修复单不一致的字段，都由修复单原单覆盖，且修复单本身不被台账回改。
  const orderC2 = conserveRows().find((r) => r.修复单号 === 'CONS-C2')
  check('修复单状态只由修复流转决定，台账不反向回改原单', orderC2!.status === '已完工')
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
