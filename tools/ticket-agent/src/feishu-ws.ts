/**
 * 长连接客户端。
 *
 * 为什么用官方 SDK 而不是自己开 WebSocket：
 * 飞书长连接的 wss 端点由 SDK 内部发现，官方文档**没有给出固定域名**。
 * 自己猜协议等于把「能不能收到消息」建立在一个未公开的握手上 —— 那不是工程，是赌博。
 * 所以这里只把 SDK 包一层，好处是：业务逻辑（分诊/状态机）仍然不依赖 SDK，
 * 传输层可以随时替换，测试也不受 SDK 影响。
 *
 * 依赖安装位置：tools/ticket-agent/node_modules，不属于 apps/* workspace，
 * 因此根 package-lock.json 不变，生产 npm ci 不受影响。
 */

import * as lark from '@larksuiteoapi/node-sdk'

import type { RawFeishuEvent } from './feishu-event.ts'

export interface LongConnectionOptions {
  appId: string
  appSecret: string
  /** 收到事件时调用。这里不做业务判断，只把原始事件交出去。 */
  onEvent: (event: RawFeishuEvent) => Promise<void> | void
  log?: (line: string) => void
}

export interface LongConnectionHandle {
  /** 断开连接。 */
  stop(): void
}

/**
 * 启动长连接。
 *
 * 关键事实（来自 docs/design/feishu-bot-integration-facts-2026-11-13.md）：
 *   - 长连接只需服务器能出站，不占入站端口；
 *   - 每个应用最多 50 条连接；
 *   - 集群模式随机投递，多副本会丢事件 —— 所以本服务必须单实例；
 *   - 事件需在 3 秒内处理完且不抛异常，否则飞书会重推。
 *
 * 因此 onEvent 必须是「快速落库/入队」型，不能在这里跑构建。
 * 真正的串行执行在调度器（Phase 3）。
 */
export function startLongConnection(options: LongConnectionOptions): LongConnectionHandle {
  const log = options.log ?? ((line: string) => console.log(line))

  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      // SDK 交过来的 data 就是事件体的 event 字段；外面补一个 header 以统一形状。
      // 这里刻意不抛异常：抛了飞书会重推，而重推对同一 message_id 是幂等的，
      // 但重复的网络往返没有意义。业务错误由 TicketFlow 内部处理并落 failed。
      try {
        const raw = { header: { event_type: 'im.message.receive_v1' }, event: data } as RawFeishuEvent
        await options.onEvent(raw)
      } catch (error) {
        log(`[ws] handler error: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  })

  const wsClient = new lark.WSClient({
    appId: options.appId,
    appSecret: options.appSecret,
    loggerLevel: lark.LoggerLevel.warn,
  })

  // start() 会异步建立连接；失败时 SDK 内部会重试，这里只记录。
  void wsClient
    .start({ eventDispatcher })
    .then(() => log('[ws] client ready'))
    .catch((error: unknown) => {
      log(`[ws] start failed: ${error instanceof Error ? error.message : String(error)}`)
    })

  return {
    stop(): void {
      try {
        wsClient.close()
        log('[ws] closed')
      } catch (error) {
        log(`[ws] close error: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
