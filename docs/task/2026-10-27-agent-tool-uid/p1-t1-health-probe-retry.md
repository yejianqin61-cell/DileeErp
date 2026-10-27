## 1. Where this task sits

- **阶段 1 先能看清线上发生了什么**，目标是一次真实提问之后能说出线上是哪一版。
- **本任务推进 R-7 部署健康检查带重试**：让切换脚本在 API 冷启动期不误判失败。
- **Starts after**：无。**Waits on it**：无（任务 2 起与它无关）。

## 2. What the developer needs to know

**Read first**

- `scripts/deploy/remote-switch.sh` — 现在为什么在 sleep 5 之后只探测一次。
- `scripts/deploy/common.sh` — `health_build` 的失败兜底值 `(health-failed)`。
- `scripts/deploy-scripts.test.mjs` — 部署脚本用静态断言守护，别改成跑真 bash。

**Settled**

- 兜底值 `(health-failed)` 保持不变，失败信息仍要同时含 build 与 release。
- 重试次数与间隔走环境变量，默认 6 次 / 5 秒。
- 只在切换脚本里重试，构建、迁移、核验三个脚本不动。

**Edges and seam**

- 触碰部署脚本与共用常量，不碰应用代码。
- Seam：`scripts/deploy-scripts.test.mjs` 的静态断言，不新增接缝。

**Run**

- `node --test scripts/deploy-scripts.test.mjs`

**Unknowns**

- 重试会把最坏部署时长拉长约 25 秒。若标准要求更短，停下来问。

## 3. The workflow

1. 读三份文件，用一句话复述本任务。
2. 在 `common.sh` 加默认次数与间隔常量。
3. 把单次探测改成有上限的循环，每次打印一行探测结果。
4. 失败消息带上探测次数、build 与 release。
5. 补三条静态断言，跑测试。
6. 提交。

## 4. The test cases

| Case | Input | Expected | Seam |
|---|---|---|---|
| 1 | 读切换脚本 | 探测写在有上限的循环里 | 静态断言 |
| 2 | 读切换脚本 | 失败消息同时出现 build 与 release | 静态断言 |
| 3 | 读 common.sh | 默认次数与间隔已定义且可覆盖 | 静态断言 |
| 4 | 读切换脚本 | 每次探测都写一行日志 | 静态断言 |
