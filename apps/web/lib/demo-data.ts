export type DemoSource = "演示数据";
export type OrderProgressRow = { source: DemoSource; order_no: string; customer: string; status: string; delivery_date: string };
export type ProductionProgressRow = { source: DemoSource; production_no: string; operation: string; planned_quantity: number; completed_quantity: number };
export type ReceivablePayableRow = { source: DemoSource; direction: "应收" | "应付"; order_no: string; currency: string; original_amount: string; settled_amount: string; balance: string };
export type ModulePlaceholder = { source: DemoSource; name: string; responsibility: string; focus: string };

export const demoOrderProgress: OrderProgressRow[] = [
  { source: "演示数据", order_no: "DEMO-2026-001", customer: "Demo Customer", status: "生产中", delivery_date: "2026-09-15" },
  { source: "演示数据", order_no: "DEMO-2026-002", customer: "Sample Trading", status: "待检验", delivery_date: "2026-09-20" },
];
export const demoProductionProgress: ProductionProgressRow[] = [
  { source: "演示数据", production_no: "MO-DEMO-001", operation: "待车间确认", planned_quantity: 1000, completed_quantity: 420 },
  { source: "演示数据", production_no: "MO-DEMO-002", operation: "待车间确认", planned_quantity: 800, completed_quantity: 800 },
];
export const demoReceivablesPayables: ReceivablePayableRow[] = [
  { source: "演示数据", direction: "应收", order_no: "DEMO-2026-001", currency: "USD", original_amount: "12,800.00", settled_amount: "6,400.00", balance: "6,400.00" },
  { source: "演示数据", direction: "应付", order_no: "DEMO-2026-002", currency: "CNY", original_amount: "38,000.00", settled_amount: "20,000.00", balance: "18,000.00" },
];

export const modulePlaceholders: ModulePlaceholder[] = [
  { source: "演示数据", name: "生产", responsibility: "生产单、订单推进、工序进度", focus: "工序、数量、外发、返工和物料需求" },
  { source: "演示数据", name: "采购", responsibility: "供应商、采购计划、采购单", focus: "采购计划、到货、分批到货和退货" },
  { source: "演示数据", name: "财务", responsibility: "应收应付、收付款和余额", focus: "形成节点、部分收付款、对账和币种" },
  { source: "演示数据", name: "仓库", responsibility: "原料、成品、退料、不良品库存", focus: "库存分类、成本、批次、单位和盘点" },
  { source: "演示数据", name: "人事", responsibility: "员工、考勤、绩效、薪资台账", focus: "字段、周期、权限和人工计薪" },
  { source: "演示数据", name: "客户池", responsibility: "客户基础资料和客户池", focus: "客户字段、联系人、分类和状态" },
];
