import type { AgentToolName } from "./tool-registry";

export type ModuleSpec = {
  tool: AgentToolName;
  title: string;
  scope: string;
  negatives: string[];
};

export type OperationSpec = {
  questionShape: string;
  input: string;
  output: string;
  boundary: string;
  accepts: string[];
};

export const MODULE_SPECS: ModuleSpec[] = [
  {
    tool: "order_query",
    title: "订单",
    scope: "单号检索(search_documents)与订单全链路；无单号问列表用 list_documents",
    negatives: ["金额", "写操作"],
  },
  {
    tool: "sales_query",
    title: "销售",
    scope: "某订单的销售单、客户、BOM、退货",
    negatives: ["价格金额", "客户电话地址"],
  },
  {
    tool: "procurement_query",
    title: "采购",
    scope: "某订单的采购计划、采购单、到货、来料质检；哪些采购到货超期用 list_overdue_arrivals",
    negatives: ["金额单价", "按供应商汇总"],
  },
  {
    tool: "production_query",
    title: "生产",
    scope: "某订单的生产单、工序进度、报工、外加工流转",
    negatives: ["员工与工价"],
  },
  {
    tool: "warehouse_query",
    title: "库存",
    scope: "某订单的物料余额、流水、领退、成品质检与出入库；哪些物料库存不足用 list_low_stock_materials",
    negatives: ["金额", "趋势"],
  },
  {
    tool: "finance_query",
    title: "财务",
    scope: "某订单的应收应付、收付款、对账、成本利润、人工",
    negatives: ["跨订单汇总", "科目凭证"],
  },
];

const op = (questionShape: string, input: string, output: string, boundary: string, accepts: string[]): OperationSpec => ({ questionShape, input, output, boundary, accepts });

export const OPERATION_SPECS: Record<string, OperationSpec> = {
  "order_query:search_documents": op(
    "按单号或关键字找单据，销售单号、采购单号、生产单号都可以",
    "无需单据根；必填关键字 q，可选页码",
    "每行落回所属销售单：order_ref 句柄、单号、产品、状态；其余命中的单据折叠在 related_documents",
    "只按单号包含匹配，不按状态、客户、日期筛选；每页 20 行",
    ["q", "page"],
  ),
  "order_query:search_orders": op(
    "按销售单号关键字找销售订单",
    "无需单据根；必填关键字 q，可选页码",
    "每行是一张销售单：单号、产品、数量、单位、状态、交货日期",
    "只查销售单号，不含采购单号与生产单号入口；不含客户字段；每页 20 行",
    ["q", "page"],
  ),
  "order_query:list_documents": op(
    "没有具体单号时，按状态、客户、产品、更新日期列出销售单",
    "无需单据根；可选 status、customer_q、product_q、from、to、页码",
    "每行是一张销售单：单号、产品、数量、状态、客户名、下单日期、交货日期",
    "只列销售单；日期区间按更新日期而不是交货日期；不分组、不计数；每页 20 行",
    ["status", "customer_q", "product_q", "from", "to", "page"],
  ),
  "order_query:get_order_overview": op(
    "一张订单整体走到哪了、各环节数量与进度",
    "需单据根",
    "单个对象：销售状态、BOM 状态，采购、原料库存、生产、成品质检、成品库存、发货各环节的状态与数量汇总，整体状态及中文标签、阻塞项、更新时间",
    "不含任何金额，整体状态只由非财务环节推出；不列明细行",
    ["order_ref"],
  ),
  "order_query:get_order_status": op(
    "一张订单当前处于什么状态",
    "需单据根",
    "单个对象：销售状态、BOM 状态、整体状态及中文标签、阻塞项",
    "不含各环节数量（要数量用 get_order_overview）；不含金额与财务状态；不列明细行",
    ["order_ref"],
  ),
  "order_query:get_order_timeline": op(
    "一张订单上发生过哪些操作、按时间倒序",
    "需单据根；可选页码",
    "审计事件行：动作、时间",
    "只含非财务动作，财务、工资、供应商相关动作不出现；每页 20 行",
    ["order_ref", "page"],
  ),
  "order_query:get_order_alerts": op(
    "一张订单现在有哪些阻塞或告警",
    "需单据根；可选页码",
    "告警行：来源类型、告警类型、分级、标题、处理建议、处理状态、时间",
    "只有三类来源：生产日报告警、成品质检不合格、库存净变动为负；只含本订单，不是全库告警；不跨订单汇总；每页 20 行",
    ["order_ref", "page"],
  ),
  "order_query:get_order_attachments": op(
    "一张订单及其非财务关联单据有哪些附件",
    "需单据根",
    "附件元数据行：类型、大小、上传时间、关联单据类型与编号",
    "不给文件名、存储键、下载地址与文件内容；最多 20 条",
    ["order_ref"],
  ),
  "sales_query:get_sales_order": op(
    "销售单本身的信息：客户订单号、产品、数量、交期、状态",
    "需单据根",
    "单个对象：单号、客户订单号、产品、规格、数量、单位、交货日期、状态、版本、备注",
    "不含单价、金额、税率、币种与结算信息；不含客户快照",
    ["order_ref"],
  ),
  "sales_query:get_customer": op(
    "这张订单是哪个客户的",
    "需单据根",
    "单个对象：客户编码与客户名称",
    "只有编码与名称，没有电话与地址；不是客户维度的汇总",
    ["order_ref"],
  ),
  "sales_query:get_bom": op(
    "这张订单的物料清单与用量",
    "需单据根；可选页码",
    "按版本倒序的物料行：序号、物料名、型号、规格、颜色、需用数量、单位、核定用量",
    "不含物料价格；每页 20 行",
    ["order_ref", "page"],
  ),
  "sales_query:get_sales_returns": op(
    "这张订单有没有客户退货",
    "需单据根；可选页码",
    "退货行：退货单号、数量、日期、去向、状态",
    "不含退货金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "procurement_query:get_purchase_plans": op(
    "这张订单的采购计划要采什么、采多少",
    "需单据根；可选页码",
    "计划物料行：计划号、BOM 版本、物料名称、型号、数量、单位、供应商名称、计划创建时间",
    "不含价格；每页 20 行，分页按物料行而不是按计划",
    ["order_ref", "page"],
  ),
  "procurement_query:list_overdue_arrivals": op(
    "哪些采购单预计到货日已过、还没全部到货",
    "无需单据根；可选页码",
    "采购单行：采购单号、所属销售单号、状态、预计到货日、超期天数、供应商",
    "超期口径是预计到货日早于今天且状态不是已全部到货或已取消；不按供应商分组汇总；不含金额；每页 20 行",
    ["page"],
  ),
  "procurement_query:get_purchase_orders": op(
    "这张订单下有哪些采购单、状态与预计到货日",
    "需单据根；可选页码",
    "采购单行：采购单号、状态、供应商名称、采购日期、预计到货日、总数量",
    "不含金额单价、付款条款、交货条款与供应商联系方式；每页 20 行",
    ["order_ref", "page"],
  ),
  "procurement_query:get_receipts": op(
    "这张订单的采购到货记录",
    "需单据根；可选页码",
    "到货行：到货单号、到货日期、数量、状态、所属采购单号",
    "以到货单号标识批次，没有批次序号；不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "procurement_query:get_incoming_inspections": op(
    "这张订单的来料质检结果",
    "需单据根；可选页码",
    "质检行：检验数量、合格数量、让步数量、不合格数量、结论、状态、所属到货单号",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "production_query:get_production_orders": op(
    "这张订单下有哪些生产单、各工序目标数量",
    "需单据根",
    "生产单行：生产单号、状态、计划数量，及各工序名称、顺序、目标数量、状态",
    "不含报工完成数量（见 get_operation_progress）；不含工价",
    ["order_ref"],
  ),
  "production_query:get_operation_progress": op(
    "这张订单各工序完成了多少",
    "需单据根",
    "按生产单与工序的进度行：目标数量、累计完成数量、完成比例",
    "与生产进度页同一口径；不含员工与工价",
    ["order_ref"],
  ),
  "production_query:get_operation_reports": op(
    "这张订单每天的报工记录",
    "需单据根；可选页码",
    "报工行：生产单号、工序名称、报工日期、完成数量、单位",
    "不含员工与工价；每页 20 行",
    ["order_ref", "page"],
  ),
  "production_query:get_outsource_flow": op(
    "这张订单的外加工流转：发料、回厂、直发",
    "需单据根",
    "三条链分列：发料批次、回厂转移、直发出货，各含单号、状态、数量、日期",
    "每条链最多 20 行；不含应付来源",
    ["order_ref"],
  ),
  "warehouse_query:get_raw_material_balance": op(
    "这张订单 BOM 里的物料现在库里还有多少",
    "需单据根",
    "物料行：物料编码、名称、单位、当前实存量",
    "只含这张订单 BOM 里的原料，实存量含报废库存且为全局口径，不是这张订单专属的库存；实存量为 0 的物料不出现",
    ["order_ref"],
  ),
  "warehouse_query:list_low_stock_materials": op(
    "哪些原料库存不足",
    "无需单据根；可选页码",
    "物料行：物料编码、名称、单位、净库存，按净库存从低到高",
    "以净库存小于等于 0 为不足，没有安全库存阈值；按物料与单位聚合，不按仓库、不按订单；每页 20 行",
    ["page"],
  ),
  "warehouse_query:get_inventory_facts": op(
    "这张订单相关的库存变动流水",
    "需单据根；可选页码",
    "流水行：库存类别、数量变化、来源类型、时间",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "warehouse_query:get_material_movements": op(
    "这张订单的原料领料、退料、报废单据",
    "需单据根；可选页码",
    "单据行：单据号、类型、状态、业务日期，及各行物料与数量",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "warehouse_query:get_finished_goods_qc": op(
    "这张订单的成品质检结果",
    "需单据根；可选页码",
    "质检行：质检单号、结论、状态、检验数量、合格数量、让步数量、不合格数量、检验日期",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "warehouse_query:get_finished_goods_inbounds": op(
    "这张订单的成品入库通知与入库情况",
    "需单据根；可选页码",
    "两组行：入库通知（通知号、状态、通知数量）与入库单（入库单号、状态、数量）",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "warehouse_query:get_finished_goods_outbounds": op(
    "这张订单的成品出库与发货情况",
    "需单据根；可选页码",
    "出库行：出库单号、状态、数量、发货日期、出库通知号",
    "不含金额；每页 20 行",
    ["order_ref", "page"],
  ),
  "finance_query:get_receivables": op(
    "这张订单应收多少、收了多少",
    "需单据根；可选页码；仅财务档",
    "应收来源行：客户、关联出库单号，及各核销分配的金额与状态",
    "仅本订单；不是客户维度的应收汇总；每页 20 行",
    ["order_ref", "page"],
  ),
  "finance_query:get_customer_payments": op(
    "这张订单收到了哪些客户收款",
    "需单据根；可选页码；仅财务档",
    "收款行：客户、银行、状态，及分配到各应收来源的金额",
    "仅本订单；不含自由备注；每页 20 行",
    ["order_ref", "page"],
  ),
  "finance_query:get_payables": op(
    "这张订单的供应商应付有多少",
    "需单据根；可选页码；仅财务档",
    "应付行：供应商、采购单号，及各核销分配的金额与状态",
    "仅本订单；不是供应商维度的应付汇总；每页 20 行",
    ["order_ref", "page"],
  ),
  "finance_query:get_supplier_payments": op(
    "这张订单付了哪些供应商款项",
    "需单据根；可选页码；仅财务档",
    "付款行：供应商、银行、状态，及分配到各应付分录的金额",
    "仅本订单；不含自由备注；每页 20 行",
    ["order_ref", "page"],
  ),
  "finance_query:get_reconciliations": op(
    "这张订单的应收与应付对账情况",
    "需单据根；可选页码；仅财务档",
    "两类对账行：应收对账（客户、银行）与应付对账（供应商、银行、采购单号）",
    "库里没有对账记录时返回空，这是缺数据而不是缺工具；仅本订单",
    ["order_ref", "page"],
  ),
  "finance_query:get_order_cost_profit": op(
    "这张订单的成本与利润",
    "需单据根；仅财务档；页码参数被接受但不起作用",
    "单个对象：是否已出货、币种、销售金额、本币收入、原料成本、人工、总成本、利润、口径说明与脚注",
    "只核算已确认或已关闭且已出货的订单，其余只返回未出货说明而没有金额；原料成本缺采购价或无 BOM 时按 0 计入，利润会偏高，见脚注；没有期间参数，月度管理费不纳入",
    ["order_ref", "page"],
  ),
  "finance_query:get_order_payroll": op(
    "这张订单发了多少人工工资",
    "需单据根；可选页码；仅财务档",
    "报工工资行：日期、员工、工序、计价方式、数量、单价、金额",
    "仅本订单；不是员工维度的工资汇总；每页 20 行",
    ["order_ref", "page"],
  ),
};
