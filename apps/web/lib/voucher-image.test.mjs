// 凭证「一键导出 PNG」的纯逻辑测试（Node 直接 import .ts，靠 Node 的类型擦除）。
//
// 浏览器位图化（SVG → canvas → PNG）没法在 Node 里跑，这里只覆盖：
//   1) 文件名、XML 转义、单元格裁剪这些容易出错的小逻辑；
//   2) 组版出来的 SVG **内容**（凭证号/科目/借贷金额/合计/尺寸）——PNG 就是它的位图；
//   3) 环境不支持时的**可执行报错**（提示改用打印/另存 PDF），而不是丢一个英文异常。
import test from "node:test";
import assert from "node:assert/strict";
import { escapeXml, exportVoucherPng, fitText, svgSize, voucherFileName, voucherPngBlob, voucherSvg } from "./voucher-image.ts";

const voucher = (over = {}) => ({
  voucherNo: "记-2026-09-0001",
  voucherDate: "2026-09-15T00:00:00.000Z",
  period: "2026-09",
  currency: "USD",
  status: "draft",
  statusLabel: "草稿",
  summary: "香港迪礼 · 货款",
  debitTotal: "14310.0000",
  creditTotal: "14310.0000",
  sourceLabel: "收支流水 CF-20260915-0001",
  // 制单人必须是**姓名**：字段名从 createdBy 改成 makerName 就是为了让「传了 UUID」一眼可见
  // （2026-09-16 之前这里传 voucher.createdBy，凭证图片上印的是「制单：6f3a1c8e-…」）。
  makerName: "张三",
  lines: [
    { lineNo: 1, direction: "debit", subjectLabel: "银行存款", summary: "香港迪礼 · 货款", amount: "14310.0000" },
    { lineNo: 2, direction: "credit", subjectLabel: "货款", summary: "香港迪礼 · 货款", amount: "14310.0000" },
  ],
  ...over,
});

test("文件名：带凭证号且做了文件名安全化（Windows 非法字符与空格）", () => {
  assert.equal(voucherFileName("记-2026-09-0001"), "记账凭证-记-2026-09-0001.png");
  assert.equal(voucherFileName('记/2026:09*0001?'), "记账凭证-记-2026-09-0001-.png");
  assert.equal(voucherFileName(""), "记账凭证-凭证.png", "空凭证号也要给出可用文件名");
});

test("XML 转义：摘要里的 & < > \" ' 不会破坏 SVG", () => {
  assert.equal(escapeXml("甲 & 乙 <丙> \"丁\" '戊'"), "甲 &amp; 乙 &lt;丙&gt; &quot;丁&quot; &apos;戊&apos;");
  const svg = voucherSvg(voucher({ summary: "A&B <test>", lines: [{ lineNo: 1, direction: "debit", subjectLabel: "银行&现金", summary: "A&B <test>", amount: "1.0000" }] }));
  assert.match(svg, /A&amp;B &lt;test&gt;/);
  assert.match(svg, /银行&amp;现金/);
  assert.equal(/<test>/.test(svg), false, "原始尖括号不能出现在 SVG 里");
});

test("单元格裁剪：CJK 按 1em、ASCII 按 0.55em 估算，超出加省略号", () => {
  assert.equal(fitText("短期", 100, 14), "短期");
  assert.equal(fitText("一二三四五六", 56, 14), "一二三四…", "56px 宽只放得下 4 个汉字 + 省略号");
  assert.equal(fitText("abcdefghij", 70, 14), "abcdefghi…", "ASCII 每字符约 7.7px → 70px 放得下 9 个");
});

test("组版：凭证纸该有的要素都在（标题/凭证号/期间/来源/科目/借贷金额/合计）", () => {
  const svg = voucherSvg(voucher());
  for (const expected of ["记 账 凭 证", "记-2026-09-0001", "2026-09", "USD", "草稿", "收支流水 CF-20260915-0001", "银行存款", "货款", "合计", "借方金额", "贷方金额", "会计科目", "单位负责人"]) {
    assert.ok(svg.includes(expected), `SVG 里应该出现「${expected}」`);
  }
  assert.ok(svg.includes("14310.0000 USD"), "金额带币种，与页面 money() 口径一致");
  assert.equal(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""), true);
  assert.equal(svg.trimEnd().endsWith("</svg>"), true);
});

test("组版：借方金额只出现在借方格、贷方金额只出现在贷方格（不能串列）", () => {
  const svg = voucherSvg(voucher({
    lines: [
      { lineNo: 1, direction: "debit", subjectLabel: "原材料 成本", summary: "绍兴纺织 · 原材料", amount: "5200.0000" },
      { lineNo: 2, direction: "credit", subjectLabel: "银行存款", summary: "绍兴纺织 · 原材料", amount: "5200.0000" },
    ],
    debitTotal: "5200.0000", creditTotal: "5200.0000",
  }));
  const debitRow = /<text x="612"[^>]*>5200\.0000 USD<\/text>/.test(svg);
  const creditRow = /<text x="948"[^>]*>5200\.0000 USD<\/text>/.test(svg);
  assert.equal(debitRow, true, "借方金额画在借方列（右对齐 x=612）");
  assert.equal(creditRow, true, "贷方金额画在贷方列（右对齐 x=948）");
});

test("组版：行数变化时画布高度跟着长（多行分录不会被裁掉）", () => {
  const one = svgSize(voucherSvg(voucher()));
  const many = svgSize(voucherSvg(voucher({
    lines: Array.from({ length: 8 }, (_, index) => ({ lineNo: index + 1, direction: index % 2 ? "credit" : "debit", subjectLabel: "科目", summary: "摘要", amount: "1.0000" })),
  })));
  assert.equal(one.width, 1000);
  assert.ok(many.height > one.height, `8 行分录的画布应更高（${many.height} > ${one.height}）`);
});

test("备注行只在有备注时出现（没有备注不留空行）", () => {
  assert.equal(/备注：/.test(voucherSvg(voucher())), false);
  assert.equal(/备注：科目挂错/.test(voucherSvg(voucher({ remark: "科目挂错" }))), true);
});

test("非浏览器环境导出时给出可执行的报错（提示改用打印 / 另存 PDF）", async () => {
  await assert.rejects(() => voucherPngBlob("<svg></svg>"), /改用「打印 \/ 另存 PDF」/);
  await assert.rejects(() => exportVoucherPng(voucher()), /改用「打印 \/ 另存 PDF」/);
});

test("svgSize：从根标签读宽高，坏输入直接抛错而不是生成 0×0 的画布", () => {
  assert.deepEqual(svgSize('<svg width="1000" height="672">'), { width: 1000, height: 672 });
  assert.throws(() => svgSize("<svg>"), /尺寸解析失败/);
});
