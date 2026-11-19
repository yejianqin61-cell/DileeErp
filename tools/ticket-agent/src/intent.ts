/**
 * 意图分类：这条 @ 机器人的消息，到底是要改代码，还是在问事。
 *
 * 为什么需要这一层：2026-11-15 用户在真实群里问「汇报T-0007进度」，
 * 机器人回「这条我还不够开工，麻烦补两点」——分诊对「这不是需求」的输入只能给出
 * 「不够开工」，语义上正确，行为上完全错。缺的不是话术，是意图。
 *
 * 为什么默认是 `requirement`：这套系统的本职是改代码。把不认识的输入当需求，
 * 最坏是回一句「你希望它变成什么样」；把真实需求当问答，需求就石沉大海。
 *
 * 这里是纯函数、不调模型：意图判错的代价很高（问进度变成改代码），
 * 必须能用固定语料反复回归。
 */

export type Intent = 'requirement' | 'status' | 'question' | 'chitchat' | 'command'

export interface IntentResult {
  readonly intent: Intent
  /** 文本里提到的工单号，形如 `T-0007`。没有则为 null。 */
  readonly ticketNo: string | null
  /** 命中了哪条规则。写日志与测试断言用。 */
  readonly reason: string
}

/** 只保留正文：去掉 @占位符、多余空白、首尾标点。 */
export function normalizeText(text: string): string {
  return text
    .replace(/@_user_\d+/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim()
}

/**
 * 提取工单号。
 *
 * 支持 `T-0007`、`T0007`、`t-7`，也支持「工单7」这种口语说法。
 * 不匹配单独的字母 T + 数字以外的组合（例如 `T恤`），避免误判。
 */
export function extractTicketNo(text: string): string | null {
  const direct = /(?:^|[^A-Za-z0-9])T[-_ ]?0*(\d{1,4})(?![0-9])/i.exec(text)
  if (direct) return formatNo(direct[1])
  const spoken = /工单\s*[Tt]?[-_ ]?0*(\d{1,4})/.exec(text)
  if (spoken) return formatNo(spoken[1])
  return null
}

function formatNo(digits: string): string {
  return `T-${String(Number(digits)).padStart(4, '0')}`
}

/**
 * 强状态词：出现即认定「在问进度/结果」。
 *
 * 刻意不含单独的「进度」「状态」「情况」：`进度条改成蓝色` 是需求不是询问。
 * 单独这几个词要靠「短消息 + 票号」的组合规则兜住（见 classifyIntent）。
 */
const STATUS_PHRASES: readonly string[] = [
  '汇报', '报告一下', '报告进度', '报进度', '报一下',
  '进度如何', '进度怎么样', '进度怎样', '进度呢', '进度到', '查进度', '看进度', '问进度',
  '进展如何', '进展怎么样', '进展怎样', '进展呢', '查进展', '看进展',
  '状态如何', '状态怎么样', '状态怎样', '什么状态', '什么进度', '什么情况',
  '到哪了', '到哪一步', '到哪', '跑到哪',
  '怎么样了', '怎样了', '如何了', '咋样了',
  '好了吗', '好了没', '好了么', '完成了吗', '完成没', '做完了吗', '做完了没', '改好了', '修好了', '弄好了',
  '跑完了', '跑完了吗', '还在跑', '还没好', '还没好吗', '跑了吗', '开始了吗', '结束了吗', '停了吗', '在跑吗',
  '还要多久', '多久能好', '多久好', '还要几分钟', '还要多少时间', '剩余时间', '要多久', '多久能', '什么时候能', '什么时候好',
  '卡在', '卡住了', '卡在哪', '失败了', '失败了吗', '成功了吗', '结果呢', '结果如何', '结果怎么样',
]

/** 单独出现也算状态询问的短词，但必须整句很短或带票号。 */
const STATUS_SHORT_WORDS: readonly string[] = ['进度', '进展', '状态', '情况', '结果']

/** 命令词：整句只在说「部署/回滚」这类操作。 */
const COMMAND_PHRASES: readonly string[] = [
  '部署', '上线', '发布', '回滚', '重启', '重启机器人', '停止', '停一下', '暂停',
  'deploy', 'rollback', 'restart',
]

/**
 * 命令词前面允许的客气/重复前缀。
 *
 * 2026-11-19 真实漏判：用户在群里发「再次尝试部署」「再次尝试」，前者被判成需求、
 * 回了一句「你希望它变成什么样」，用户以为已经触发部署。原因就是旧的 `isCommand()`
 * 只认**句首**命令词。人说话不会把动词放第一位，机器人必须能剥掉这些前缀。
 */
const COMMAND_LEAD_FILLERS: readonly string[] = [
  '请', '麻烦', '帮我', '帮忙', '现在', '立刻', '马上', '直接', '再', '再次', '重新',
  '尝试', '试一下', '试', '可以', '能否', '能不能', '就',
]

/** 命令词后面允许的语气尾巴（剥掉后剩下的才是实质内容）。 */
const COMMAND_TAIL_PARTICLES: readonly string[] = ['一下', '下', '吧', '试试', '一次', '看看']

/** 以疑问语气结尾：那是「部署吗？」，不是命令。 */
const COMMAND_QUESTION_TAILS: readonly string[] = ['吗', '么', '嘛']

/** 剥前缀/尾巴必须长词优先，否则 `再次` 会被 `再` 吃掉一半，剩下「次尝试部署」。 */
const LEAD_FILLERS_SORTED: readonly string[] = [...COMMAND_LEAD_FILLERS].sort((a, b) => b.length - a.length)
const TAIL_PARTICLES_SORTED: readonly string[] = [...COMMAND_TAIL_PARTICLES].sort((a, b) => b.length - a.length)

const GREETING_PHRASES: readonly string[] = [
  '你好', '您好', '在吗', '在不在', '在么', '早上好', '中午好', '下午好', '晚上好',
  '早安', '晚安', '哈喽', 'hello', 'hi', 'hey', '嗨',
]

const THANKS_PHRASES: readonly string[] = [
  '谢谢', '多谢', '感谢', '辛苦了', '辛苦啦', 'thx', 'thanks', 'thank you',
]

const IDENTITY_PHRASES: readonly string[] = [
  '你是谁', '你叫什么', '你能做什么', '你会什么', '你能干什么', '你有什么用',
  '你是什么', '你是什么人', '介绍一下你自己', '自我介绍', '你是机器人吗',
]

const ACK_PHRASES: readonly string[] = ['好的', '好滴', '收到', '明白', '了解', 'ok', 'okay', '嗯', '哦', '好吧', '行吧']

/** 纯笑声/表情/标点：既不是需求也不是真问题，回一句人话就够。 */
const CASUAL_PHRASES: readonly string[] = ['哈哈', '嘿嘿', '笑死', '666', '👍', '🙏']

/** 情绪话：被骂时不辩解、不建单，先接住再给下一步。 */
const EMOTION_PHRASES: readonly string[] = [
  '傻逼', '傻比', '废物', '垃圾', '滚', '操你', '草你', '卧槽', '他妈的', '妈的',
  '气死', '烦死', '无语', '坑爹', '什么玩意', '太慢', '太垃圾', '没用', '有病',
]

/** 开头即问句的引导词：出现即按提问处理（先于「改代码」判定）。 */
const QUESTION_STARTERS: readonly string[] = [
  '请问', '请教', '咨询', '问一下', '想问', '想问下', '问个',
  '怎么', '如何', '为什么', '为啥', '是什么', '在哪', '哪里',
  '有没有', '是不是', '能否', '可不可以', '支不支持',
  '谁', '什么时候', '多少', '几个', '哪些', '哪个',
]

/**
 * 改代码意图的动词。
 *
 * 命中它就压过「能不能…」这类问句：在维护群语境里，
 * 「能不能支持按供应商搜」= 请加这个能力，不是让你解释原理。
 */
const CHANGE_VERBS: readonly string[] = [
  '加一个', '加个', '加一下', '增加', '添加', '新建', '创建', '删除', '去掉', '移除',
  '改成', '改为', '修改', '修复', '修一下', '实现', '优化', '调整', '替换', '重命名',
  '排序', '筛选', '搜索', '导出', '导入', '显示', '默认', '接入', '补齐', '支持',
]

/** 带问号或疑问语气尾巴，用于兜底判提问。 */
const QUESTION_TAIL = /[?？]\s*$|(?:吗|么|呢)\s*[?？]?\s*$/

function hit(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (text.includes(phrase)) return phrase
  }
  return null
}

function startsWithAny(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (text.startsWith(phrase)) return phrase
  }
  return null
}

function endsWithAny(text: string, phrases: readonly string[]): string | null {
  for (const phrase of phrases) {
    if (text.endsWith(phrase)) return phrase
  }
  return null
}

/**
 * 整句就是个命令：剥掉客气前缀与语气尾巴后，剩下的主体必须是命令词本身。
 *
 * 判据（2026-11-19 重写，见 COMMAND_LEAD_FILLERS 的注释）：
 * 1. `「部署」「部署吧」「麻烦再次尝试部署一下」「帮我上线」「重新部署」` → 命令；
 * 2. `「部署脚本要改」「把部署脚本改成幂等」` → **不是**命令（那是需求），
 *    所以不以「以命令词开头」为判据，而是要求剥完主体**就是**命令词，
 *    或只在命令词前有极短修饰（≤2 字，例如「把它部署」）；
 * 3. `「部署吗」` → 不是命令，那是提问。
 */
function isCommand(text: string): boolean {
  if (text.length > 16) return false
  let core = text.toLowerCase().replace(/[\s。！!，,、？?~…：:]/g, '')
  // 反复剥：`麻烦再次尝试部署一下` → `部署`
  for (let round = 0; round < 4; round += 1) {
    const before = core
    for (const filler of LEAD_FILLERS_SORTED) {
      if (core.startsWith(filler) && core.length > filler.length) {
        core = core.slice(filler.length)
        break
      }
    }
    for (const tail of TAIL_PARTICLES_SORTED) {
      if (core.endsWith(tail) && core.length > tail.length) {
        core = core.slice(0, -tail.length)
        break
      }
    }
    if (core === before) break
  }
  if (core.length === 0) return false
  if (endsWithAny(core, COMMAND_QUESTION_TAILS) !== null) return false
  if (COMMAND_PHRASES.includes(core)) return true
  const tailHit = endsWithAny(core, COMMAND_PHRASES)
  if (tailHit !== null && core.length - tailHit.length <= 2) return true
  const headHit = startsWithAny(core, COMMAND_PHRASES)
  return headHit !== null && core.length - headHit.length <= 2
}

/**
 * 分诊主函数。`text` 应已去掉 @占位符（内部也会再清一次）。
 */
export function classifyIntent(rawText: string): IntentResult {
  const text = normalizeText(rawText)
  const ticketNo = extractTicketNo(text)
  const lower = text.toLowerCase()

  // 1. 进度/结果询问。放在最前：`改好了吗` 同时含「改」和状态词，
  //    按需求处理会把一句询问变成一次改代码。
  const statusHit = hit(text, STATUS_PHRASES)
  if (statusHit !== null) {
    return { intent: 'status', ticketNo, reason: `状态词「${statusHit}」` }
  }
  // 单独的「进度/状态/情况/结果」只有在带票号或整句很短时才算询问。
  // 「进度条改成蓝色」命中这条会被下面的长度条件挡掉。
  const shortHit = hit(text, STATUS_SHORT_WORDS)
  if (shortHit !== null && !text.includes('进度条') && (ticketNo !== null || text.length <= 8)) {
    return { intent: 'status', ticketNo, reason: `短问句「${shortHit}」` }
  }

  // 带票号的「查一下 T-0007」「T-0007 怎么样了」「T-0007」都是问进度。
  if (ticketNo !== null) {
    const rest = text
      .replace(/(?:^|[^A-Za-z0-9])T[-_ ]?0*\d{1,4}/i, '')
      .replace(/[？?。！!，,、\s]/g, '')
    if (/(查|看|问)一下|看看|查下|怎么样|怎样|咋样|如何|什么情况/.test(text) || rest.length <= 2) {
      return { intent: 'status', ticketNo, reason: '带票号的查询' }
    }
  }

  // 2. 部署/回滚这类操作指令。
  if (isCommand(lower)) {
    return { intent: 'command', ticketNo, reason: '操作指令' }
  }

  // 3. 招呼、致谢、确认、身份、情绪。
  const greeting = hit(text, GREETING_PHRASES)
  if (greeting !== null && text.length <= 12) {
    return { intent: 'chitchat', ticketNo, reason: `招呼「${greeting}」` }
  }
  const thanks = hit(text, THANKS_PHRASES)
  if (thanks !== null) {
    return { intent: 'chitchat', ticketNo, reason: `致谢「${thanks}」` }
  }
  const identity = hit(text, IDENTITY_PHRASES)
  if (identity !== null) {
    return { intent: 'chitchat', ticketNo, reason: `身份询问「${identity}」` }
  }
  const emotion = hit(text, EMOTION_PHRASES)
  if (emotion !== null) {
    return { intent: 'chitchat', ticketNo, reason: `情绪话「${emotion}」` }
  }
  const ack = lower.replace(/[!！。.]/g, '').trim()
  if (ACK_PHRASES.includes(ack) || ack.length === 0) {
    return { intent: 'chitchat', ticketNo, reason: '确认/空话' }
  }
  if (/^[?？!！。.…\s]+$/.test(text) || hit(text, CASUAL_PHRASES) !== null) {
    return { intent: 'chitchat', ticketNo, reason: '语气话' }
  }

  // 4. 开头即问句（`怎么改`、`为什么…`）。放在改代码动词之前：
  //    「怎么改销售单排序」是在问用法，不是在委托改动。
  const starter = startsWithAny(text, QUESTION_STARTERS)
  if (starter !== null) {
    return { intent: 'question', ticketNo, reason: `问句开头「${starter}」` }
  }

  // 4.1 「怎么 / 如何 / 为什么」出现在句中也是问用法或问原因，
  //     除非同时带着明确的委托口吻（帮我 / 麻烦 / 改成 / 加一个…）。
  if (/怎么|如何|为什么|为啥/.test(text) && !/(帮我|麻烦|给我|请帮我|改成|改为|加一个|加个|新增|实现|修一下|优化)/.test(text)) {
    return { intent: 'question', ticketNo, reason: '疑问词在句中' }
  }

  // 5. 明确的改代码意图：即使以「能不能」开头也算需求。
  const changeVerb = hit(text, CHANGE_VERBS)
  if (changeVerb !== null) {
    return { intent: 'requirement', ticketNo, reason: `改动动词「${changeVerb}」` }
  }

  // 6. 兜底问句：以问号/吗么呢结尾，或含疑问词。
  if (QUESTION_TAIL.test(text) || /(?:有没有|是不是|能不能|可不可以|支不支持|行不行)/.test(text)) {
    return { intent: 'question', ticketNo, reason: '疑问语气' }
  }

  // 7. 默认：当需求。判断错了最坏是追问一句，不会丢需求。
  return { intent: 'requirement', ticketNo, reason: '默认按需求' }
}

/** 意图的中文标签，用于日志与卡片。 */
export function intentLabel(intent: Intent): string {
  const labels: Record<Intent, string> = {
    requirement: '需求',
    status: '进度询问',
    question: '提问',
    chitchat: '闲聊',
    command: '操作指令',
  }
  return labels[intent]
}
