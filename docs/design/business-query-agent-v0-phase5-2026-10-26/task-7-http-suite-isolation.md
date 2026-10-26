# Task 7：HTTP 并发证据的测试隔离

## 目标

让五用户并发 HTTP 用例在验证“许可释放后可再次创建 run”后，不遗留管理员的活动 run，避免后续同账号契约用例被污染成 `409 RUN_IN_PROGRESS`。

## 范围

- 复用用例已有的快照轮询模式，等待最后一条验证性 run 落入终态。
- 不改并发闸门、控制器、数据库约束或生产行为。

## 验收

- [ ] 两个 business-query HTTP 测试文件串行运行通过。
- [ ] 最后一条许可释放验证 run 已进入 completed/failed/cancelled 后用例才结束。
