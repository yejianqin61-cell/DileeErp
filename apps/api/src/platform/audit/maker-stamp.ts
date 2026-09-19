import { beijingDateTime } from "../time/beijing-time";

/** 能落款的最小用户形状（`/auth/me` 与 `CurrentUser` 都给 display_name）。 */
export type MakerLike = { display_name?: string | null; username?: string | null } | null | undefined;

/**
 * 导出文件的表尾落款：`制表人：张三；制表时间：2026-09-16 14:30:05（北京时间）`。
 *
 * 为什么需要它（2026-09-16「操作人与操作时间」全站治理）：
 *   报表类导出是**期间聚合**口径——一行往往跨多条业务记录，给行加「创建人 / 最后修改人」
 *   说不清这一行的操作人是谁。所以这类文件回答的是另一个问题：**这份文件是谁、什么时候生成的**。
 *   把它抽成一处是因为措辞必须一致：财务与人事两个导出各自写一遍，迟早出现「制表人」和
 *   「导出人」两种叫法，读文件的人会以为是两个不同的东西。
 *
 * 时间固定北京时间（与全站时间口径一致）；取不到姓名就留空，**绝不回落成 id**。
 */
export function makerStamp(actor: MakerLike, now: Date = new Date()): string {
  return `制表人：${actor?.display_name ?? ""}；制表时间：${beijingDateTime(now, { seconds: true })}（北京时间）`;
}
