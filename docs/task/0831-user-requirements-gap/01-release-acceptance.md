# 01 — 生产验收环境与发布包指纹闭环

**What to build:** 建立可重复的本地/服务器验收流程，证明运行中的 API、数据库迁移和 Web 静态资源来自同一发布包，并在失败时保留旧版本。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] 专用测试 PostgreSQL 可通过 `.env` 配置启动，迁移和幂等 seed 可执行。
- [ ] 发布包根目录包含 package.json、锁文件、apps/api、apps/web、PM2 配置和 RELEASE_VERSION。
- [ ] API health 返回 database=ok 且 build 等于 RELEASE_VERSION。
- [ ] Web manifest、登录页和静态 chunk 返回 200；PM2/Docker 两种启动方式均可验证。
- [ ] 部署失败不替换当前运行版本，并留下可定位的失败目录或日志。
- [ ] 记录 API、HTTP、权限和浏览器验收命令及结果。

