import assert from 'node:assert/strict'
import test from 'node:test'

import { triage, askForMissing, classifyKind } from '../src/triage.ts'

/**
 * 分诊必须能覆盖仓库里真实出现过的缺陷说法。
 * 语料取自 docs/log 与 docs/design 里用户的原话，不自己编。
 */

test('完整的一句话：模块/期望/入口 三项都识别出来', () => {
  const result = triage(
    '@_user_1 采购单列表页的搜索框，希望能按供应商名称搜，现在按供应商搜不到',
  )
  assert.equal(result.module, 'procurement')
  assert.equal(result.entry, '采购单列表页')
  assert.ok(result.expected !== null, 'expected 应被识别')
  assert.deepEqual(result.missing, [])
})

test('去掉 @占位符后再判断，占位符不参与模块识别', () => {
  const result = triage('@_user_1 @_user_2 销售单导出报错')
  // 占位符被清掉后，仍然能靠「销售单」识别模块
  assert.equal(result.module, 'sales')
  assert.ok(!result.summary.includes('@_user_'))
})

test('只说「坏了」：判为待补充，缺的是「期望」', () => {
  const result = triage('这个不对')
  // 只有「期望」阻塞开工：模块和入口识别不出可以留给 Agent 判断，
  // 但「要变成什么样」猜不出来，必须问。
  assert.deepEqual(result.missing, ['expected'])
  assert.equal(result.module, null)
  assert.ok(result.summary.startsWith('待补充'))
})

test('缺入口不影响开工：改后端/脚本本来就没有页面入口', () => {
  const result = triage('财务的应收账款希望能按客户排序')
  assert.equal(result.module, 'finance')
  assert.ok(result.expected !== null)
  // 入口缺失不再阻塞
  assert.deepEqual(result.missing, [])
  assert.equal(result.entry, null)
})

test('工程类指令可直接开工，不因缺「应该」句式被拦', () => {
  // 这条来自端到端测试的真实失败：原规则只认“应该/希望”，
  // 把「新建文件…提交」判成含糊。
  const result = triage(
    '在仓库根目录新建一个文件 AGENT_SMOKE.md，内容只写一行：agent e2e ok。然后 git add 并 commit。',
  )
  assert.ok(result.expected !== null, '动作动词应算作已说清期望')
  assert.deepEqual(result.missing, [])
})

test('缺入口时不再追问：入口缺失不阻塞', () => {
  const result = triage('财务的应收账款希望能按客户排序')
  assert.equal(result.module, 'finance')
  assert.ok(result.expected !== null)
  assert.deepEqual(result.missing, [], '入口缺失不应阻塞开工')
})

test('「应收列表」的「列表」被识别为入口，不是缺失', () => {
  const result = triage('财务的应收列表希望能按客户排序')
  assert.equal(result.entry, '财务的应收列表')
  assert.deepEqual(result.missing, [])
})

test('真实缺陷语料：BOM 表搜索', () => {
  const result = triage(
    '需要在生产和采购模块的BOM表页面加上搜索功能',
  )
  // 「生产」出现在前面，按最早命中的规则判为 production
  assert.equal(result.module, 'production')
  assert.ok(result.expected !== null)
  assert.ok(result.entry !== null)
})

test('症状 + 动作词：可开工，但安全网在 prompt 的「先复述计划」', () => {
  // 这句话的原意是「导入失败，我希望它能成功」，动作词「导入」命中，故可开工。
  // 风险是 Agent 可能改错层；对应的安全网不是分诊，而是 prompt 里强制的
  // 「第一步先复述你打算改哪些文件，然后再动手」—— 人能在复述那一步发现方向不对。
  const result = triage('销售单页面导入 Excel，1.5MB 的文件提示读取失败')
  assert.equal(result.module, 'sales')
  assert.ok(result.expected !== null)
  assert.deepEqual(result.missing, [])
})

test('纯症状、无任何动作词：仍然追问期望', () => {
  // 没有任何「想改成什么」的线索，必须问
  const result = triage('采购单页面卡住不动了')
  assert.equal(result.module, 'procurement')
  assert.deepEqual(result.missing, ['expected'])
})

test('真实缺陷语料：退回只能整单退', () => {
  const result = triage('采购单详情页，改一行要退一整单，希望能按行退回')
  assert.equal(result.module, 'procurement')
  assert.equal(result.entry, '采购单详情页')
  assert.ok(result.expected !== null)
})

test('路径形式的入口优先于页面名', () => {
  const result = triage('/procurement/boms 页面的搜索框没反应，应该能搜物料')
  assert.equal(result.entry, '/procurement/boms')
})

test('缺陷与需求的区分', () => {
  assert.equal(classifyKind('导出报错了'), 'defect')
  assert.equal(classifyKind('希望增加按供应商搜索'), 'request')
  // 平票与都未命中时按缺陷处理：缺陷漏判代价更高
  assert.equal(classifyKind('随便看看'), 'defect')
})

test('摘要长度受控，不产生超长标题', () => {
  const long = '采'.repeat(200) + '购单'
  const result = triage(long)
  assert.ok(result.summary.length <= 60, `summary 过长: ${result.summary.length}`)
})

test('追问话术逐项对应缺失字段', () => {
  const text = askForMissing(['expected', 'entry'])
  assert.ok(text.includes('希望它变成什么样'))
  assert.ok(text.includes('怎么复现'))
  assert.ok(!text.includes('哪个模块'), '不该追问没缺的模块')
})

test('空串不崩，判为待补充', () => {
  const result = triage('   ')
  assert.deepEqual(result.missing, ['expected'])
})
