"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiPost, ApiClientError } from "../../lib/api-client";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

export default function LoginPage() {
  const router = useRouter(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setLoading(true); setError(""); const data = new FormData(event.currentTarget); try { await apiPost("/auth/login", { username: data.get("username"), password: data.get("password") }); router.push("/"); router.refresh(); } catch (err) { setError(err instanceof ApiClientError ? err.message : "登录失败"); } finally { setLoading(false); } }
  return <main className="login-page"><form className="panel login-panel" onSubmit={submit}><div className="brand"><span className="brand-mark">迪</span><div><strong>迪礼管理系统</strong><small>厂内业务系统</small></div></div><h1>登录</h1><label>用户名<Input name="username" required autoComplete="username" /></label><label>密码<Input name="password" type="password" required autoComplete="current-password" /></label>{error && <p className="feedback-error">{error}</p>}<Button type="submit" disabled={loading}>{loading ? "登录中" : "登录"}</Button></form></main>;
}
