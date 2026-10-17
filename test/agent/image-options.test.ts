import { describe, expect, it } from "vitest";
import { ASPECTS, imageDimensions, imageTimeoutMs, SIZE_PRESETS, validateImageOptions } from "../../src/agent/image-options.js";
import { buildQwenWorkflow } from "../../src/agent/qwen-workflow.js";
import { parseInlineImageOptions, routeMessage } from "../../src/agent/router.js";

describe("生图 v2 参数与预设", () => {
  it("保留原文，默认 1024²；全部 21 个预设按设计表取值", () => {
    expect(validateImageOptions({ prompt: " 中文 原文 " }).prompt).toBe(" 中文 原文 ");
    expect(imageDimensions({ prompt: "猫" })).toEqual([1024, 1024]);
    expect(SIZE_PRESETS["1mp"]).toEqual({ "1:1": [1024,1024], "16:9": [1344,768], "9:16": [768,1344], "4:3": [1152,864], "3:4": [864,1152], "3:2": [1216,832], "2:3": [832,1216] });
    expect(SIZE_PRESETS["2mp"]).toEqual({ "1:1": [1440,1440], "16:9": [1888,1088], "9:16": [1088,1888], "4:3": [1632,1216], "3:4": [1216,1632], "3:2": [1728,1184], "2:3": [1184,1728] });
    expect(SIZE_PRESETS["2k"]).toEqual({ "1:1": [2048,2048], "16:9": [2752,1536], "9:16": [1536,2752], "4:3": [2368,1792], "3:4": [1792,2368], "3:2": [2528,1696], "2:3": [1696,2528] });
    for (const table of Object.values(SIZE_PRESETS)) {
      expect(Object.keys(table)).toHaveLength(7);
      for (const dims of Object.values(table)) for (const n of dims) expect(n % 32).toBe(0);
    }
  });
  it.each([
    { prompt: " " }, { prompt: 1 }, { prompt: "a".repeat(2001) }, { negative_prompt: 5 },
    { aspect: "5:4" }, { size: "4k" }, { count: 0 }, { count: 5 }, { count: 1.5 },
    { seed: -1 }, { seed: NaN }, { seed: Infinity }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { reference_images: ["a","b","c","d"] }, { reference_images: [""] }, { transparent: "true" }, { width: 4096 },
  ])("拒绝非法参数 %j", value => expect(() => validateImageOptions({ prompt: "猫", ...value })).toThrow());
  it("按像素与数量线性放大，且上限截断", () => {
    expect(imageTimeoutMs({ prompt: "猫" }, 300000)).toBe(60000);
    expect(imageTimeoutMs({ prompt: "猫", size: "2k" }, 300000)).toBe(240000);
    expect(imageTimeoutMs({ prompt: "猫", size: "2k", count: 4 }, 300000)).toBe(300000);
    expect(imageTimeoutMs({ prompt: "猫", count: 2 }, 300000)).toBe(120000);
  });
});

describe("前缀内联参数", () => {
  it.each(ASPECTS)("接受比例 %s", aspect => expect(parseInlineImageOptions(`${aspect} 猫`)).toEqual({ prompt: "猫", aspect }));
  it("任意顺序、空白、别名、最后一个同类选项生效；首个未知词开始保留原文", () => {
    expect(parseInlineImageOptions("透明 x3 2k 横 猫  2mp x4")).toEqual({ prompt: "猫  2mp x4", transparent: true, count: 3, size: "2k", aspect: "16:9" });
    expect(parseInlineImageOptions("竖\n方 2mp x2 x4 画猫")).toEqual({ prompt: "画猫", aspect: "1:1", size: "2mp", count: 4 });
    expect(parseInlineImageOptions("x5 横 猫")).toEqual({ prompt: "x5 横 猫" });
    expect(routeMessage("奶龙: 横 2k")).toEqual({ route: "image_usage", prefix: "奶龙:" });
    expect(routeMessage("奶龙: 猫", undefined, ["/data/incoming/a/1.png"])).toMatchObject({ options: { prompt: "猫", reference_images: ["/data/incoming/a/1.png"] } });
  });
});

describe("官方模板接线快照", () => {
  const config = { filenamePrefix: "snapshot", cache: false };
  it("文生图", () => expect(buildQwenWorkflow({ prompt: "一只猫", seed: 42, aspect: "16:9", count: 2 }, config)).toMatchSnapshot());
  it("编辑：采样 latent 来自 TextEncode 第三个输出，图片连接 autogrow 输入", () => {
    const graph = buildQwenWorkflow({ prompt: "换蓝色，保留构图", negative_prompt: "模糊", reference_images: ["ticket/1.png", "ticket/2.png"], seed: 42 }, config);
    expect(graph["6"]!.inputs.latent_image).toEqual(["4", 2]);
    expect(graph["4"]!.inputs["images.image_1"]).toEqual(["20", 0]);
    expect(graph).toMatchSnapshot();
  });
  it("透明：2.1 原生 RGBA 解码，不能使用另一模型的 layered latent", () => expect(buildQwenWorkflow({ prompt: "猫贴纸", seed: 42, transparent: true }, config)).toMatchSnapshot());
  it("多张编辑重复编码器空 latent；缓存在模型与采样器之间", () => {
    const graph = buildQwenWorkflow({ prompt: "改色", seed: 0, count: 4, reference_images: ["t/1.png"] }, { ...config, cache: true });
    expect(graph["5"]).toEqual({ class_type: "RepeatLatentBatch", inputs: { samples: ["4", 2], amount: 4 } });
    expect(graph["6"]!.inputs).toMatchObject({ model: ["10", 0], latent_image: ["5", 0], seed: 0, steps: 8, cfg: 1, scheduler: "simple" });
    expect(graph["10"]!.inputs.model).toEqual(["1", 0]);
  });
});
