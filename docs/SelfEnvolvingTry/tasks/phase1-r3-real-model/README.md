# 阶段一 R-3 真实模型生成与返工

日期：2026-11-02｜状态：完成｜输出：Markdown

本批次把已验证的 DeepSeek 凭据接入受限 relay，并运行一次不含业务数据的真实模型候选实验。

| 顺序 | 任务 | 交付 |
| --- | --- | --- |
| 1 | [载入宿主模型凭据](task-1-load-model-credential.md) | `DEEPSEEK_KEY` 到运行时别名 |
| 2 | [限制模型 relay](task-2-restrict-model-relay.md) | 固定路径、令牌与上游 |
| 3 | [运行真实修订返工](task-3-real-model-rework.md) | 文件、哈希与返工证据 |

结果：真实 relay 验收启动 2 个子 Agent，并在空候选目录写出 `tool.ts` 和 `tool.test.ts`。
