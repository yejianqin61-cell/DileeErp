# 测试记录

记录测试策略、测试用例、验收证据、回归结果和备份恢复演练。代码测试与文档中的验证记录应相互链接。

## 本地门禁

```powershell
npm run verify:quick
npm run db:test:prepare
npm run verify:chain
```

`verify:quick` 不依赖 PostgreSQL。`verify:chain` 需要 `TEST_DATABASE_URL`、`API_BASE_URL` 和 `PLAYWRIGHT_BASE_URL`；任何缺失均记录为环境阻断，不会伪装成链路通过。结果归档在 `docs/test/results/`。

## 部署前检查

- 验证目标数据库迁移状态与 API 健康检查。
- 使用管理员账号登录，读取一项字典数据并抽检附件上传/下载。
- 按 `docs/test/platform-quality-and-recovery.md` 完成备份恢复演练，记录备份哈希、操作人和结果。
- 关联本次业务任务的测试用例与结果；存在失败或环境阻断时不得将对应链路标记为已验收。
