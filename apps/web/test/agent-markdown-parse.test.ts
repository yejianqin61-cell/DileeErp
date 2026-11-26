import { describe, expect, it } from "vitest";
import type { Nodes } from "mdast";
import { toMdAst } from "../features/agent-chat/markdown/parse";

function flatten(node: Nodes): Nodes[] {
  return [node, ...("children" in node ? node.children.flatMap((child) => flatten(child as Nodes)) : [])];
}

const nodesOf = (source: string) => flatten(toMdAst(source));
const typesOf = (source: string) => nodesOf(source).map((node) => node.type);
const textOf = (source: string) => nodesOf(source).map((node) => ("value" in node ? node.value : "")).join("");
const valuesOf = (source: string, type: string) => nodesOf(source).flatMap((node) => (node.type === type && "value" in node ? [node.value] : []));

describe("toMdAst · 公式写法", () => {
  it("单个 $ 不算公式，金额一字不差", () => {
    const source = "金额 $1,200 到 $1,500";

    expect(typesOf(source)).not.toContain("inlineMath");
    expect(typesOf(source)).not.toContain("math");
    expect(textOf(source)).toBe(source);
  });

  it("单独一段的 $$…$$ 是公式", () => {
    const math = nodesOf("$$E=mc^2$$").filter((node) => node.type === "math" || node.type === "inlineMath");

    expect(math.map((node) => ("value" in node ? node.value : ""))).toEqual(["E=mc^2"]);
  });

  it("\\(…\\) 是行内公式", () => {
    expect(valuesOf("勾股 \\(a^2+b^2\\) 成立", "inlineMath")).toEqual(["a^2+b^2"]);
  });

  it("\\[…\\] 是块级公式", () => {
    expect(valuesOf("\\[\nx+y\n\\]", "math")).toEqual(["x+y"]);
  });
});

describe("toMdAst · 安全改写", () => {
  it.each(["[x](javascript:alert(1))", "[y](/hr)", "![图](https://a.com/i.png)", "[m](mailto:a@b.com)", "[d](data:text/html,x)"])("%s 保留原文，不产生链接或图片", (source) => {
    expect(typesOf(source)).not.toContain("link");
    expect(typesOf(source)).not.toContain("image");
    expect(textOf(source)).toBe(source);
  });

  it("引用式链接与定义保留原文", () => {
    const source = "见 [说明][1]\n\n[1]: javascript:alert(1)";

    expect(typesOf(source).filter((type) => ["link", "linkReference", "definition"].includes(type))).toEqual([]);
    expect(textOf(source)).toContain("[说明][1]");
    expect(textOf(source)).toContain("[1]: javascript:alert(1)");
  });

  it("http(s) 链接保留", () => {
    const links = nodesOf("[文档](https://example.com)").filter((node) => node.type === "link");

    expect(links.map((node) => (node.type === "link" ? node.url : ""))).toEqual(["https://example.com"]);
  });

  it("删除线保留定界符，数量区间不丢字", () => {
    expect(typesOf("交期 10~20 天，~~作废~~")).not.toContain("delete");
    expect(textOf("交期 10~20 天，~~作废~~")).toBe("交期 10~20 天，~~作废~~");
  });

  it("缩进四格的列表仍是列表，不变成代码块", () => {
    expect(typesOf("    - 甲\n    - 乙")).toContain("list");
  });
});

describe("toMdAst · 流式半截输入", () => {
  it.each([
    ["```ts\nconst total = 1;", "const total = 1;"],
    ["| 单号 | 数量 |\n| --- |", "单号"],
    ["订单 **半个", "半个"],
    ["公式 $$E=mc", "E=mc"],
  ])("%j 不抛异常且已到的字都在", (source, arrived) => {
    expect(textOf(source)).toContain(arrived);
  });
});
