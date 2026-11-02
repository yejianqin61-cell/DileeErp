## 1. Where this task sits

- **Phase 1 阶段一收口**，目标是宿主读取不使用管理员身份。
- **R-4 受限入口能安全读取实库**：adapter 固定专用只读角色。
- **Starts after**：专用只读角色。**Waits on it**：真实权限验证。

## 2. What the developer needs to know

**Read first**

- `apps/coding-worker/src/postgres-restricted-data.ts` — 本地 Docker 命令构造。
- `apps/coding-worker/src/restricted-data-gateway.ts` — 允许的读取操作。
- `apps/coding-worker/test/postgres-restricted-data.test.ts` — adapter 测试。

**Settled**

- adapter 不接受调用方指定的数据库角色。
- 固定角色名不携带密码或业务数据。
- 候选只走 JSONL 通道，不获得 Docker 命令。

**Edges and seam**

- 触及 local Postgres command。
- 不改候选协议或 Prisma。

**Run**

- `npm run test --workspace=@dilee/coding-worker -- postgres-restricted-data`
- `npm run typecheck --workspace=@dilee/coding-worker`

**Unknowns**

- 若现有调用方需要自选角色，停止并迁移调用方。

## 3. The workflow

1. 阅读第 2 部分，并重述：调用方不能把管理员身份注入 adapter。
2. 写固定角色参数的失败测试。
3. 收窄命令构造签名，产出固定身份。
4. 运行 focused tests，产出通过记录。
5. 运行类型检查，产出通过记录。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
| --- | --- | --- | --- |
| 1 | 容器名 | 参数包含固定角色 | command |
| 2 | 任意角色字符串 | 无法传入命令 | command |
| 3 | 读取请求 | 仍返回 JSON 行 | adapter |

