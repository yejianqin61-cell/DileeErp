"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiPost, ApiClientError } from "../../lib/api-client";
import { landingPathFor } from "../../lib/surface-permission";
import type { SessionProfile } from "../../lib/session";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export default function LoginPage() {
  const router = useRouter(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError("");
    const data = new FormData(event.currentTarget);
    try {
      // 登录返回里带着这个账号的表面权限，所以能直接落到"他进得去的第一个页面"：
      // 人事落到 /hr、其他角色落到工作台——否则人事登录后先撞一次门禁页，很别扭。
      const result = await apiPost<{ user: SessionProfile }>("/auth/login", { username: data.get("username"), password: data.get("password") });
      router.push(landingPathFor(result.data.user?.surface_sections));
      router.refresh();
    } catch (err) { setError(err instanceof ApiClientError ? err.message : "登录失败"); } finally { setLoading(false); }
  }
  return <main className="login-page" data-testid="page-login"><form className="panel login-panel" onSubmit={submit} data-testid="login-form"><div className="brand"><span className="brand-mark">迪</span><div><strong>迪礼管理系统</strong><small>厂内业务系统</small></div></div><h1>登录</h1><label>用户名<Input name="username" required autoComplete="username" data-testid="login-username" /></label><label>密码<Input name="password" type="password" required autoComplete="current-password" data-testid="login-password" /></label>{error && <p className="feedback-error" data-testid="login-error">{error}</p>}<Button type="submit" disabled={loading} data-testid="login-submit">{loading ? "登录中" : "登录"}</Button></form></main>;
}
