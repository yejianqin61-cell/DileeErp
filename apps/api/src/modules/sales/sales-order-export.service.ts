import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import * as ExcelJS from "exceljs";
import { AuditActorService } from "../../platform/audit/audit-actor.service";
import { PrismaService } from "../../platform/database/prisma.service";
import { columnSpanWidth, rowHeightFor, type RowHeightBlock } from "../../platform/excel/row-height";
import { beijingDate, beijingDateTime } from "../../platform/time/beijing-time";
import { SPEC_MATERIAL_KEYS, SPEC_SCALAR_FIELDS, specDetailLabelsWithDefaults, specScalarRow } from "./sales-orders.service";

/**
 * 导出要用的物料摘要（**不取字节**）：`document()` 的兜底文字要 名称/规格/颜色，图片区要尺寸与 sha。
 *
 * ⚠️ 这份 select 曾经漏了 `specificationModel` / `color`：测试夹具里带着这两个字段，所以单测全绿，
 * 而真实导出里「引用了物料但格子里没写字」的兜底文字只有「MAT-1 伞骨」—— 规格与颜色在纸上消失
 * （与 2026-09-26 那次「引用的资料在导出的 excel 中无法显示」是同一处）。2026-10-08 补齐，
 * 并加了一条**钉住这份 select** 的测试：夹具比真实查询更"全"，是这类漏洞的温床。
 */
const EXPORT_MATERIAL_SELECT = { id: true, materialCode: true, name: true, specificationModel: true, color: true, image: { select: { width: true, height: true, sha256: true } } } as const;

/**
 * 「其它」行在**图片导出**里的键：`extra:<行 id>`。
 *
 * 为什么带前缀：18 个固定栏位的键（`rib_spec` …）不能与用户自定义的类目混在一起 ——
 * 前缀让两套键一眼分得开，`materialRefLookup` 那份查找表也是「固定栏位 + 其它行」合成的。
 *
 * 为什么用**行 id** 而不是行序号：这些行是「整块替换」语义，每次保存行 id 都会变；而用户完全可能
 * 在另一个标签页里刚保存过，手上那份候选就是过期的。过期时按 id 查不到 → 报「这一格没有可导出的
 * 图片」，重开一次弹窗就好；按序号查会在序号仍然有效的情况下**把图悄悄配到另一行上**，
 * 而那种错在纸上看不出来。
 */
export function materialExtraRefKey(extraId: string): string {
  return `extra:${extraId}`;
}

/**
 * 销售单「工艺单」导出（2026-09-16）。
 *
 * 版式依据：`example/销售单/DL260134 JBN生产单(1).xls`（A–J）与
 * `example/销售单/DL260001-1 花色生产单-IS(FLOWER1 PO#32366-1).xlsx`（A–K）两张样本；
 * 设计见 `docs/design/sales-order-spec-refinement-and-production-sheet-export-2026-09-16.md`。
 * 用户拍板「两张合一：一套版式，空盘位自动省略」。
 *
 * 三条约定（都有测试钉住）：
 *   1. **空盘位自动省略**：材料行/工艺条目/布量只有有值的才印；整块为空（样本2 没有布量区）
 *      就整块不印，不留一片空白；
 *   2. **工艺要求重新编号**：跳过的条目不能留出「1、2、5、7」这种断号；
 *   3. **行高按内容自动算**（用户 2026-09-24：「行高需要自己调，不美观，太扁了」）：
 *      ExcelJS 不做自动行高，所以这里按「文字显示宽度 ÷ 跨列可用宽度」估折行数再乘行高
 *      （`platform/excel/row-height.ts`），把写死的高度全部换掉。
 */
@Injectable()
export class SalesOrderExportService {
  constructor(private readonly prisma: PrismaService, private readonly actors: AuditActorService) {}

  /** 材料明细的印刷顺序与中文名（模板两张样本的并集，顺序照模板）。 */
  static readonly MATERIAL_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["rib_spec", "伞骨（孔对孔）"],
    ["canopy_spec", "伞布规格"],
    ["handle_spec", "伞头"],
    ["handle_strap_spec", "伞头带"],
    ["tail_spec", "伞尾、笠"],
    ["runner_spec", "伞束、珠"],
    ["strap_spec", "伞带"],
    ["strap_fastener_spec", "伞带粘扣"],
    ["inner_label_spec", "内标"],
    ["woven_label_spec", "织标"],
    ["hang_tag_spec", "吊牌"],
    ["opp_spec", "OPP"],
    ["bag_spec", "布套"],
    ["packaging_spec", "包装明细"],
    ["top_fabric_spec", "天布"],
    ["wood_ear_spec", "木耳"],
    ["keychain_spec", "钥匙扣"],
    ["printing_spec", "印刷"],
  ];

  /** 工艺要求的印刷顺序与分组名（并集；导出时按有值的条目重新编号）。 */
  static readonly PROCESS_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["sample_requirement", "样品要求"],
    ["cutting_requirement", "裁布要求"],
    ["edge_requirement", "拉边要求"],
    ["joining_requirement", "合片要求"],
    ["top_stitch_requirement", "打顶要求"],
    ["sewing_requirement", "缝伞要求"],
    ["strap_requirement", "伞带要求"],
    ["hang_tag_note", "吊牌位置"],
    ["qc_requirement", "质检报告"],
  ];

  /** 布量五格（模板「伞面/伞带/木耳/天布/布套（Y/DZ)」）。 */
  static readonly FABRIC_LABELS: ReadonlyArray<readonly [SpecKey, string]> = [
    ["fabric_usage_canopy", "伞面"],
    ["fabric_usage_strap", "伞带"],
    ["fabric_usage_wood_ear", "木耳"],
    ["fabric_usage_top", "天布"],
    ["fabric_usage_bag", "布套"],
  ];

  /** 单张工艺单的可测试文档形状（与 Excel 落格分开：断言内容不必依赖坐标）。 */
  document(order: ExportOrder, makerName: string, now: Date = new Date()): ProductionSheetDocument {
    // 下面 37 个细化字段（材料 / 工艺 / 布量 / 表头补充）都是按**请求键**（snake_case）读的，
    // 而 Prisma 行给的是**列名**（camelCase）：先统一翻译一次。少了这一步，除了 `factory`
    // ——键名与列名恰好相同——之外全部读成 undefined，工艺单上的「材料」「明细」「布量」
    // 会整块消失（用户 2026-09-20「再打开就又没有了」同一个根因，读侧一律不许直接吃 Prisma 行）。
    const spec = specScalarRow(order as unknown as Record<string, unknown>);
    const text = (key: SpecKey): string => (spec[key] ?? "").trim();
    /**
     * 「这一格引用了哪个物料」→ 印在格子里的兜底文字。
     *
     * 为什么必须有这层兜底（用户 2026-09-26 现场问题：「材料明细那边，如果是使用引用的资料，
     * 在导出的 excel 中无法显示」）：格子里的文字与「引用了哪个物料」是**两条独立的记录**——
     * 引用是 `sales_order_material_refs` 一行，文字是 `sales_orders.rib_spec` 那种标量列。
     * 只要文字那条为空（清过格子、老数据、别处写进来的行），今天这一格就**整行不印**
     * （见下面 `filter((line) => line.value)` 的「空盘位自动省略」）——
     * 于是「引用了物料」这件事在纸上完全消失，工厂照着一张少了一个部件的工艺单做伞。
     * 取「格子里有人写的字」优先（那是人对着这一单说的话），空则退回引用的物料。
     */
    const refText = new Map((order.materialRefs ?? []).map((ref) => [ref.specKey, materialRefText(ref.material)]));
    /**
     * 「材料明细 → 其它」行（用户 2026-10-08：「材料明细最后还需要加一个『其它』」）。
     *
     * 印在 18 项**之后**（用户说的就是"最后"），类目名用用户自己起的那个字，内容取「人写的字」优先、
     * 空则退回引用物料的摘要 —— 与上面 18 格同一条兜底规则（那条规则是 2026-09-26 的现场问题换来的：
     * 一格引用了物料却没写字时，早先的导出会整行不印，工厂照着一张少了一个部件的单子做伞）。
     * 内容与引用都空的行仍然不印（「空盘位自动省略」没有被这次改动推翻）。
     */
    const extraLines = (order.materialExtras ?? [])
      .map((row) => ({ label: (row.label ?? "").trim(), value: (row.content ?? "").trim() || materialRefText(row.material ?? {}) }))
      .filter((line) => line.label && line.value);
    return {
      company: "厦 门 迪 礼 伞 业 有 限 公 司",
      factory: text("factory"),
      orderNo: order.orderNo,
      // 货号（2026-09-26）：`order.itemNo` 是列名，与 37 个细化字段不同 —— 它**不在**
      // `specScalarRow` 的清单里（那是细化标量），所以直接读列名，不走 spec 翻译。
      itemNo: (order.itemNo ?? "").trim(),
      customerName: order.customer?.name ?? "",
      orderDate: dotDate(order.orderDate),
      quantityText: `${trimDecimal(order.quantity.toString())}${order.unit}`,
      productSpecText: [order.productName, order.productSpec ?? ""].map((part) => part.trim()).filter(Boolean).join(" "),
      region: order.customer?.countryRegion ?? "",
      completionText: `${dotDate(order.deliveryDate)}${text("completion_remark")}`,
      attentionNote: text("attention_note"),
      // 只印有值的行；工艺要求按留下的条目重新编号（不能出现断号）。
      materialLines: [
        ...SalesOrderExportService.MATERIAL_LABELS.map(([key, label]) => ({ label, value: text(key) || (refText.get(key) ?? "") })).filter((line) => line.value),
        ...extraLines,
      ],
      // 工艺要求：**每一点都要带标题**（用户 2026-09-26：「工艺要求那边，每一点的标题也需要显示」）。
      // 改造前只印 `1.<内容>`，看纸上的人得自己猜这一条是"样品要求"还是"裁布要求"——
      // 而 9 个栏位在界面里本来就各有中文名（`PROCESS_LABELS`），只是当年没印出来。
      processLines: SalesOrderExportService.PROCESS_LABELS.map(([key, label]) => ({ label, value: text(key) })).filter((line) => line.value),
      detailGroups: groupDetails(order.specDetails),
      // 明细列名（用户 2026-09-30）：这一单改过的名字优先，没改的用默认（`SPEC_DETAIL_LABELS`）。
      // 两种形状都认（请求键 `spec_detail_labels` = 版本快照存的形状；列名 `specDetailLabels` = 接口给的行），
      // 与 37 个细化标量当年那个坑同一条纪律：**读侧不许只认一种**。
      detailLabels: specDetailLabelsWithDefaults(specDetailLabelsOf(order as unknown as Record<string, unknown>)),
      fabricUsage: SalesOrderExportService.FABRIC_LABELS.map(([key, label]) => ({ label, value: text(key) })).filter((line) => line.value),
      shippingMarkFront: text("shipping_mark_front"),
      shippingMarkSide: text("shipping_mark_side"),
      makerName,
      madeAt: beijingDateTime(now, { seconds: true }),
      quantityNotice: quantityNotice(order)
    };
  }

  /** 单张导出：返回二进制与订单号（文件名用订单号，不用 UUID）。 */
  async exportOrder(id: string): Promise<{ buffer: Buffer; orderNo: string }> {
    return this.render(await this.loadOrder(id), []);
  }

  /**
   * 导出并把这几个栏位的物料图片排进表尾的图片区（用户 2026-09-24：
   * 「导出销售单的时候，每个有图片的物料允许用户勾选是否 excel 中一并导出这个图片。
   * excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」）。
   *
   * 图片由**浏览器**转成 JPEG 再传上来（见 `decodeSelectedImage` 里的理由），这里只负责
   * 「这张图属于哪一格、该多大、放在哪」。
   */
  async exportOrderWithImages(id: string, selected: ReadonlyArray<SelectedImageInput>): Promise<{ buffer: Buffer; orderNo: string }> {
    const order = await this.loadOrder(id);
    return this.render(order, this.resolveImages(order, selected));
  }

  /**
   * 导出弹窗要列出来的候选：这一单引用了哪些物料、各自有没有图。
   *
   * 顺序照**材料明细的印刷顺序**（`SPEC_MATERIAL_KEYS`）：弹窗里的勾选顺序与工艺单上材料行的
   * 先后一致，用户才能对着纸核对「哪张图是哪一格」。
   */
  async exportImageCandidates(id: string): Promise<ExportImageCandidate[]> {
    const order = await this.loadOrder(id);
    const rank = new Map<string, number>(SPEC_MATERIAL_KEYS.map((key, index) => [key as string, index]));
    // 「其它」行排在 18 项之后，行序照用户在界面上排的先后（`sortOrder`）。
    for (const row of order.materialExtras ?? []) rank.set(materialExtraRefKey(row.id), SPEC_MATERIAL_KEYS.length + row.sortOrder);
    const { labels, refs } = this.materialRefLookup(order);
    return [...refs.values()]
      .map((ref) => ({
        spec_key: ref.specKey,
        label: labels.get(ref.specKey) ?? ref.specKey,
        material_id: ref.material.id,
        material_code: ref.material.materialCode,
        material_name: [ref.material.name, ref.material.specificationModel, ref.material.color].map((part) => (part ?? "").trim()).filter(Boolean).join(" "),
        has_image: Boolean(ref.material.image),
        image_version: ref.material.image?.sha256 ?? null,
      }))
      // 认不出来的栏位排在最后（而不是丢掉）：那是数据出了问题，要让它看得见。
      .sort((left, right) => (rank.get(left.spec_key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.spec_key) ?? Number.MAX_SAFE_INTEGER));
  }

  /**
   * 「哪一格 / 哪一行引用了哪个物料」+「它印出来的名字」—— 导出候选与实际带图**共用一份**。
   *
   * 为什么必须共用：候选（弹窗里列出来的）与嵌图时的校验（`resolveImages`）如果各建一份映射，
   * 分叉的表现是「弹窗里勾得到、导出时报这一格没有图」，或者更糟 —— 图配到别的行上。
   * 「其它」行的键是 `extra:<行 id>`（见 `materialExtraRefKey`），标签用它自己的类目名
   * （工艺单材料那一列印的也是这个字，两处一致）。
   */
  private materialRefLookup(order: ExportOrder): { labels: Map<string, string>; refs: Map<string, MaterialRefRow> } {
    const labels = new Map<string, string>(SalesOrderExportService.MATERIAL_LABELS as ReadonlyArray<readonly [string, string]>);
    const refs = new Map<string, MaterialRefRow>((order.materialRefs ?? []).map((ref) => [ref.specKey, ref]));
    for (const row of order.materialExtras ?? []) {
      if (!row.material) continue;
      const key = materialExtraRefKey(row.id);
      labels.set(key, row.label);
      refs.set(key, { specKey: key, material: row.material });
    }
    return { labels, refs };
  }

  private async render(order: ExportOrder, images: readonly ProductionSheetImage[]): Promise<{ buffer: Buffer; orderNo: string }> {
    const names = await this.actors.namesOf([order.createdBy]);
    const workbook = new ExcelJS.Workbook();
    this.addSheet(workbook, this.document(order, names.get(order.createdBy) ?? ""), images);
    return { buffer: await this.toBuffer(workbook), orderNo: order.orderNo };
  }

  /**
   * 勾选 → 真正要嵌进表里的图片。
   *
   * 三道闸门（缺一不可）：
   *   1. `spec_key` 必须是**这一单真的引用过**的栏位，而且那个物料**确实有图** ——
   *      否则一个构造出来的请求就能把任意字节塞进导出件（字节本身没法在服务端解码校验，
   *      见 `decodeSelectedImage`，所以「这一格该不该有图」必须由服务端说了算）；
   *   2. 字节必须是 **JPEG**（ExcelJS 只认 png/jpeg/gif，WebP 写进去 Excel 打不开）；
   *   3. 单张与总量都有上限（一张工艺单塞几十张图会变成一个几百 MB 的文件）。
   */
  private resolveImages(order: ExportOrder, selected: ReadonlyArray<SelectedImageInput>): ProductionSheetImage[] {
    const { labels, refs } = this.materialRefLookup(order);
    const images: ProductionSheetImage[] = [];
    let total = 0;
    for (const item of selected) {
      const ref = refs.get(item.spec_key);
      const image = ref?.material.image ?? null;
      if (!ref || !image) {
        throw new UnprocessableEntityException({
          code: "PRODUCTION_SHEET_IMAGE_UNSUPPORTED",
          message: `「${labels.get(item.spec_key) ?? item.spec_key}」这一格没有可导出的物料图片：请先在【采购 → 物料清单】给它引用的物料上传图片`,
          details: [{ spec_key: item.spec_key }],
        });
      }
      const material = [ref.material.name, ref.material.specificationModel, ref.material.color].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
      const buffer = checkSelectedImage(item.buffer, item.spec_key);
      total += buffer.length;
      if (total > MAX_SELECTED_IMAGE_TOTAL) throw invalidImage(item.spec_key, `本次勾选的图片合计超过 ${MAX_SELECTED_IMAGE_TOTAL / 1024 / 1024}MB：请少勾几张，或换更小的图`);
      images.push({
        label: `${labels.get(item.spec_key) ?? item.spec_key}：${ref.material.materialCode}${material ? ` ${material}` : ""}`,
        buffer,
        // 用**库里存的**宽高算比例，而不是去解上传上来的 JPEG 头：比例是同一张图的比例，
        // 而库里那份尺寸是服务端自己解出来的、可信的（上传的字节只信任到「是 JPEG」为止）。
        aspect: { width: image.width, height: image.height },
      });
    }
    return images;
  }

  private async loadOrder(id: string): Promise<ExportOrder> {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id, deletedAt: null },
      include: {
        customer: true,
        specDetails: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" } },
        // 物料引用（用户 2026-09-24）：导出图片要按它把「哪一格的图」与「哪个物料」对上。
        // `image` 只取尺寸与 sha（**不取字节**）：拉一次订单详情不该把图片一起读回来。
        materialRefs: { where: { deletedAt: null }, include: { material: { select: EXPORT_MATERIAL_SELECT } } },
        // 「其它」行（2026-10-08）：既是「材料区要印的行」，也是图片导出的候选，所以这里必须带上。
        materialExtras: { where: { deletedAt: null }, orderBy: { sortOrder: "asc" }, include: { material: { select: EXPORT_MATERIAL_SELECT } } },
      }
    });
    if (!order) throw new NotFoundException({ code: "SALES_ORDER_NOT_FOUND", message: "销售单不存在", details: [] });
    return order as unknown as ExportOrder;
  }

  private addSheet(workbook: ExcelJS.Workbook, doc: ProductionSheetDocument, images: readonly ProductionSheetImage[] = []) {
    const sheet = workbook.addWorksheet((doc.orderNo || "工艺单").slice(0, 28), {
      pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
    });
    sheet.columns = COLUMN_WIDTHS.map((width) => ({ width }));
    sheet.headerFooter = { oddFooter: "&C第 &P 页 / 共 &N 页" };

    let row = 1;
    sheet.mergeCells(`A${row}:J${row}`);
    const titleCell = sheet.getCell(`A${row}`);
    titleCell.value = doc.company;
    titleCell.font = TITLE_FONT;
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(row).height = 26;
    row += 1;

    // 表头：每行恰好占满 A–J 十列（行内 标签+值 的跨列数加起来必须是 10，否则会串到 K 列）。
    // `pairs` 会把「每个值跨了几列」回报出来，行高就按这些块的折行数算（见 autoHeight）。
    this.autoHeight(sheet, row, this.pairs(sheet, row, [[["工　厂", doc.factory], 1], [["客户单号", doc.orderNo], 2], [["客户代码", doc.customerName], 2], [["下单日期", doc.orderDate], 0]]));
    row += 1;
    this.autoHeight(sheet, row, this.pairs(sheet, row, [[["数　量", doc.quantityText], 2], [["品名规格", doc.productSpecText], 4], [["地区", doc.region], 0]]));
    row += 1;
    // 货号（2026-09-26）：跟着「完工日期」那一行印 —— 该行本来只用掉 A–C 三列，右边整片空着，
    // 加一格不必动任何行号/列号。**有值才印**：老单没有货号，印出一个空格子会让改造前后的
    // 导出件产生无谓差异（验收要求「无货号时逐格一致」）。
    const completionPairs: Array<[[string, string], number]> = [[["完工日期", doc.completionText], 2]];
    if (doc.itemNo) completionPairs.push([["货　号", doc.itemNo], 0]);
    this.autoHeight(sheet, row, this.pairs(sheet, row, completionPairs));
    row += 1;

    // 注意事项：整块为空则不印（不占位）
    if (doc.attentionNote) {
      this.autoHeight(sheet, row, [this.block(sheet, row, "A", "J", `注意：${doc.attentionNote}`)]);
      row += 1;
    }

    // 正文两栏：左「材料 / 明细」，右「工艺要求」（模板的结构；两边按行号并排）
    sheet.getCell(`A${row}`).value = "材料";
    this.block(sheet, row, "B", "F", "明　细");
    this.block(sheet, row, "G", "J", "工艺要求");
    for (const column of ["A", "B", "G"]) sheet.getCell(`${column}${row}`).font = HEADER_FONT;
    row += 1;
    for (let index = 0; index < Math.max(doc.materialLines.length, doc.processLines.length); index += 1) {
      const material = doc.materialLines[index];
      // 这一行左右两栏各写各的：行高取**需要行数更多的那一栏**（`rowHeightFor` 取 max）。
      const blocks: RowHeightBlock[] = [];
      if (material) {
        sheet.getCell(`A${row}`).value = material.label;
        sheet.getCell(`A${row}`).font = HEADER_FONT;
        blocks.push(this.block(sheet, row, "B", "F", material.value));
      }
      const process = doc.processLines[index];
      if (process) blocks.push(this.block(sheet, row, "G", "J", `${index + 1}.${process.label}：${process.value}`));
      this.autoHeight(sheet, row, blocks);
      row += 1;
    }

    // 细分明细：每个分组一块；「图片」列照模板留出列位但**一律留空**
    for (const group of doc.detailGroups) {
      this.autoHeight(sheet, row, [this.block(sheet, row, "A", "J", `${doc.orderNo} ${group.groupName}（图片见客户原稿，本表不导出图片）`)]);
      sheet.getCell(`A${row}`).font = HEADER_FONT;
      row += 1;
      const headers: Array<[string, string]> = [["A", doc.detailLabels.name], ["C", "图片"], ["D", doc.detailLabels.color], ["E", doc.detailLabels.barcode], ["F", doc.detailLabels.quantity], ["G", doc.detailLabels.unit]];
      sheet.mergeCells(`A${row}:B${row}`);
      for (const [column, label] of headers) {
        sheet.getCell(`${column}${row}`).value = label;
        sheet.getCell(`${column}${row}`).font = HEADER_FONT;
      }
      row += 1;
      for (const line of group.lines) {
        sheet.mergeCells(`A${row}:B${row}`);
        sheet.getCell(`A${row}`).value = line.name;
        // C 列（图片）刻意不写值：模板要求留出列位，图片本身走表尾的图片区（见 `images`）。
        sheet.getCell(`D${row}`).value = line.color;
        sheet.getCell(`E${row}`).value = line.barcode;
        sheet.getCell(`F${row}`).value = line.quantity === "" ? null : Number(line.quantity);
        sheet.getCell(`G${row}`).value = line.unit;
        // 品名/品番是这一行唯一可能很长的一格（「27621 流水花扇PKGY」这类），按 A:B 的宽度算行高；
        // 顺带给它开自动换行 —— 不开的话算出来的高度没有意义，文字照样被截断。
        sheet.getCell(`A${row}`).alignment = { vertical: "middle", wrapText: true };
        this.autoHeight(sheet, row, [{ text: line.name, width: columnSpanWidth(COLUMN_WIDTHS, 1, 2) }]);
        row += 1;
      }
    }

    // 正唛 / 侧唛 / 布量：各自为空则整块不印
    if (doc.shippingMarkFront || doc.shippingMarkSide) {
      sheet.getCell(`A${row}`).value = "正　唛";
      sheet.getCell(`A${row}`).font = HEADER_FONT;
      const front = this.block(sheet, row, "B", "E", doc.shippingMarkFront);
      sheet.getCell(`F${row}`).value = "侧　唛";
      sheet.getCell(`F${row}`).font = HEADER_FONT;
      const side = this.block(sheet, row, "G", "J", doc.shippingMarkSide);
      this.autoHeight(sheet, row, [front, side]);
      row += 1;
    }
    for (const usage of doc.fabricUsage) {
      sheet.getCell(`A${row}`).value = usage.label;
      this.autoHeight(sheet, row, [this.block(sheet, row, "B", "E", `${usage.value}（Y/DZ)`)]);
      row += 1;
    }

    // 表尾：制单人写**姓名**（不是 UUID）；「审核」留白供手签，与模板一致
    this.autoHeight(sheet, row, [this.block(sheet, row, "A", "J", `制单：${doc.makerName}　　审核：　　制表时间：${doc.madeAt}（北京时间）`)]);
    row += 1;
    if (doc.quantityNotice) {
      this.autoHeight(sheet, row, [this.block(sheet, row, "A", "J", `核对提示：${doc.quantityNotice}`)]);
      sheet.getCell(`A${row}`).font = WARNING_FONT;
      row += 1;
    }

    // 表尾图片区（用户 2026-09-24）：只排「一排一排 + 每张下面一行标签」，位置由用户自己在 Excel 里拖。
    if (images.length) this.addImageArea(workbook, sheet, row + 1, images);
  }

  /**
   * 表尾图片区：每排 {@link IMAGES_PER_ROW} 张，每张占 {@link IMAGE_COLUMNS} 列，图片正下方是它的标签。
   *
   * 三条取舍：
   *   1. **图片锚在「一格」上（oneCellAnchor）**：`tl` 给列/行的小数偏移、`ext` 给像素尺寸。
   *      这样图片只是「浮在这一排上面」，用户在 Excel 里一拖就走 —— 正好是用户要的
   *      「让用户自行拖拽就好了」（如果用 `twoCellAnchor` 把图钉死在两个单元格之间，
   *      拖动会连带改行高列宽，反而不好收拾）；
   *   2. **行高写死 20 磅 × 7 行**：图片区的高度必须**大于**图片本身，否则 Excel 里图片会盖住
   *      下面的标签行。7 行 ≈ 187px > 130px 的最大图，留出的余量正好给拖拽；
   *   3. **标签写「序号 + 栏位名 + 物料编码/名称」**：图片拖走之后还得认得出来它原来是哪一格 ——
   *      这是「排成一排让用户自己拖」这个做法唯一的风险，标签就是补它的。
   */
  private addImageArea(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, startRow: number, images: readonly ProductionSheetImage[]) {
    let row = startRow;
    this.autoHeight(sheet, row, [this.block(sheet, row, "A", "J", `图片区：本单材料参考图（${images.length} 张，可自行拖拽到上面的对应位置）`)]);
    sheet.getCell(`A${row}`).font = HEADER_FONT;
    row += 1;

    for (let offset = 0; offset < images.length; offset += IMAGES_PER_ROW) {
      const band = images.slice(offset, offset + IMAGES_PER_ROW);
      band.forEach((image, index) => {
        const box = imageBoxFor(image.aspect);
        const id = workbook.addImage({ buffer: image.buffer as unknown as ExcelJS.Buffer, extension: "jpeg" });
        sheet.addImage(id, {
          tl: { col: index * IMAGE_COLUMNS + 0.1, row: row - 1 + 0.1 },
          ext: { width: box.width, height: box.height },
        });
      });
      for (let line = 0; line < IMAGE_BAND_ROWS; line += 1) sheet.getRow(row + line).height = 20;
      const labelRow = row + IMAGE_BAND_ROWS;
      band.forEach((image, index) => {
        const from = columnLetter(index * IMAGE_COLUMNS);
        const to = columnLetter(index * IMAGE_COLUMNS + IMAGE_COLUMNS - 1);
        this.autoHeight(sheet, labelRow, [this.block(sheet, labelRow, from, to, `${offset + index + 1}. ${image.label}`)]);
      });
      row = labelRow + 1;
    }
  }

  /**
   * 按内容设置这一行的高度（用户 2026-09-24：「行高需要自己调，不美观，太扁了」）。
   *
   * ExcelJS 不会自动算行高，所以算在服务端 —— 口径与上限见 `platform/excel/row-height.ts`。
   */
  private autoHeight(sheet: ExcelJS.Worksheet, row: number, blocks: readonly RowHeightBlock[]) {
    sheet.getRow(row).height = rowHeightFor(blocks);
  }

  /**
   * 一行里放若干「标签 + 值」：`[[标签, 值], 值的跨列数]`。
   * 跨列数 0 表示「吃掉剩下的列」——最后一段总是用它，这样每行必然正好占满 10 列。
   *
   * **返回每个值块的可用宽度**：调用方拿它算行高（表头里的「品名规格」跨 4 列、能放下 1000 字，
   * 不回报宽度就只能按整行宽度猜，猜宽了行高不够、文字被截）。
   */
  private pairs(sheet: ExcelJS.Worksheet, row: number, entries: Array<[[string, string], number]>): RowHeightBlock[] {
    const blocks: RowHeightBlock[] = [];
    let column = 1;
    for (const [[label, value], span] of entries) {
      sheet.getCell(row, column).value = label;
      sheet.getCell(row, column).font = HEADER_FONT;
      column += 1;
      const width = span === 0 ? LAST_COLUMN - column + 1 : span;
      if (width > 1) sheet.mergeCells(row, column, row, column + width - 1);
      sheet.getCell(row, column).value = value;
      // 表头的值格也开自动换行：不开的话行高算了也是白算（Excel 会把长文字截成一行）。
      sheet.getCell(row, column).alignment = { vertical: "middle", wrapText: true };
      blocks.push({ text: value, width: columnSpanWidth(COLUMN_WIDTHS, column, column + width - 1) });
      column += width;
    }
    return blocks;
  }

  /** 写一块合并区，并把它的**可用宽度**回报给调用方算行高（见 `blockWidth`）。 */
  private block(sheet: ExcelJS.Worksheet, row: number, from: string, to: string, value: string): RowHeightBlock {
    sheet.mergeCells(`${from}${row}:${to}${row}`);
    const cell = sheet.getCell(`${from}${row}`);
    cell.value = value;
    cell.alignment = { vertical: "middle", wrapText: true };
    return { text: value, width: blockWidth(from, to) };
  }

  private async toBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }
}

const LAST_COLUMN = 10;
const COLUMN_WIDTHS = [16, 14, 10, 12, 14, 10, 8, 10, 10, 10];

// --------------------------------------------------------------------------- 表尾图片区
//
// 用户 2026-09-24：「excel 中图片我们就单独排成一排放在底下的一个图片区。然后让用户自行拖拽就好了」。
// 所以这里只做**排版**，不做「把图贴到对应材料行」那件事 —— 拖拽是用户在 Excel 里自己完成的，
// 系统只要保证「每一张都在、顺序对得上、不至于糊到看不清」。

/** 每排 5 张（A–J 十列，每张占 2 列）。 */
const IMAGES_PER_ROW = 5;
/** 每张图占的列数（与下面的标签格合并宽度一致，标签才落在对应图片正下方）。 */
const IMAGE_COLUMNS = 2;
/** 单张图的最大边（像素）。工艺单是 A4 竖版，130px 打出来约 3.4cm，够看清是什么零件。 */
const IMAGE_BOX = 130;
/** 图片占的行数：7 行 × 20 磅 = 140 磅 ≈ 187px，比 130px 的图略高一点，留出拖拽的余量。 */
const IMAGE_BAND_ROWS = 7;
/** 单张图（压缩后 JPEG）的上限。 */
const MAX_SELECTED_IMAGE_BYTES = 2 * 1024 * 1024;
/** 一批图的总上限：18 格全选也不该超过这个数。 */
const MAX_SELECTED_IMAGE_TOTAL = 12 * 1024 * 1024;

/** 导出请求里挑中的一张图：栏位 + **浏览器转好的 JPEG 字节**（走 multipart 上传，不套 base64）。 */
export type SelectedImageInput = { spec_key: string; buffer: Buffer };

/** 导出弹窗的候选项（`GET /sales-orders/:id/export-images`）。 */
export type ExportImageCandidate = {
  spec_key: string;
  label: string;
  material_id: string;
  material_code: string;
  material_name: string;
  has_image: boolean;
  image_version: string | null;
};

/** 落格时用的一张图：标签 + 字节 + 原始比例。 */
export type ProductionSheetImage = { label: string; buffer: Buffer; aspect: { width: number; height: number } };

/**
 * 上传上来的图片 → JPEG 字节校验。
 *
 * ## 为什么这里只校验「是 JPEG」，不解码
 *
 * 库里存的是 **WebP**，而 ExcelJS 只认 png/jpeg/gif —— WebP media part 写进 xlsx，Excel 会画一个
 * 红叉（它的图片解码器不认 WebP）。服务端要把 WebP 转成 JPEG 就得有解码器，而用户明确选了
 * 「不引 sharp 那种原生依赖」那条路。所以转换放在**浏览器**做（它天生能解 WebP），
 * 服务端只核对「这确实是一张 JPEG」。
 *
 * 这个取舍要说清楚：`spec_key` 与「那个物料有图」由服务端把关（`resolveImages` 里查库），
 * 但**像素内容**信任上传者。这是内部工具里的导出件，最坏情况是有人给自己导出一张别的图。
 *
 * 为什么不套 base64 走 JSON：Express 的 JSON body 默认上限 100KB，十几张图必然 413；
 * 而放开全局 body 上限是拿整站的攻击面去换一个导出接口。multipart 本来就是为字节准备的。
 */
function checkSelectedImage(buffer: Buffer, specKey: string): Buffer {
  if (!buffer?.length) throw invalidImage(specKey, "图片内容为空，请重新勾选后再导出");
  if (buffer.length > MAX_SELECTED_IMAGE_BYTES) throw invalidImage(specKey, `单张图片超过 ${MAX_SELECTED_IMAGE_BYTES / 1024 / 1024}MB，请重新导出`);
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) throw invalidImage(specKey, "图片不是 JPEG（Excel 需要 JPEG/PNG 才能显示，WebP 在 Excel 里是红叉），请重新导出");
  return buffer;
}

function invalidImage(specKey: string, message: string) {
  return new UnprocessableEntityException({ code: "PRODUCTION_SHEET_IMAGE_INVALID", message, details: [{ spec_key: specKey }] });
}

/**
 * 引用物料的**兜底印刷文字**：`MAT-1 伞骨 50cm 黑`（编码 + 名称 + 规格型号 + 颜色，空的段不留多余空格）。
 *
 * 为什么带上**编码**（而勾选弹窗里的 `material_name` 不带）：这一行是「格子里没有人写的字」时才用的，
 * 看到它的人（车间/工厂）手上只有这张纸，编码是唯一能在【采购 → 物料清单】里查到的标识。
 * 与 `imageBoxFor` 一样是纯函数，单独导出便于测试直接验它。
 */
export function materialRefText(material: { materialCode?: string | null; name?: string | null; specificationModel?: string | null; color?: string | null }): string {
  return [material.materialCode, material.name, material.specificationModel, material.color].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
}

/** 等比缩到 `IMAGE_BOX` 的方框内（不放大）。 */export function imageBoxFor(aspect: { width: number; height: number }): { width: number; height: number } {
  const longest = Math.max(aspect.width, aspect.height);
  if (!Number.isFinite(longest) || longest <= 0) return { width: IMAGE_BOX, height: IMAGE_BOX };
  const scale = Math.min(1, IMAGE_BOX / longest);
  return { width: Math.max(1, Math.round(aspect.width * scale)), height: Math.max(1, Math.round(aspect.height * scale)) };
}

/** 0 起的列号 → 列字母（`IMAGE_COLUMNS` 是 2，所以只需要 A–J 这一段）。 */
function columnLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * 从订单行里取「自定义明细列名」，**两种形状都认**：先请求键（`spec_detail_labels`，版本快照的形状），
 * 再列名（`specDetailLabels`，Prisma 行/接口的形状）。
 *
 * 与 `specScalarRow` 同一类坑、同一条纪律：读侧只认一种形状的话，另一种在本库里真实存在的形状
 * 就会静默变成「没改过列名」。取不到就给 null（由 `specDetailLabelsWithDefaults` 全用默认）。
 */
export function specDetailLabelsOf(order: Record<string, unknown>): Record<string, unknown> | null {
  const fromRequestKey = order.spec_detail_labels;
  const raw = fromRequestKey === undefined || fromRequestKey === null ? order.specDetailLabels : fromRequestKey;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
}

/** 两个列字母之间的可用宽度（含两端），供 `block()` 回报行高用多少地方。 */
function blockWidth(from: string, to: string): number {
  const index = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64;
  return columnSpanWidth(COLUMN_WIDTHS, index(from), index(to));
}

const TITLE_FONT = { name: "宋体", size: 16, bold: true } as const;
const HEADER_FONT = { name: "宋体", size: 11, bold: true } as const;
const WARNING_FONT = { name: "宋体", size: 11, color: { argb: "FFB00020" } } as const;

/** `2026.6.18`（模板两张样本都是这种不补零的写法）。 */
export function dotDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const [year, month, day] = beijingDate(date).split("-");
  return `${year}.${Number(month)}.${Number(day)}`;
}

/** 数量去掉多余的小数零（模板写 `1960支`，不是 `1960.0000支`）。 */
export function trimDecimal(value: string): string {
  const text = value.trim();
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** 明细按分组归拢；组内保持查询给出的 sortOrder 顺序。 */
function groupDetails(lines: ExportOrder["specDetails"]): ProductionSheetDocument["detailGroups"] {
  const groups: ProductionSheetDocument["detailGroups"] = [];
  for (const line of lines) {
    let group = groups.find((item) => item.groupName === line.groupName);
    if (!group) {
      group = { groupName: line.groupName, lines: [] };
      groups.push(group);
    }
    group.lines.push({
      name: line.name,
      color: line.color ?? "",
      barcode: line.barcode ?? "",
      quantity: line.quantity === null ? "" : trimDecimal(line.quantity.toString()),
      unit: line.unit ?? ""
    });
  }
  return groups;
}

/**
 * 明细合计 vs 单头数量的核对提示（导出也印，与页面同一口径）。
 *
 * 这里**不复用** service 里那份：单位归一那段逻辑要按同一张同义词表来（`pcs` 与 `支` 是同一个单位，
 * 样本1 就是表头写「支」、明细写「pcs」），两边各写一遍迟早分叉，所以导出只做「完全相等才不提示」
 * 的保守判断，有疑问就提示人去核对——导出件是给工厂看的，多提示一句比少提示一句安全。
 */
function quantityNotice(order: ExportOrder): string | null {
  const lines = order.specDetails.filter((line) => line.quantity !== null);
  if (!lines.length) return null;
  const total = lines.reduce((sum, line) => sum.plus(line.quantity ?? 0), new Prisma.Decimal(0));
  return total.eq(order.quantity) ? null : `明细数量合计 ${trimDecimal(total.toString())} 与单头数量 ${trimDecimal(order.quantity.toString())} ${order.unit} 不一致，请核对`;
}

type SpecKey = (typeof SPEC_SCALAR_FIELDS)[number][0];

export type ExportOrder = {
  orderNo: string;
  /** 货号（2026-09-26）。可空：历史销售单没有货号，导出时为空串（不印这一格）。 */
  itemNo: string | null;
  /**
   * 细分明细的自定义列名（2026-09-30）。**列名形状**（接口返回的行）；版本快照那条路上的
   * 请求键形状（`spec_detail_labels`）由 `specDetailLabelsOf` 认 —— 那里是 `Record<string, unknown>`。
   */
  specDetailLabels?: Record<string, string> | null;
  orderDate: Date;
  deliveryDate: Date | null;
  productName: string;
  productSpec: string | null;
  quantity: Prisma.Decimal;
  unit: string;
  createdBy: string;
  customer: { name: string; countryRegion: string | null } | null;
  specDetails: Array<{ groupName: string; name: string; color: string | null; barcode: string | null; quantity: Prisma.Decimal | null; unit: string | null }>;
  /**
   * 材料明细里对物料的引用（2026-09-24）。可空：历史销售单没有引用，
   * 而**所有读它的地方都要 `?? []`**（测试夹具也大多不写这一项）。
   * `image` 只取尺寸与 sha，绝不取 `data`。
   */
  materialRefs?: Array<{
    specKey: string;
    material: {
      id: string;
      materialCode: string;
      name: string;
      specificationModel: string | null;
      color: string | null;
      image: { width: number; height: number; sha256: string } | null;
    };
  }>;
  /**
   * 「材料明细 → 其它」行（用户 2026-10-08）。可空：历史销售单没有这些行，
   * 而**所有读它的地方都要 `?? []`**（与 `materialRefs` 同一条纪律）。
   *
   * `id` 是图片导出用的键（`extra:<id>`，见 `materialExtraRefKey`）；`sortOrder` 决定印在
   * 18 项之后的先后；`material` 可空 = 这一行只填了文字。
   */
  materialExtras?: Array<{
    id: string;
    label: string;
    content: string | null;
    sortOrder: number;
    material: {
      id: string;
      materialCode: string;
      name: string;
      specificationModel: string | null;
      color: string | null;
      image: { width: number; height: number; sha256: string } | null;
    } | null;
  }>;
  /**
   * 37 个细化标量**不在这里逐条列**：它们由 `specScalarRow` 从行上按请求键/列名取（见 `document`）。
   * 以前这里留了个 `[specKey: string]: unknown` 索引签名，等于告诉编译器「随便按什么名字取都行」——
   * 于是「按请求键取 camelCase 行」这个错永远编译得过、测试也测不出来。索引签名已删除。
   */
};

/** 一行「引用了某个物料」的读侧形状：18 个固定栏位（`materialRefs`）与「其它」行共用一份。 */
type MaterialRefRow = NonNullable<ExportOrder["materialRefs"]>[number];

export type ProductionSheetDocument = {
  company: string;
  factory: string;
  orderNo: string;
  /** 货号（2026-09-26）：空串 = 不印这一格（历史单与改造前逐格一致）。 */
  itemNo: string;
  customerName: string;
  orderDate: string;
  quantityText: string;
  productSpecText: string;
  region: string;
  completionText: string;
  attentionNote: string;
  materialLines: Array<{ label: string; value: string }>;
  /** 工艺要求：**带标题**的条目（`label` = 栏位中文名，如「样品要求」），导出落格时编成 `1.样品要求：…`。 */
  processLines: Array<{ label: string; value: string }>;
  detailGroups: Array<{ groupName: string; lines: Array<{ name: string; color: string; barcode: string; quantity: string; unit: string }> }>;
  /**
   * 细分明细的**列名**（2026-09-30）：默认 6 个中文名与这一单的自定义覆盖合并后的结果，
   * 落格直接用它。`group_name` 这一项在导出件里**没有列位**（模板版式没有"分组名"列，
   * 分组是靠分组标题行表达的），所以它只影响编辑页 —— 这一条写在设计文档里，不装作没这回事。
   */
  detailLabels: Record<string, string>;
  fabricUsage: Array<{ label: string; value: string }>;
  shippingMarkFront: string;
  shippingMarkSide: string;
  makerName: string;
  madeAt: string;
  quantityNotice: string | null;
};
