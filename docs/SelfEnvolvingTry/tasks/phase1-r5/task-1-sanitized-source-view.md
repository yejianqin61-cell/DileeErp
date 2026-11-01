# 任务 1：生成净化源码视图

## 1. 任务位置

- 属于阶段一 `R-5 源码与数据只读隔离`，目标是 Builder 只看到固定且无秘密的 ERP 源码。
- 本任务从指定 Git revision 和路径白名单生成确定性源码清单与只读视图。
- 开始条件是 R-4 已完成；容器挂载和 Linux 对抗实验等待本任务。

## 2. 开发者须知

**先读**

- `docs/SelfEnvolvingTry/phase1-architecture-validation-build-plan-2026-10-31.md` — R-5 的源码边界是什么。
- `.gitignore` — 哪些本地秘密和运行产物本来就不应进入基线。
- `apps/api/src/modules/business-query-agent/tools` — Builder 实际需要理解哪一段 ERP 源码。
- `apps/coding-worker/src/runtime-lifecycle.ts` — Harness 当前从哪个工作区启动。

**已定**

- 源码视图只取指定 Git revision 的普通文件，不复制工作树未跟踪文件或本地改动。
- 白名单只含业务查询 Agent 源码、Prisma schema 和最小构建清单。
- `.env`、凭据、备份、上传物、迁移 SQL、符号链接和白名单外文件都不进入视图。

**边缘与接缝**

- 接触 Coding Worker 的源码视图模块和单元测试。
- 接缝是 `materializeSourceView()`；不启动 Harness，也不决定容器权限。

**运行**

- `npm run test --workspace=@dilee/coding-worker -- source-view`
- `npm run typecheck --workspace=@dilee/coding-worker`

**未知项**

- 若 Builder 必需文件不在既定白名单，停止并报告，不扩大到整个仓库。

## 3. 工作流

1. 读完第 2 节，用一句话复述任务。
2. 为未跟踪 `.env` 不进入视图写红测试。
3. 从 Git tree 读取普通文件并生成确定性清单。
4. 加入路径白名单、危险名称和符号链接拒绝用例。
5. 核对相同 revision 产生相同清单哈希。
6. 运行目标测试和类型检查。
7. 提交测试，再提交实现。

## 4. 测试用例

| 用例 | 输入 | 预期 | 接缝 |
| --- | --- | --- | --- |
| 1 | 工作树有未跟踪 `.env` | 视图没有该文件 | `materializeSourceView()` |
| 2 | 白名单内普通源码 | 文件内容来自指定 revision | `materializeSourceView()` |
| 3 | 白名单外业务文件 | 视图没有该文件 | 源码白名单 |
| 4 | Git tree 含符号链接 | 稳定拒绝 | Git tree 解析 |
| 5 | 同一 revision 运行两次 | 清单哈希相同 | 源码清单 |

