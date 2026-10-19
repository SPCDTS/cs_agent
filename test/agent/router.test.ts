import { describe, expect, it } from "vitest";
import { DEFAULT_IMAGE_PREFIXES, IMAGE_USAGE_REPLY, parseInlineImageOptions, parseImagePrefixes, routeMessage } from "../../src/agent/router.js";
import { legacyRouteText } from "../../src/channel/ticket.js";

describe("rule router (§4.1)", () => {
  it.each(['__proto__', 'constructor', 'toString'])('原型键 %s 留在提示词中', token => {
    expect(parseInlineImageOptions(token + ' 横 猫')).toEqual({ prompt: token + ' 横 猫' });
  });
  it("half-width and full-width colon prefixes route to image with the raw remainder as prompt", () => {
    expect(routeMessage("奶龙:一只猫")).toMatchObject({ route: "image", prefix: "奶龙:", prompt: "一只猫" });
    expect(routeMessage("奶龙：A cat, Watercolor")).toMatchObject({ route: "image", prefix: "奶龙：", prompt: "A cat, Watercolor" });
  });

  it("only leading/trailing whitespace is ignored; a literal [at] in route_text is not special (R10)", () => {
    expect(routeMessage("   奶龙: 夕阳下的海  ")).toMatchObject({ route: "image", prefix: "奶龙:", prompt: "夕阳下的海" });
    expect(routeMessage("[at] 奶龙:猫").route).toBe("agent");
    expect(routeMessage("[reply][at] 奶龙：狗").route).toBe("agent");
  });

  it("legacyRouteText strips rendered placeholders (old data without route_text only)", () => {
    expect(legacyRouteText("[reply][at] 奶龙：狗")).toBe(" 奶龙：狗");
    expect(routeMessage(legacyRouteText("[at] 奶龙:猫"))).toMatchObject({ route: "image", prompt: "猫" });
  });

  it("empty prompt → usage route; the usage text is fixed", () => {
    expect(routeMessage("奶龙:")).toEqual({ route: "image_usage", prefix: "奶龙:" });
    expect(routeMessage(" 奶龙：   ")).toEqual({ route: "image_usage", prefix: "奶龙：" });
    expect(IMAGE_USAGE_REPLY).toBe("奶龙: 后面写要画的内容");
  });

  it("no prefix (or prefix not at the start) → agent with the original text untouched", () => {
    for (const t of ["画一只猫", "我说奶龙:画猫", "奶龙 画猫", "奶龙", " [at] 今晚有比赛吗 "]) {
      expect(routeMessage(t)).toEqual({ route: "agent", text: t });
    }
  });

  it("matching is exact: case and width as configured", () => {
    const prefixes = parseImagePrefixes("Draw:, 画图 ");
    expect(prefixes).toEqual(["Draw:", "画图"]);
    expect(routeMessage("Draw: a cat", prefixes)).toMatchObject({ route: "image", prompt: "a cat" });
    expect(routeMessage("draw: a cat", prefixes).route).toBe("agent");
    expect(routeMessage("Ｄraw: a cat", prefixes).route).toBe("agent");
    expect(routeMessage("画图一只猫", prefixes)).toMatchObject({ route: "image", prefix: "画图", prompt: "一只猫" });
  });

  it("longer prefix wins when one prefix is a prefix of another", () => {
    expect(routeMessage("奶龙大:x", ["奶龙", "奶龙大:"])).toMatchObject({ prefix: "奶龙大:", prompt: "x" });
  });

  it("empty IMAGE_PREFIXES falls back to the defaults", () => {
    expect(parseImagePrefixes(" , ")).toEqual(DEFAULT_IMAGE_PREFIXES);
    expect(parseImagePrefixes(undefined)).toEqual(["奶龙:", "奶龙："]);
  });
});
