# Phase 2 进度：飞书工单机器人

日期：2026-11-14｜状态：代码完成，待凭据试连｜类型：进度记录

对应设计文档：[生产常驻 Agent 自动修 ERP](production-resident-agent-erp-maintenance-2026-11-13.md) §7 Phase 2。

## 结论

代码已写完并在服务器上跑通：**54 个测试全绿，类型检查干净，探针在缺凭据时正确失败**。
唯一缺的是飞书自建应用的 `App ID` / `App Secret` —— 这个只能由你在飞书开放平台创建。

拿到凭据后，一条命令即可验证连通性：

```bash
cd /opt/dilee/agent/ticket-agent
export PATH=/opt/node24/bin:$PATH
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx \
FEISHU_TEST_CHAT_ID=oc_xxx \
node --import tsx scripts/bot-probe.ts
```

## 一、放在哪里，为什么不进 apps

`tools/ticket-agent/`，不是 `apps/ticket-agent/`。

| 方案 | 根 `package-lock.json` | 生产 `npm ci` | 结论 |
|---|---|---|---|
| 放 `apps/` | 被改（新增 workspace 成员） | 重新解析全部依赖 | 拒绝 |
| 放 `tools/`，自有 `package.json` | **零改动** | 不受影响 | 采用 |

实测确认：`npm install --prefix tools/ticket-agent` 之后，`git status package-lock.json` 为空。
根 workspaces 只声明了 `apps/*`，所以 `tools/` 不在其中。

这条边界很重要：工单机器人不该因为「要用飞书 SDK」而让生产构建多付一次依赖解析的代价。

## 二、交付了什么

| 文件 | 职责 |
|---|---|
| `src/ticket-state.ts` | 九态工单状态机 + `message_id` 幂等表 |
| `src/triage.ts` | 分诊纯函数：模块 / 期望 / 入口 三项识别 |
| `src/feishu-event.ts` | 事件解析：认 @、过滤机器人、提取正文 |
| `src/feishu-transport.ts` | 传输层契约 + 卡片 JSON 构造 |
| `src/feishu-rest.ts` | REST 实现（token / 发消息 / 回复 / 更新卡片） |
| `src/feishu-ws.ts` | 长连接（包官方 SDK） |
| `src/feishu-fake.ts` | 假传输，让测试不需要网络 |
| `src/ticket-flow.ts` | 编排：消息 → 分诊 → 卡片 |
| `src/main.ts` | 主进程入口 |
| `scripts/bot-probe.ts` | 连通性探针 |

测试 54 条，覆盖分诊、事件解析、状态机、编排、REST 协议形状。

## 三、几个刻意的设计决定

### 1. 分诊不调模型

分诊判错是这套系统最贵的错误：判「能开工」会让 Agent 改错地方，判「太含糊」会让用户觉得机器人没用。
所以先用规则做到能用固定语料回归。规则覆盖不够时再加模型兜底，兜底也必须能用假模型复现。

### 2. 症状词不算「期望」

这一条是测试逼出来的真实修正。原先把「报错 / 不对 / 打不开」当成期望信号，
结果「1.5MB 的文件提示读取失败」被判定为「已经说清目标」，直接开工。

但这句话只说明哪里坏了，**没说要变成什么样**。Agent 拿到这样的任务会自己猜目标 —— 那正是要避免的。

修正后：症状词只用于区分缺陷与需求，不参与「期望是否说清」的判定。
上面那句话现在会被追问「你希望它变成什么样」。

### 3. 停止优先于分诊

同样是测试逼出来的。原实现里停止只拦「入队」，不拦「追问」，
于是停止之后来的新消息还会被追问一句 —— 用户会觉得机器人没听懂停止。

现在停止判定在分诊之前：停止是运维动作，优先级高于任何业务判断。

### 4. 长连接用官方 SDK，但只包一层

飞书长连接的 wss 端点由 SDK 内部发现，官方文档**没有给出固定域名**。
自己猜协议等于把「能不能收到消息」押在未公开的握手上。

所以只把 SDK 包成 `startLongConnection()`，业务逻辑不依赖它。
好处是传输层可替换，测试完全不受 SDK 影响。

### 5. 单实例，不做多副本

长连接是集群模式随机投递，多副本会丢事件。本服务必须单实例。
这与 2 核机器的单车道要求一致，不冲突。

## 四、验证记录

| 检查 | 本地 | 服务器 |
|---|---|---|
| 测试 54 条 | 54 pass / 0 fail | 54 pass / 0 fail |
| `tsc --noEmit` | 退出 0 | 退出 0 |
| 探针缺凭据 | 明确报错，退出 1 | 明确报错，退出 1 |
| 主进程缺配置 | 退出码 2，不重试 | — |
| 根 lockfile 是否被改 | **未改** | — |
| SDK 是否只装在本地 | — | `tools/ticket-agent/node_modules` |

## 五、踩过的坑（写给后来的人）

1. **`tsconfig.json` 不能继承仓库根的共享配置。** 本目录会被整体复制到
   `/opt/dilee/agent/ticket-agent` 独立运行，那里没有 `../../tsconfig.base.json`。
   继承会让 tsc 在服务器上读不到 base 而退回默认值，产生一串假错
   （`Module '"fs"' has no default export`、`downlevelIteration` 等）。现在改为自包含。

2. **`devDependencies` 不能省。** 第一版只写了 `dependencies`，服务器上
   `npx tsc` 找不到本地 TypeScript，去下载了一个无关的 `tsc@2.0.4` 包，
   类型检查实际没跑却看起来跑了。现在显式声明 `tsx` / `typescript` / `@types/node`。

3. **打包时顶层目录名要对上。** 包内是 `ticket-agent/`，
   所以要解到 `/opt/dilee/agent`，而不是 `/opt/dilee/agent/ticket-agent`。

4. **Windows 上用 `Set-Content -Encoding utf8` 会毁掉中文源码。**
   本次实际发生：一个源文件被写成 ANSI 重读后中文全乱。修复方式是重写文件。
   以后所有源码写入用 `[IO.File]::WriteAllText` + `UTF8Encoding($false)`。

## 六、下一步

需要你做一件事：在飞书开放平台建自建应用。

| 步骤 | 要点 |
|---|---|
| 1. 创建企业自建应用 | 拿 `App ID` 与 `App Secret` |
| 2. 开权限 | `im:message.group_at_msg:readonly`（仅 @我）＋ `im:message:send_as_bot`（发消息） |
| 3. 开事件订阅 | 选**长连接**（不是 webhook）；订阅 `im.message.receive_v1` |
| 4. 发布应用 | 你说走免审，若管理员已开免审窗口则改权限即生效 |
| 5. 把机器人加进群 | 客户端 `··· > 设置 > 群机器人 > 添加机器人`（仅电脑端） |
| 6. 拿群 chat_id | 加进群后随便发一条消息，从事件里取 `oc_` 开头的 id |

拿到 `App ID` / `App Secret` / `chat_id` 后，跑上面那条探针命令。
探针会自己打出 `FEISHU_BOT_OPEN_ID=ou_xxx`，把它写进服务器 `.env` 即可启动主服务。

之后我会用你的真实群做一次完整验收：@ 一句 → 卡片 → 重投不重复 → 含糊被追问 → 停止生效。

## 变更记录

- 2026-11-14：建立。代码完成，服务器验证通过，等待飞书凭据。
