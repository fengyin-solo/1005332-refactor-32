import { MODULE_BY_KEY } from './modules'
import { listRows, saveRows } from './local-store'
import type { ActionResult, EntryRow } from './types'

/**
 * 标本修复单的领域规则。
 *
 * 完工（确认完工）与退回（退回重修）历来各写一份判断，容易改一头忘一头；这里只保留
 * 一份实现：两个入口都转调 {@link runRepairTransition}，内容校验共用
 * {@link reviewRepairOrder}，所以同一张修复单从完工入口还是退回入口进来，结论完全一致。
 *
 * 本文件只在「用户新提交一个动作」时做判断与写入，绝不在加载时回算历史数据；老数据里
 * 既有的修复状态、修复结论、异常标记一律照旧。
 */

export const CONSERVE_KEY = 'conserve'
export const ACCEPTANCE_KEY = 'acceptance'

const CONSERVE_META = MODULE_BY_KEY.get(CONSERVE_KEY)

// 修复状态只能沿这张表逐段往下推进，下标相邻才允许流转，中间不许跳级。
const STATUSES: readonly string[] = CONSERVE_META?.statuses ?? ['待修复', '修复中', '已完工', '已退回']
const [STATUS_PENDING, , STATUS_DONE, STATUS_RETURNED] = STATUSES

// 三个动作即三个入口：复工（提交修复）、完工（确认完工）、退回（退回重修）。
export const REPAIR_ACTIONS = {
  start: '提交修复',
  complete: '确认完工',
  return: '退回重修',
} as const

/**
 * 允许在标本修复中使用的材料清单。「使用材料对不对」就按这张表判定；
 * 不在表里的材料（含空值）一律不允许批复完工或退回。
 */
const ALLOWED_MATERIALS = [
  '石膏',
  '石膏粉',
  '环氧树脂',
  '丙烯酸树脂',
  'Paraloid B72',
  'B72',
  '糯米灰浆',
  '乙醇',
  '丙酮',
  '去离子水',
  '棉纸',
  '宣纸',
  '纱布',
  '钛白粉',
  '矿物颜料',
  '蜂蜡',
]

// 完成日期允许的最早边界，早于这个日期视为越界（防误填成早年占位值）。
const MIN_DATE = new Date(1900, 0, 1)

type ReviewResult = { ok: true } | { ok: false; message: string }

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function orderNo(row: EntryRow): string {
  const no = fieldText(row, '修复单号')
  return no ? `「${no}」` : `（编号 ${row.id}）`
}

function reject(message: string): ReviewResult {
  return { ok: false, message }
}

/** 解析 YYYY-MM-DD，非法日历日期（如 2026-02-30）返回 null。 */
function parseDay(value: string): Date | null {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!matched) {
    return null
  }
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null
  }
  return date
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * 修复单批复前的统一审查：完工入口与退回入口共用这一份，不允许各写一套。
 * 四项检查与业务口径一一对应，按顺序返回第一条不通过的原因：
 *   1. 修复单号是不是还在修（已开工、未到已退回终态）；
 *   2. 病害描述、修复措施是否填全；
 *   3. 使用材料对不对（在允许材料清单内）；
 *   4. 完成日期有没有越界（有效日期，不早于下限，不晚于今天）。
 */
export function reviewRepairOrder(row: EntryRow): ReviewResult {
  const no = orderNo(row)
  const status = String(row.status)

  if (status === STATUS_PENDING) {
    return reject(`修复单${no}还停留在「${STATUS_PENDING}」，尚未进入修复，不能批复完工或退回`)
  }
  if (status === STATUS_RETURNED) {
    return reject(`修复单${no}已是「${STATUS_RETURNED}」终态，完工与退回都不能重复批复`)
  }

  const disease = fieldText(row, '病害描述')
  const measure = fieldText(row, '修复措施')
  if (!disease || !measure) {
    return reject(`修复单${no}的病害描述与修复措施没有填全，不能批复`)
  }

  const material = fieldText(row, '使用材料')
  if (!ALLOWED_MATERIALS.includes(material)) {
    return reject(`修复单${no}使用材料「${material || '未填写'}」不在允许使用的修复材料清单内，不能批复`)
  }

  const dateText = fieldText(row, '完成日期')
  const finished = parseDay(dateText)
  if (!finished) {
    return reject(`修复单${no}的完成日期「${dateText || '未填写'}」不是有效日期，不能批复`)
  }
  if (finished.getTime() < MIN_DATE.getTime()) {
    return reject(`修复单${no}的完成日期「${dateText}」早于 1900 年，日期越界`)
  }
  if (finished.getTime() > startOfToday().getTime()) {
    return reject(`修复单${no}的完成日期「${dateText}」晚于今天，日期越界`)
  }

  return { ok: true }
}

/**
 * 同一件器物的修复结论若出现两份且彼此冲突，一律以修复单原单为准：
 * 验收台账只承接修复单派生出来的结论，台账旧值直接被覆盖，也绝不反向回改修复单。
 */
function authoritativeRepairConclusion(row: EntryRow): string {
  return `修复完工合格（据修复单${orderNo(row)}批复，以原单结论为准）`
}

function nextLedgerId(ledger: EntryRow[]): number {
  const ids = ledger.map((row) => Number(row.id)).filter((id) => Number.isFinite(id))
  return (ids.length ? Math.max(...ids) : 0) + 1
}

/**
 * 完工批复回写到验收台账。
 * 以修复单号为幂等键做 upsert：同一张修复单（含重复提交复工后再完工）在台账里始终
 * 只有一条记录，不会因重复点击而留下多条；台账结论一律取修复单原单结论。
 */
function writeCompletionToAcceptanceLedger(order: EntryRow): void {
  const ledger = listRows(ACCEPTANCE_KEY)
  const sourceNo = fieldText(order, '修复单号')
  const existingIndex = ledger.findIndex((row) => fieldText(row, '来源修复单号') === sourceNo)

  const base: EntryRow =
    existingIndex >= 0
      ? { ...ledger[existingIndex] }
      : {
          id: nextLedgerId(ledger),
          status: '待验收',
          pending: true,
          abnormal: false,
        }

  const written: EntryRow = {
    ...base,
    status: '已通过',
    pending: false,
    abnormal: false,
    验收单号: sourceNo ? `ACCE-CONS-${sourceNo.replace(/^[A-Za-z]+-/, '')}` : `ACCE-CONS-${order.id}`,
    验收探方: fieldText(order, '修复对象'),
    验收类别: '标本修复完工',
    验收人: fieldText(order, '修复人'),
    验收日期: fieldText(order, '完成日期'),
    遗留问题数: 0,
    验收结论: authoritativeRepairConclusion(order),
    验收状态: '已通过',
    来源修复单号: sourceNo,
  }

  const nextLedger =
    existingIndex >= 0
      ? ledger.map((row, index) => (index === existingIndex ? written : row))
      : [...ledger, written]
  saveRows(ACCEPTANCE_KEY, nextLedger)
}

/**
 * 修复单流转的唯一实现，复工 / 完工 / 退回三个入口都走这里。
 */
export function runRepairTransition(id: number, action: string): ActionResult {
  if (!CONSERVE_META) {
    return { ok: false, message: '标本修复模块元数据缺失，修复流转不可用' }
  }
  const target = CONSERVE_META.actionTargets[action]
  if (!target) {
    return { ok: false, message: `修复单没有登记「${action}」这个动作` }
  }

  const rows = listRows(CONSERVE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的修复单` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 已经处于目标状态：重复提交复工/完工/退回一律拦下，不新增任何记录。
  if (current === target) {
    return { ok: false, message: `修复单已经是「${target}」，不用重复操作` }
  }

  // 状态只能逐段推进：目标状态必须紧挨当前状态的下一段，跳级（含回退）一律拒绝。
  const currentIndex = STATUSES.indexOf(current)
  const targetIndex = STATUSES.indexOf(target)
  if (currentIndex < 0 || targetIndex !== currentIndex + 1) {
    const via = currentIndex >= 0 && currentIndex + 1 < STATUSES.length ? STATUSES[currentIndex + 1] : target
    return {
      ok: false,
      message: `修复状态只能逐段往下推进：「${current}」不能直接跳到「${target}」，需先到「${via}」`,
    }
  }

  // 复工只是开工，病害/措施/材料/完成日期此时可以还没齐；
  // 完工与退回都调同一份审查，得出的结论不允许两样。
  if (action !== REPAIR_ACTIONS.start) {
    const verdict = reviewRepairOrder(row)
    if (!verdict.ok) {
      return verdict
    }
  }

  const updated: EntryRow = {
    ...row,
    status: target,
    // 待修复、修复中才算待办；已完工、已退回都是办结，pending=false。
    // （完工与退回都是批复结论，不同于其它模块「只有最后一段才算办结」的通用规则。）
    // 退回重修不属于撤销类动作，abnormal 恒为 false。这里只作用于本次动作命中的修复单，
    // 不回改任何历史行。
    pending: target !== STATUS_DONE && target !== STATUS_RETURNED,
    abnormal: false,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(CONSERVE_KEY, nextRows)

  if (action === REPAIR_ACTIONS.complete) {
    writeCompletionToAcceptanceLedger(updated)
  }

  return { ok: true, message: `修复单已${action}，当前状态「${target}」` }
}

// 两个批复入口各自只是薄薄一层，判断全部在 runRepairTransition / reviewRepairOrder 里。
export function completeRepair(id: number): ActionResult {
  return runRepairTransition(id, REPAIR_ACTIONS.complete)
}

export function returnRepair(id: number): ActionResult {
  return runRepairTransition(id, REPAIR_ACTIONS.return)
}

export function resumeRepair(id: number): ActionResult {
  return runRepairTransition(id, REPAIR_ACTIONS.start)
}
