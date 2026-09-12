// 刷新策略的回归测试 + 页面接线守卫。
//
// 背景：原料入库在仓库侧过账后，采购页/仓储页的状态列如果只在挂载时拉一次，
// 就一直显示旧状态（“入库状态没有及时更新”）。因此这两页必须注册焦点刷新并带刷新按钮。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRefreshOnVisibility } from "./refresh-policy.ts";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

test("只在页面可见时刷新，后台标签页不刷新", () => {
  assert.equal(shouldRefreshOnVisibility("visible"), true);
  assert.equal(shouldRefreshOnVisibility("hidden"), false);
  assert.equal(shouldRefreshOnVisibility(undefined), false);
  assert.equal(shouldRefreshOnVisibility(null), false);
});

test("展示入库状态的页面必须注册焦点/可见性刷新并提供刷新按钮", () => {
  const pages = ["app/warehouse/raw-material-storage/page.tsx", "app/procurement/page.tsx"];
  for (const file of pages) {
    const source = readFileSync(join(webRoot, file), "utf8");
    assert.match(source, /shouldRefreshOnVisibility/, `${file} 未使用统一的刷新判定`);
    assert.match(source, /addEventListener\("focus"/, `${file} 未注册窗口焦点刷新`);
    assert.match(source, /addEventListener\("visibilitychange"/, `${file} 未注册可见性刷新`);
    assert.match(source, /removeEventListener\("focus"/, `${file} 必须解绑事件，避免重复注册`);
    assert.match(source, /onClick=\{\(\) => void load\(\)\}>刷新</, `${file} 缺少“刷新”按钮`);
  }
});

test("仓储页的入库状态要显示中文，不能直接暴露英文原值", () => {
  const source = readFileSync(join(webRoot, "app/warehouse/raw-material-storage/page.tsx"), "utf8");
  assert.match(source, /inboundStatusLabels/, "仓储页应使用中文状态映射");
  assert.match(source, /draft: "待入库登记"/);
  assert.match(source, /posted: "入库成功"/);
});

// 用户反馈：「新建物料界面老是会重新加载，切到别的软件复制数据再切回来，刚填的内容就没了」。
// 原因是焦点/可见性刷新调用 load() 时会 setLoading(true)，页面切回整页 loading，
// 把正在编辑的弹窗（ActionDialog 的输入是组件内部 state）连同 DOM 一起卸载。
test("后台刷新必须静默：不能切整页 loading（会卸载正在编辑的弹窗、清空用户输入）", () => {
  const pages = [
    "app/procurement/page.tsx",
    "app/warehouse/raw-material-storage/page.tsx",
    "app/warehouse/finished-goods-storage/page.tsx",
    "components/production/production-order-detail-page.tsx",
  ];
  for (const file of pages) {
    const source = readFileSync(join(webRoot, file), "utf8");
    assert.match(source, /load\(\{ silent: true \}\)|load\(undefined, \{ silent: true \}\)/, `${file} 的后台刷新必须静默`);
    assert.match(source, /if \(!options\.silent\) setLoading\(true\)/, `${file} 的 load 必须支持 silent 选项`);
    assert.match(source, /if \(!options\.silent\) setLoading\(false\)/, `${file} 的 silent 刷新不能把 loading 置回初始态`);
  }
});
