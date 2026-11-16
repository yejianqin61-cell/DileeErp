/**
 * 分诊：把一句人话变成「能不能开工」的判定。
 *
 * 为什么必须是纯函数：分诊判错是这套系统最贵的错误 —— 判「能开工」会让 Agent 去改不该改的东西，
 * 判「太含糊」会让用户觉得机器人没用。所以它必须能用固定语料反复回归，
 * 而不是每次跑一遍模型才知道对不对。
 *
 * 这里**不调模型**。规则先做到能覆盖已知的历史缺陷说法；
 * 覆盖率不够时再加模型兜底，兜底也必须能在测试里用假模型复现。
 */

import type { TriageMissingField, TriageResult } from './ticket-state.ts'

/** 模块关键词 → 规范模块名。命中即认为识别出了模块。 */
const MODULE_KEYWORDS: ReadonlyArray<{ module: string; words: readonly string[] }> = [
  { module: 'sales', words: ['销售', '销售单', '报价', '客户', '订单'] },
  { module: 'procurement', words: ['采购', '供应商', '到货', '进货'] },
  { module: 'production', words: ['生产', '工序', '排产', '日报', '计件', '工资'] },
  { module: 'qc', words: ['质检', '检验', '不合格', '来料检', '成品质检'] },
  { module: 'warehouse', words: ['仓库', '库存', '入库', '出库', '盘点', '原料仓'] },
  { module: 'finance', words: ['财务', '应收', '应付', '收款', '付款', '凭证', '科目', '流水'] },
  { module: 'hr', words: ['人事', '员工', '考勤', '岗位', '部门', '薪资'] },
  { module: 'reports', words: ['报表', '导出', '汇总', '统计'] },
  { module: 'reorder', words: ['补货', '再订货', '安全库存'] },
]

/**
 * 期望行为的信号词：用户**明确表达了想要什么**。
 *
 * 刻意不含「报错 / 不对 / 打不开 / 失败」这类**症状**词。
 * 症状说明哪里坏了，但不说明要变成什么样 —— 把症状当期望，
 * 会让分诊误以为已经说清目标，于是 Agent 开工却不知道要做什么。
 *
 * 分两类：
 *   - 意愿句式：应该 / 希望 / 能不能 …
 *   - 动作动词：新建 / 删除 / 改成 / 实现 / 修复 …
 * 第二类是端到端测试逼出来的：真实需求经常直接下指令（「新建一个文件…提交」），
 * 没有“应该”这种句式。只认意愿句式会把合法任务判成含糊。
 */
const EXPECTATION_MARKERS: readonly string[] = [
  // 意愿句式
  '应该', '希望', '要能', '能不能', '建议', '需要', '请',
  // 动作动词
  '新建', '创建', '增加', '添加', '加一个', '加个', '去掉', '删除', '移除',
  '改成', '改为', '修改', '实现', '修复', '修一下', '优化', '调整',
  '替换', '重命名', '移动到', '挪到', '补齐', '接入', '支持', '排序', '筛选',
  '搜索', '导出', '导入', '显示', '默认', '写', '提交',
]

/** 症状词：只用于区分缺陷与需求，不参与「期望是否说清」的判定。 */
const SYMPTOM_MARKERS: readonly string[] = [
  '不能', '无法', '打不开', '报错', '错了', '不对', '丢了', '重复',
  '崩溃', '异常', '失败', '没反应', '卡住', '很慢',
]

/** 复现入口的信号：页面名、路径、单据类型。 */
const ENTRY_MARKERS: readonly string[] = [
  '/', '页面', '页', '菜单', '列表', '详情', '弹窗', '对话框', '首页', '工作台',
]

/**
 * 判定一句话是「缺陷」还是「新需求」。
 * 缺陷偏向「本来该对但不对」，需求偏向「希望多一个能力」。
 * 这个区分不决定是否开工（两者都开工），只决定卡片标题措辞。
 */
const REQUEST_MARKERS: readonly string[] = ['希望', '增加', '支持', '加一个', '加个', '能不能', '建议', '改成']

export type TicketKind = 'defect' | 'request'

export function classifyKind(text: string): TicketKind {
  const hitsDefect = SYMPTOM_MARKERS.filter((marker) => text.includes(marker)).length
  const hitsRequest = REQUEST_MARKERS.filter((marker) => text.includes(marker)).length
  // 平票或都没命中时按缺陷处理：缺陷漏判比需求漏判代价高。
  return hitsRequest > hitsDefect ? 'request' : 'defect'
}

function detectModule(text: string): string | null {
  let best: { module: string; index: number } | null = null
  for (const { module, words } of MODULE_KEYWORDS) {
    for (const word of words) {
      const index = text.indexOf(word)
      if (index < 0) continue
      // 取最早出现的那个模块：用户通常先说「采购单」，再说具体字段。
      if (best === null || index < best.index) best = { module, index }
    }
  }
  return best?.module ?? null
}

function detectExpected(text: string): string | null {
  for (const marker of EXPECTATION_MARKERS) {
    const index = text.indexOf(marker)
    if (index < 0) continue
    // 取信号词所在的那一段，截到句末标点，这样卡片能引用原话而不是复述。
    const rest = text.slice(index)
    const end = rest.search(/[。！？；\n]/)
    const phrase = (end >= 0 ? rest.slice(0, end) : rest).trim()
    if (phrase.length >= 2) return phrase
  }
  return null
}

function detectEntry(text: string): string | null {
  // 显式路径优先
  const path = /\/[a-z0-9-]+(?:\/[a-z0-9-]+)*/i.exec(text)
  if (path) return path[0]

  for (const marker of ENTRY_MARKERS) {
    const index = text.indexOf(marker)
    if (index < 0) continue
    // 往前取一小段作为页面名，例如「采购单列表页」→「采购单列表」
    const start = Math.max(0, index - 6)
    const phrase = text.slice(start, index + marker.length).trim()
    if (phrase.length >= 2) return phrase
  }
  return null
}

/**
 * 分诊主函数。
 *
 * `text` 必须是去掉 @机器人 占位符之后的内容。占位符形如 `@_user_1`，
 * 留在里面会让模块识别和摘要都带上噪声。
 */
export function triage(text: string): TriageResult {
  const clean = text.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim()

  const module = detectModule(clean)
  const expected = detectExpected(clean)
  const entry = detectEntry(clean)

  const missing: TriageMissingField[] = []
  // 只有「期望」阻塞开工。
  // 模块与入口是尽力识别：识别不出就留给 Agent 读代码判断，
  // 但「要变成什么样」猜不出来，必须问。
  // 这条是端到端测试逼出来的：「新建文件 X 内容 Y」原本因缺入口被判含糊，
  // 而改后端、改脚本、加任务本来就没有页面入口。
  if (expected === null) missing.push('expected')

  const kind = classifyKind(clean)
  // 摘要限长：卡片标题有长度限制，且过长会截断成看不懂的样子。
  const head = clean.length > 40 ? `${clean.slice(0, 40)}…` : clean
  const summary = missing.length === 0
    ? `${kind === 'defect' ? '缺陷' : '需求'}｜${module ?? '未识别模块'}｜${head}`
    : `待补充｜${head}`

  return { module, expected, entry, missing, summary }
}

/**
 * 生成追问话术。
 *
 * 说清「缺什么」而不是「请描述清楚」：后者用户不知道要补什么，只会再发一句差不多的话。
 * 数量按实际缺项变：只缺一项时说「补两点」会让用户以为还有第二项没看到。
 */
export function askForMissing(missing: readonly TriageMissingField[]): string {
  const hints: Record<TriageMissingField, string> = {
    module: '哪个模块或页面（例如：采购单列表页）',
    expected: '你希望它变成什么样（例如：应该按单号倒序）',
    entry: '怎么复现（例如：点开采购单列表就能看到）',
  }
  const lines = missing.map((field, index) => `${index + 1}. ${hints[field]}`)
  const lead = missing.length <= 1 ? '这条我还不够开工，麻烦补一点：' : '这条我还不够开工，麻烦补两点：'
  return `${lead}\n${lines.join('\n')}\n直接再发一条消息补充就行。`
}
