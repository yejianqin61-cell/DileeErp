"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader } from "../../components/layout/app-shell";
import { Button } from "../../components/ui/button";
import { ActionDialog, type ActionField } from "../../components/ui/action-dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/feedback/states";
import { apiGet, apiPost, ApiClientError } from "../../lib/api-client";

type Customer = { id: string; customerCode: string; name: string; isActive: boolean };
type Order = { id: string; orderNo: string; productName: string; quantity: string; unit: string; status: string; customer: Customer; boms: { id: string; version: number }[] };
export default function SalesPage() { const [customers, setCustomers] = useState<Customer[]>([]); const [orders, setOrders] = useState<Order[]>([]); const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [message, setMessage] = useState("");
  const [orderDialogOpen, setOrderDialogOpen] = useState(false);
  const orderFields: ActionField[] = [{ name: "order_no", label: "订单号", required: true, placeholder: "人工录入订单号" }];
  const load = async () => { try { const [c, o] = await Promise.all([apiGet<Customer[]>("/customers"), apiGet<Order[]>("/sales-orders")]); setCustomers(c.data); setOrders(o.data); } catch (e) { setError(e instanceof ApiClientError ? e.message : "数据加载失败"); } finally { setLoading(false); } };
  useEffect(() => { void load(); }, []);
  async function createOrder(values: Record<string, string>) { const customer = customers.find((item) => item.isActive); if (!customer) { setError("请先创建启用客户"); return; } try { await apiPost("/sales-orders", { order_no: values.order_no, customer_id: customer.id, order_date: new Date().toISOString(), product_name: "待维护产品", quantity: "1", unit: "个", currency: "USD" }); setMessage("销售单已创建"); await load(); } catch (e) { setError(e instanceof ApiClientError ? e.message : "销售单创建失败"); } }
  async function confirm(id: string) { try { await apiPost(`/sales-orders/${id}/confirm`); setMessage("销售单已确认"); await load(); } catch (e) { setError(e instanceof ApiClientError ? e.message : "确认失败"); } }
  async function createBom(id: string) { try { await apiPost(`/boms/from-sales-order/${id}`, { extension_data: {} }); setMessage("BOM 草稿已创建"); await load(); } catch (e) { setError(e instanceof ApiClientError ? e.message : "BOM 创建失败"); } }
  return <><PageHeader title="销售与客户" description="维护客户、销售单、订单号和 BOM 来源"><Button onClick={() => setOrderDialogOpen(true)}>新建销售单</Button></PageHeader><ActionDialog open={orderDialogOpen} onOpenChange={setOrderDialogOpen} title="新建销售单" fields={orderFields} onSubmit={(values) => void createOrder(values)} />{message && <section className="panel panel-body">{message}</section>}{error ? <section className="panel"><ErrorState message={error} onRetry={() => { setError(""); void load(); }} /></section> : loading ? <LoadingState /> : <><section className="panel"><div className="panel-heading"><h2>客户池</h2><Link href="/customers">客户管理</Link></div><div className="panel-body">{customers.length ? `${customers.length} 个客户` : <EmptyState title="暂无客户" description="请先在客户管理中建立客户资料" />}</div></section><section className="panel" style={{ marginTop: 16 }}><div className="panel-heading"><h2>销售单</h2></div><div className="table-wrap"><table className="data-table"><thead><tr><th>订单号</th><th>客户</th><th>产品</th><th>数量</th><th>状态</th><th>操作</th></tr></thead><tbody>{orders.map((order) => <tr key={order.id}><td>{order.orderNo}</td><td>{order.customer.name}</td><td>{order.productName}</td><td>{order.quantity} {order.unit}</td><td>{order.status}</td><td>{order.status === "draft" && <Button variant="secondary" onClick={() => void confirm(order.id)}>确认</Button>}{order.status === "confirmed" && <Button variant="secondary" onClick={() => void createBom(order.id)}>创建 BOM</Button>}</td></tr>)}</tbody></table>{!orders.length && <EmptyState title="暂无销售单" description="使用右上角新建销售单开始订单链路" />}</div></section></>}</>;
}
