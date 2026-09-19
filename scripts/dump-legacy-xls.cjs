// 一次性工具：把老表 .xls 原样 dump 成文本，供口径对齐使用（不入库、不提交）。
const path = require("path");
const XLSX = require(path.join(process.cwd(), "node_modules", "xlsx"));

const target = process.argv[2];
const wb = XLSX.readFile(target, { cellDates: false, cellNF: false, cellStyles: false });

const out = [];
out.push("FILE: " + target);
out.push("SHEETS: " + JSON.stringify(wb.SheetNames));
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const ref = ws["!ref"] || "(empty)";
  const merges = ws["!merges"] || [];
  out.push("");
  out.push("=".repeat(100));
  out.push("SHEET: " + name + "   ref=" + ref + "   merges=" + merges.length);
  out.push("=".repeat(100));
  const rows = XLSX.utils.decode_range(ref);
  for (let r = rows.s.r; r <= rows.e.r; r += 1) {
    const cells = [];
    for (let c = rows.s.c; c <= rows.e.c; c += 1) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      let v = cell.w !== undefined ? cell.w : cell.v;
      if (typeof v === "string") v = v.replace(/\s+/g, " ").trim();
      if (v === "" || v === undefined || v === null) continue;
      cells.push(XLSX.utils.encode_col(c) + (r + 1) + " [" + cell.t + "] " + v);
    }
    if (cells.length) out.push("R" + (r + 1) + " | " + cells.join("  ||  "));
  }
  if (merges.length) {
    out.push("-- merges: " + merges.map((m) => XLSX.utils.encode_range(m)).join(", "));
  }
}
console.log(out.join("\n"));
