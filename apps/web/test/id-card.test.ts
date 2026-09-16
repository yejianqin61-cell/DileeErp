// 身份证号解析（页面填表用）的行为测试 + 「两份区域表不许漂移」的守卫。
//
// 为什么 Web 侧要单独测：本仓库没有共享包，「填完身份证号立刻跳出出生日期/性别」必须在浏览器本地
// 完成（不能每敲一位就打接口），所以 apps/web/lib/id-card.ts 是后端 parseIdCard 的**行为等价副本**。
// 这里用同一批身份证号（含花名册里的真实号码与老区划代码）钉住结果，任何一边改坏了都会红。
//
// 放在 test/ 而不是 lib/*.test.mjs：lib/ 下的测试用 node:test 直跑 .ts，而 Node 原生类型擦除
// 要求相对导入必须写全扩展名（`./china-region.ts`），那又会让 tsc/next build 报错
// （不允许 ts 扩展名）。走 vitest 就能按 TS 的方式解析 import，与其它组件测试同一套配置。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveEmployeeFieldsFromIdCard, lookupRegion, parseIdCard } from "../lib/id-card";

// 官方脚本在 apps/web 下跑 vitest（cwd = apps/web），但也允许在仓库根用 --root apps/web 跑，
// 因此两个候选目录都试一下，取真的装着 lib/china-region.ts 的那个。
const webRoot = [process.cwd(), join(process.cwd(), "apps", "web")].find((dir) => existsSync(join(dir, "lib", "china-region.ts")));
if (!webRoot) throw new Error("找不到 apps/web 根目录（lib/china-region.ts 不存在）");
const read = (...parts: string[]) => readFileSync(join(webRoot, ...parts), "utf8");

describe("身份证号解析 · 出生日期与性别", () => {
  it("18 位：解析出生日期、性别与省市县", () => {
    const result = parseIdCard("350430198405204527");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.birthDate).toBe("1984-05-20");
    expect(result.value.gender).toBe("女");
    expect(result.value.region).toEqual({ province: "福建省", city: "三明市", county: "建宁县", label: "福建省三明市建宁县" });
    expect(result.value.addressPrefix).toBe("福建省三明市建宁县");
  });

  it("15 位老号：按 19xx 补全出生日期，同样能解析地区", () => {
    const result = parseIdCard("350430840520452");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.birthDate).toBe("1984-05-20");
    expect(result.value.gender).toBe("女");
    expect(result.value.region.label).toBe("福建省三明市建宁县");
  });

  it("校验位不匹配 / 位数不对：明确拒绝，不猜", () => {
    const wrongCheck = parseIdCard("350430198405204521");
    expect(wrongCheck.ok).toBe(false);
    if (!wrongCheck.ok) expect(wrongCheck.reason).toMatch(/校验位/);
    expect(parseIdCard("35043019840520").ok).toBe(false);
    expect(parseIdCard("").ok).toBe(false);
    expect(parseIdCard("      ").ok).toBe(false);
    expect(parseIdCard(null).ok).toBe(false);
  });

  it("已撤销的老区划代码也能解析出当时的省市县（合历史数据的关键收益）", () => {
    // 413028 = 原信阳地区罗山县（现 411521 信阳市罗山县）
    const henan = parseIdCard("413028196510110959");
    expect(henan.ok).toBe(true);
    if (henan.ok) expect(henan.value.region.label).toBe("河南省信阳地区罗山县");
    // 522228 = 原铜仁地区沿河土家族自治县（现 520627 铜仁市）
    const guizhou = parseIdCard("522228197804083626");
    expect(guizhou.ok).toBe(true);
    if (guizhou.ok) expect(guizhou.value.region.label).toBe("贵州省铜仁地区沿河土家族自治县");
  });

  it("区划代码查不到不影响出生日期与性别，也不判定身份证非法", () => {
    // 999999198405204525：校验位自洽，但 999999 不是任何区划代码
    const result = parseIdCard("999999198405204525");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.birthDate).toBe("1984-05-20");
    expect(result.value.region).toEqual({ province: "", city: "", county: "", label: "" });
  });
});

describe("行政区划取名", () => {
  it("直辖市 / 省直辖 / 不设区市 / 伪市级都拼得干净", () => {
    // 直辖市的「市辖区」是伪市级，必须跳过，否则会拼成「北京市市辖区东城区」
    expect(lookupRegion("110101").label).toBe("北京市东城区");
    // 重庆的县挂在伪市级「县」下面
    expect(lookupRegion("500229").label).toBe("重庆市城口县");
    // 海南省直辖县级市
    expect(lookupRegion("469001").label).toBe("海南省五指山市");
    // 新疆自治区直辖县级市
    expect(lookupRegion("659001").label).toBe("新疆维吾尔自治区石河子市");
    // 东莞 / 中山不设区，身份证前 6 位是市级码 + 00，查不到区县正好降级成市
    expect(lookupRegion("441900").label).toBe("广东省东莞市");
    expect(lookupRegion("442000").label).toBe("广东省中山市");
  });

  it("逐级降级：只有 4 位 / 2 位也能用，完全查不到就是空串", () => {
    expect(lookupRegion("3504").label).toBe("福建省三明市");
    expect(lookupRegion("35").label).toBe("福建省");
    expect(lookupRegion("999999").label).toBe("");
    expect(lookupRegion("").label).toBe("");
    expect(lookupRegion(null).label).toBe("");
  });
});

describe("表单联动：身份证填完自动补字段", () => {
  it("三个字段都空 → 全补上（地址只给省市县前缀，详细住址留给人填）", () => {
    expect(deriveEmployeeFieldsFromIdCard("350430198405204527", {})).toEqual({
      birth_date: "1984-05-20",
      gender: "女",
      home_address: "福建省三明市建宁县 ",
    });
  });

  it("操作员手填过的值不能被覆盖", () => {
    expect(
      deriveEmployeeFieldsFromIdCard("350430198405204527", { birth_date: "1984-05-21", gender: "男", home_address: "同安区新民镇" }),
    ).toEqual({});
  });

  it("只填了一部分 → 只补没填的那些", () => {
    expect(deriveEmployeeFieldsFromIdCard("350430198405204527", { gender: "男" })).toEqual({
      birth_date: "1984-05-20",
      home_address: "福建省三明市建宁县 ",
    });
  });

  it("身份证还没填完 / 填错 → 一个字段都不动", () => {
    expect(deriveEmployeeFieldsFromIdCard("3504301984", {})).toEqual({});
    expect(deriveEmployeeFieldsFromIdCard("350430198405204521", {})).toEqual({});
  });
});

describe("区域表副本守卫", () => {
  it("apps/web/lib/china-region.ts 与 API 那份逐字节相同", () => {
    const webCopy = read("lib", "china-region.ts");
    const apiCopy = read("..", "api", "src", "modules", "production", "china-region.ts");
    expect(webCopy).toBe(apiCopy);
    // 生成物应当包含完整的省市区县数据（防止有人把它换成小样本）
    expect(webCopy.length).toBeGreaterThan(50_000);
  });
});
