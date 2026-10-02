import type { EntryRow } from './types'

// 标本修复的完工与退回共用同一份判定：修复单状态逐段推进，完工批复回写验收台账。
// 这里只做纯数据判定，不碰 localStorage，方便两个入口复用、也方便单独验证。

export const CONSERVE_KEY = 'conserve'
export const ACCEPTANCE_KEY = 'acceptance'

// 修复状态只能逐段往下走：待修复 → 修复中 → 已完工 → 已退回，中间不许跳级。
export const REPAIR_STATUSES = ['待修复', '修复中', '已完工', '已退回'] as const
export type RepairStatus = (typeof REPAIR_STATUSES)[number]
export const RETURNED_STATUS: RepairStatus = '已退回'

// 每个动作只允许从上一个相邻状态进入；已退回是终态，复工一律拒绝。
export const REPAIR_ACTIONS = ['提交修复', '确认完工', '退回重修'] as const
export type RepairAction = (typeof REPAIR_ACTIONS)[number]
const ACTION_TARGET: Record<RepairAction, RepairStatus> = {
  提交修复: '修复中',
  确认完工: '已完工',
  退回重修: '已退回',
}
const ACTION_PREDECESSOR: Record<RepairAction, RepairStatus> = {
  提交修复: '待修复',
  确认完工: '修复中',
  退回重修: '已完工',
}

// 还在修复流程内：没走到「已退回」终态就算。完工与退回复核的是同一条标准。
const IN_FLOW_STATUSES: RepairStatus[] = ['待修复', '修复中', '已完工']

// 准许使用的修复材料：使用材料必须逐样落在清单内，别名先归一再比对。
const MATERIAL_ALIASES: Record<string, string> = {
  B72: 'B72树脂',
  PVA: '聚乙烯醇',
}
const ALLOWED_MATERIALS = [
  '石膏',
  '环氧树脂',
  'B72树脂',
  '丙酮',
  '无水乙醇',
  '聚乙烯醇',
  '三甲树脂',
  '蜂蜡',
  '虫胶',
]
const MATERIAL_SPLITTERS = /[、,，;；/／\n]+/

// 完成日期的合法区间：早于项目建账或晚于今天都算越界（今天以动作发生日传入）。
const MIN_COMPLETE_DATE = '2000-01-01'

export type RepairReview = {
  pass: boolean
  problems: string[]
}

function textOf(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function splitMaterials(value: string): string[] {
  return value
    .split(MATERIAL_SPLITTERS)
    .map((item) => item.trim())
    .filter(Boolean)
}

// 材料名归一：去空格、按别名折到标准名。
function normalizeMaterial(name: string): string {
  const compact = name.replace(/\s+/g, '')
  return MATERIAL_ALIASES[compact] ?? compact
}

function checkMaterials(row: EntryRow): string | null {
  const raw = textOf(row, '使用材料')
  if (!raw) {
    return '使用材料未填写'
  }
  const illegal = splitMaterials(raw)
    .map(normalizeMaterial)
    .filter((name) => !ALLOWED_MATERIALS.includes(name))
  if (illegal.length > 0) {
    return `使用材料不在准许清单内：${illegal.join('、')}`
  }
  return null
}

function checkCompleteDate(row: EntryRow, today: string): string | null {
  const value = textOf(row, '完成日期')
  if (!value) {
    return '完成日期未填写'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `完成日期格式不合法（应为 YYYY-MM-DD）：${value}`
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return `完成日期不是有效日期：${value}`
  }
  if (value > today) {
    return `完成日期晚于动作日期（${today}），日期越界：${value}`
  }
  if (value < MIN_COMPLETE_DATE) {
    return `完成日期早于建账日期（${MIN_COMPLETE_DATE}），日期越界：${value}`
  }
  return null
}

// 完工与退回唯一共用的复核：单据是否仍在修复流程、病害描述与修复措施是否填全、
// 使用材料对不对、完成日期是否越界。两条路径得出的问题清单必然一致。
export function evaluateRepairOrder(row: EntryRow, today: string): RepairReview {
  const problems: string[] = []
  const status = textOf(row, 'status')
  if (!IN_FLOW_STATUSES.includes(status as RepairStatus)) {
    problems.push(`修复单${textOf(row, '修复单号') || ''}已走到「${status || '未知状态'}」，不在修复流程内`)
  }
  if (!textOf(row, '病害描述')) {
    problems.push('病害描述未填写')
  }
  if (!textOf(row, '修复措施')) {
    problems.push('修复措施未填写')
  }
  const materialProblem = checkMaterials(row)
  if (materialProblem) {
    problems.push(materialProblem)
  }
  const dateProblem = checkCompleteDate(row, today)
  if (dateProblem) {
    problems.push(dateProblem)
  }
  return { pass: problems.length === 0, problems }
}

export type RepairVerdict = '完工' | '退回'
export const VERDICT_LABEL: Record<RepairVerdict, string> = {
  完工: '修复合格，准予完工',
  退回: '修复不合格，退回重修（以修复单原单为准）',
}
const LEDGER_STATUS_BY_VERDICT: Record<RepairVerdict, string> = {
  完工: '已通过',
  退回: '已整改',
}

function verdictOf(row: EntryRow): RepairVerdict | null {
  if (textOf(row, 'status') === '已完工') {
    return '完工'
  }
  if (textOf(row, 'status') === '已退回') {
    return '退回'
  }
  return null
}

// 同一件器物的多份修复结论按修复单号最早的原单裁决，单号相同再比记录编号。
export function resolveArtifactVerdict(orders: EntryRow[], objectName: string): {
  verdict: RepairVerdict
  sourceOrder: EntryRow
} | null {
  const decided = orders
    .filter((row) => textOf(row, '修复对象') === objectName && verdictOf(row) !== null)
    .sort((a, b) => {
      const byOrderNo = textOf(a, '修复单号').localeCompare(textOf(b, '修复单号'), 'zh-Hans-CN')
      return byOrderNo !== 0 ? byOrderNo : Number(a.id) - Number(b.id)
    })
  const sourceOrder = decided[0]
  if (!sourceOrder) {
    return null
  }
  return { verdict: verdictOf(sourceOrder) as RepairVerdict, sourceOrder }
}

// 验收台账字段：回写时只按「修复对象 + 标本修复类别」认一条，重复批复不新增。
export const CONSERVE_LEDGER_CATEGORY = '标本修复'
const LEDGER_FIELDS = [
  '验收单号',
  '验收探方',
  '验收类别',
  '验收人',
  '验收日期',
  '遗留问题数',
  '验收结论',
  '验收状态',
  '来源修复单号',
]

function nextLedgerId(ledger: EntryRow[]): number {
  return ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function buildLedgerPatch(params: {
  order: EntryRow
  verdict: RepairVerdict
  today: string
}): Partial<EntryRow> {
  const { order, verdict, today } = params
  return {
    验收探方: textOf(order, '修复对象'),
    验收类别: CONSERVE_LEDGER_CATEGORY,
    验收人: textOf(order, '修复人') || '—',
    验收日期: today,
    遗留问题数: verdict === '完工' ? '0' : '1',
    验收结论: VERDICT_LABEL[verdict],
    验收状态: LEDGER_STATUS_BY_VERDICT[verdict],
    来源修复单号: textOf(order, '修复单号'),
  }
}

// 把修复结论 upsert 进验收台账：同一器物同一类别始终只保留一条记录。
// 若同器物存在多份相悖结论，以修复单号最早的原单为准覆盖。
export function syncAcceptanceLedger(params: {
  ledger: EntryRow[]
  orders: EntryRow[]
  order: EntryRow
  currentVerdict: RepairVerdict
  today: string
}): { ledger: EntryRow[]; conflictWith: EntryRow | null } {
  const { ledger, orders, order, currentVerdict, today } = params
  const objectName = textOf(order, '修复对象')
  const authoritative = resolveArtifactVerdict(orders, objectName)
  const verdict = authoritative?.verdict ?? currentVerdict
  const conflictWith =
    authoritative && authoritative.verdict !== currentVerdict ? authoritative.sourceOrder : null
  const patch = buildLedgerPatch({ order: authoritative?.sourceOrder ?? order, verdict, today })

  const index = ledger.findIndex(
    (row) =>
      textOf(row, '验收探方') === objectName &&
      textOf(row, '验收类别') === CONSERVE_LEDGER_CATEGORY,
  )
  if (index >= 0) {
    const next = [...ledger]
    next[index] = { ...next[index], ...patch, status: LEDGER_STATUS_BY_VERDICT[verdict], pending: false, abnormal: false }
    return { ledger: next, conflictWith }
  }

  const id = nextLedgerId(ledger)
  const created: EntryRow = {
    id,
    status: LEDGER_STATUS_BY_VERDICT[verdict],
    pending: false,
    abnormal: false,
    验收单号: `ACCE-${String(id).padStart(4, '0')}`,
    ...patch,
  }
  return { ledger: [...ledger, created], conflictWith }
}

export type RepairActionResult = {
  ok: boolean
  message: string
  orders: EntryRow[]
  ledger: EntryRow[]
}

// 修复单动作的唯一实现入口，「确认完工」「退回重修」都走这里，
// 校验与结论只此一份，两个入口不可能得出两样结论。
export function applyRepairAction(params: {
  orders: EntryRow[]
  ledger: EntryRow[]
  orderId: number
  action: RepairAction
  today: string
}): RepairActionResult {
  const { orders, ledger, orderId, action, today } = params
  const index = orders.findIndex((row) => Number(row.id) === Number(orderId))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${orderId} 的修复单`, orders, ledger }
  }
  if (!REPAIR_ACTIONS.includes(action)) {
    return { ok: false, message: `修复单没有登记「${action}」这个动作`, orders, ledger }
  }

  const order = orders[index]
  const orderNo = textOf(order, '修复单号')
  const current = textOf(order, 'status')
  const target = ACTION_TARGET[action]

  // 重复提交（含重复复工、重复完工、重复退回）幂等拒绝，状态与台账都不再多记一条。
  if (current === target) {
    return {
      ok: false,
      message: `修复单${orderNo ? `「${orderNo}」` : ''}已经是「${target}」，无需重复提交`,
      orders,
      ledger,
    }
  }

  // 复工只在待修复受理；已退回是终态，不允许复工。
  if (action === '提交修复' && current === RETURNED_STATUS) {
    return {
      ok: false,
      message: `修复单${orderNo ? `「${orderNo}」` : ''}已退回，流程终结，不能再提交复工`,
      orders,
      ledger,
    }
  }

  // 完工与退回共用同一份四项复核；两条路径的结论同源。
  if (action !== '提交修复') {
    const review = evaluateRepairOrder(order, today)
    if (!review.pass) {
      return {
        ok: false,
        message: `修复单${orderNo ? `「${orderNo}」` : ''}不能${action}：${review.problems.join('；')}`,
        orders,
        ledger,
      }
    }
  }

  // 状态逐段推进：只允许从相邻的上一段进入，杜绝跳级。
  const predecessor = ACTION_PREDECESSOR[action]
  if (current !== predecessor) {
    return {
      ok: false,
      message: `修复状态只能逐段推进，「${action}」要求当前为「${predecessor}」，当前是「${current || '未知状态'}」，不能跳级`,
      orders,
      ledger,
    }
  }

  const updated: EntryRow = {
    ...order,
    status: target,
    pending: action === '提交修复',
    abnormal: false,
  }
  const nextOrders = [...orders]
  nextOrders[index] = updated

  // 走到终态（完工/退回）的批复回写验收台账；修复中不回写。
  let nextLedger = ledger
  if (action === '确认完工' || action === '退回重修') {
    const verdict: RepairVerdict = action === '确认完工' ? '完工' : '退回'
    const synced = syncAcceptanceLedger({
      ledger,
      orders: nextOrders,
      order: updated,
      currentVerdict: verdict,
      today,
    })
    nextLedger = synced.ledger
    const conflictNote = synced.conflictWith
      ? `；该器物另有修复单「${textOf(synced.conflictWith, '修复单号')}」结论相悖，已按原单结论回写台账`
      : ''
    return {
      ok: true,
      message: `修复单「${orderNo}」已${action}，当前状态「${target}」，批复已回写验收台账${conflictNote}`,
      orders: nextOrders,
      ledger: nextLedger,
    }
  }

  return {
    ok: true,
    message: `修复单「${orderNo}」已${action}，当前状态「${target}」`,
    orders: nextOrders,
    ledger: nextLedger,
  }
}

// 供导出/调试使用：台账回写时涉及的字段清单。
export const CONSERVE_LEDGER_FIELDS = LEDGER_FIELDS
