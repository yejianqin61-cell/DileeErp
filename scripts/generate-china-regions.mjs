/**
 * 生成「身份证前 6 位 → 省 / 市 / 区县」用的行政区划代码表（GB/T 2260）。
 *
 * 为什么要有这个脚本：区划代码是**外部数据**，不是业务逻辑。手抄一份进仓库既容易抄错、
 * 也没法复现来源；这里把「下载 → 校验 → 生成」固化下来，任何时候都能重新生成并核对指纹。
 *
 * 生成物（两个 App 各一份，内容**逐字节相同**）：
 *   apps/api/src/modules/production/china-region.ts
 *   apps/web/lib/china-region.ts
 * 为什么不抽公共包：本仓库是 apps/* 双 workspace，没有共享包（币种字典也是两边各一份的既有约定）。
 * 两边内容完全一致 + API 单测比对两份文件的字节，用最低成本消掉「两套数据漂移」的风险。
 *
 * 用法：
 *   node scripts/generate-china-regions.mjs                 # 联网下载最新数据后生成
 *   node scripts/generate-china-regions.mjs <本地json路径>   # 用本地快照重新生成（离线）
 *
 * 注意：身份证前 6 位是**签发当时**的区划代码，老号码里可能是已撤销的代码
 * （例如 413028 = 原信阳地区罗山县，现为 411521）。查不到就按「能查到哪一级用哪一级」降级，
 * 因此这里只做**取名**，不做任何身份证合法性判断。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/pca-code.json";
const HISTORY_URL = "https://raw.githubusercontent.com/yescallop/areacodes/master/codes.json";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  join(REPO_ROOT, "apps", "api", "src", "modules", "production", "china-region.ts"),
  join(REPO_ROOT, "apps", "web", "lib", "china-region.ts"),
];

/**
 * 两份源文件的加载：都允许用本地快照（离线重跑），否则联网下载。
 * 第 1 个参数 = 现行区划（省/市/区县），第 2 个参数 = 历史区划（含已撤销代码）。
 */
async function loadSource(localPath, url) {
  if (localPath) return readFileSync(resolve(localPath), "utf8");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${url}：HTTP ${response.status}`);
  return await response.text();
}

/**
 * 把「省 → 市 → 区县」三层树压成一张 code → 名称 的平表。
 * 只保留 2 位（省级）/ 4 位（市级）/ 6 位（区县级）代码：数据源里东莞、中山、儋州、嘉峪关
 * 这类「不设区的地级市」往下挂到了 9 位街道/镇级代码，而身份证前 6 位用不到街道，
 * 留着只会白白撑大表（这几市的身份证前 6 位是 441900 / 442000 这种市级码 + 00，
 * 查不到区县正好降级成「广东省东莞市」，与真实地址一致）。
 */
function flatten(tree) {
  const table = new Map();
  for (const province of tree) {
    table.set(String(province.code), province.name);
    for (const city of province.children ?? []) {
      table.set(String(city.code), city.name);
      for (const county of city.children ?? []) {
        const code = String(county.code);
        if (code.length === 6) table.set(code, county.name);
      }
    }
  }
  return table;
}

/**
 * 用历史区划补齐现行表里没有的代码 —— 这是本表最关键的一步：
 * 身份证前 6 位是**签发当时**的代码，老号码里大量是已撤销代码，只查现行表会只剩省级
 * （实测花名册 10 人里有 3 人如此：413028 原信阳地区罗山县、522228 原铜仁地区沿河县）。
 *
 * 规则：现行表已有的代码**不覆盖**（现行国标优先）；只在现行表缺失时补，
 * 同一个历史代码出现多次（改名/重组）时取 start 年份最大的那个名字。
 * 结果就是老号码也能得到当时的省市县名称（如「河南省信阳地区罗山县」），而不是硬凑成现代行政区。
 */
function mergeHistory(table, tree) {
  const starts = new Map();
  const fill = (code, name, start) => {
    if (!code || !name) return;
    if (table.has(code)) return;
    const year = Number(start) || 0;
    if ((starts.get(code) ?? -1) > year) return;
    starts.set(code, year);
    table.set(code, name);
  };
  for (const province of tree) {
    const provinceCode = String(province.code);
    fill(provinceCode.slice(0, 2), province.name, province.start);
    for (const city of province.children ?? []) {
      const cityCode = String(city.code);
      fill(cityCode.slice(0, 4), city.name, city.start);
      for (const county of city.children ?? []) {
        const countyCode = String(county.code);
        if (countyCode.length === 6) fill(countyCode, county.name, county.start);
      }
    }
  }
  return table;
}

/** 生成一份「身份证前 6 位 → 省 / 市 / 区县」的数据模块。 */
function render(table, sources, currentCount) {
  const entries = [...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const packed = entries.map(([code, name]) => `${code}:${name}`).join(";");
  const provinces = entries.filter(([code]) => code.length === 2).length;
  const cities = entries.filter(([code]) => code.length === 4).length;
  const counties = entries.filter(([code]) => code.length === 6).length;
  const historicalOnly = entries.length - currentCount;
  return `/**
 * 行政区划代码表（GB/T 2260）：身份证前 6 位 → 省 / 市 / 区县。
 *
 * ⚠️ 本文件由 scripts/generate-china-regions.mjs 生成，**不要手改**（改了下次生成就没了）。
 * 两个 App 各有一份**内容完全相同**的副本（API 与 Web），保证「导入解析」和「页面填表解析」结果一致。
 *
 * 数据源（两份合并）：
 *   1. 现行区划：${SOURCE_URL}
 *      sha256 ${sources.current.hash}
 *   2. 历史区划（含已撤销代码）：${HISTORY_URL}
 *      sha256 ${sources.history.hash}
 * 覆盖：省 ${provinces} / 市 ${cities} / 区县 ${counties}（共 ${entries.length} 条，其中 ${historicalOnly} 条只存在于历史区划）
 *
 * 为什么必须带历史代码：身份证前 6 位是**签发当时**的区划代码，且终生不变。老号码里大量是
 * 已撤销代码（如 413028 = 原信阳地区罗山县，现为 411521；522228 = 原铜仁地区沿河县，现为 520627），
 * 只查现行表这些人就只能得到省级。合并历史数据后它们能还原成**当时的**省市县名称，
 * 而不是硬凑成现代行政区。
 *
 * 降级规则：逐级独立取名 —— 区县查不到就只给省市，市查不到就只给省，全都查不到就是空串。
 * 地址宁缺勿错，绝不用近似代码硬凑。
 */

export type ChinaRegion = {
  /** 省级名称，查不到为空串（如「福建省」） */
  province: string;
  /** 地级名称，查不到为空串（如「厦门市」，老代码可能是「信阳地区」这类历史名称） */
  city: string;
  /** 区县名称，查不到为空串（如「同安区」） */
  county: string;
  /** 拼好的地址前缀：福建省厦门市同安区（直辖市会去掉「市辖区」这类伪市级，不会出现「北京市市辖区东城区」） */
  label: string;
};

/** 直辖市/省直辖的伪市级名称，拼地址时必须跳过。 */
const PSEUDO_CITY = new Set(["市辖区", "县", "省辖县级行政区划", "省直辖县级行政区划", "自治区直辖县级行政区划", "直辖县级行政区划"]);

/** code → 名称（2 位省级 / 4 位市级 / 6 位区县级都在同一张表里）。首次使用时才切分。 */
const PACKED = "${packed}";
let table: Map<string, string> | null = null;
function regionTable() {
  if (!table) {
    table = new Map();
    for (const entry of PACKED.split(";")) {
      const at = entry.indexOf(":");
      if (at > 0) table.set(entry.slice(0, at), entry.slice(at + 1));
    }
  }
  return table;
}

/** 表里一共有多少条（省 + 市 + 区县）。 */
export const CHINA_REGION_COUNT = ${entries.length};

/**
 * 按 6 位行政区划代码取省 / 市 / 区县。
 * 逐级独立查表：老代码缺区县时仍能给出省市，缺市时仍能给出省；完全查不到就都是空串。
 */
export function lookupRegion(code: string | number | null | undefined): ChinaRegion {
  const digits = String(code ?? "").replace(/\\D/g, "");
  const names = regionTable();
  const province = digits.length >= 2 ? names.get(digits.slice(0, 2)) ?? "" : "";
  const city = digits.length >= 4 ? names.get(digits.slice(0, 4)) ?? "" : "";
  const county = digits.length >= 6 ? names.get(digits.slice(0, 6)) ?? "" : "";
  const parts: string[] = [];
  for (const name of [province, city, county]) {
    if (!name || PSEUDO_CITY.has(name)) continue;
    if (parts[parts.length - 1] === name) continue;
    parts.push(name);
  }
  return { province, city, county, label: parts.join("") };
}

/** 只要地址前缀（省市县拼好的那一串）。 */
export const regionLabel = (code: string | number | null | undefined) => lookupRegion(code).label;
`;
}

const currentSource = (await loadSource(process.argv[2], SOURCE_URL)).replace(/^\uFEFF/, "");
const historySource = (await loadSource(process.argv[3], HISTORY_URL)).replace(/^\uFEFF/, "");
const sources = {
  current: { hash: createHash("sha256").update(currentSource, "utf8").digest("hex") },
  history: { hash: createHash("sha256").update(historySource, "utf8").digest("hex") },
};
const table = flatten(JSON.parse(currentSource));
const currentCount = table.size;
mergeHistory(table, JSON.parse(historySource).items);
const content = render(table, sources, currentCount);
for (const target of TARGETS) {
  writeFileSync(target, content, "utf8");
  console.log(`generated ${target}`);
}
console.log(`entries=${table.size} (+${table.size - currentCount} from history) bytes=${Buffer.byteLength(content, "utf8")}`);
