import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const toolsPageSource = readFileSync(
  resolve(process.cwd(), "src/app/tools/page.tsx"),
  "utf8"
);

type StringRecord = Record<string, string>;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parsePage(source: string) {
  return ts.createSourceFile(
    "src/app/tools/page.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function findConstInitializer(
  sourceFile: ts.SourceFile,
  variableName: string
): ts.Expression {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variableName &&
      node.initializer
    ) {
      invariant(!initializer, `duplicate const ${variableName}`);
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  invariant(initializer, `missing const ${variableName}`);
  return initializer;
}

function propertyName(property: ts.ObjectLiteralElementLike): string {
  invariant(
    ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)),
    "release data must use plain property assignments"
  );
  return property.name.text;
}

function stringValue(expression: ts.Expression, label: string): string {
  invariant(
    ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression),
    `${label} must be a static string`
  );
  return expression.text;
}

function objectRecord(node: ts.Expression, label: string): StringRecord {
  invariant(ts.isObjectLiteralExpression(node), `${label} must be an object literal`);
  const result: StringRecord = {};
  for (const property of node.properties) {
    invariant(ts.isPropertyAssignment(property), `${label} contains a non-property member`);
    const name = propertyName(property);
    result[name] = stringValue(property.initializer, `${label}.${name}`);
  }
  return result;
}

function objectArray(
  sourceFile: ts.SourceFile,
  variableName: string
): StringRecord[] {
  const initializer = findConstInitializer(sourceFile, variableName);
  invariant(ts.isArrayLiteralExpression(initializer), `${variableName} must be an array literal`);
  return initializer.elements.map((element, index) =>
    objectRecord(element, `${variableName}[${index}]`)
  );
}

function jsxTagName(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement
): string {
  return element.tagName.getText();
}

function jsxAttribute(
  element: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string
): string | undefined {
  const attribute = element.attributes.properties.find(
    (candidate): candidate is ts.JsxAttribute =>
      ts.isJsxAttribute(candidate) && candidate.name.getText() === name
  );
  if (!attribute) return undefined;
  if (!attribute.initializer) return "";
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteral(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text;
  }
  return undefined;
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  guard: (node: ts.Node) => node is T
): T[] {
  const matches: T[] = [];
  const visit = (node: ts.Node) => {
    if (guard(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return matches;
}

function isJsxElementWith(
  node: ts.Node,
  tagName: string,
  className?: string
): node is ts.JsxElement {
  return (
    ts.isJsxElement(node) &&
    jsxTagName(node.openingElement) === tagName &&
    (className === undefined ||
      jsxAttribute(node.openingElement, "className") === className)
  );
}

function referenceDetailCardStructure(sourceFile: ts.SourceFile) {
  const referenceBlocks = descendants(
    sourceFile,
    (node): node is ts.JsxElement => isJsxElementWith(node, "div", "tool-block")
  ).filter((block) =>
    descendants(block, ts.isJsxText).some((text) => text.text.trim() === "参考成详")
  );

  invariant(referenceBlocks.length === 1, "reference detail must have exactly one tool block");
  const block = referenceBlocks[0];
  const article = descendants(
    block,
    (node): node is ts.JsxElement => isJsxElementWith(node, "article")
  ).find(
    (element) =>
      jsxAttribute(element.openingElement, "aria-labelledby") ===
      "reference-detail-title"
  );
  const title = descendants(
    block,
    (node): node is ts.JsxElement => isJsxElementWith(node, "strong")
  ).find(
    (element) => jsxAttribute(element.openingElement, "id") === "reference-detail-title"
  );
  const orderedSteps = descendants(
    block,
    (node): node is ts.JsxElement => isJsxElementWith(node, "ol", "tool-steps")
  );
  const mapsSteps = orderedSteps.some((list) =>
    descendants(list, ts.isCallExpression).some(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "REFERENCE_DETAIL_STEPS" &&
        call.expression.name.text === "map"
    )
  );

  return {
    blockCount: referenceBlocks.length,
    hasLabelledArticle: Boolean(article),
    hasLabelTarget: Boolean(title),
    orderedListCount: orderedSteps.length,
    mapsSteps
  };
}

const expectedReferenceDetailSteps = [
  {
    title: "提取同行详情",
    body: "粘贴淘宝 / 天猫同行商品 URL，或在商品页点击「摘取详情页面」。插件只扫描当前登录账号可见、页面已公开加载的正文；严格从可见“图文详情”之后取到随后第一个可见“本店推荐”之前，并按原页面顺序形成只读来源快照。"
  },
  {
    title: "分析并整理结构框架",
    body: "将只读快照按来源顺序分析为 5–16 个最终分屏，每屏只保留一句可编辑的核心内容 / 描述方向。普通 warning、确定性 fallback 和 partial 会自动整理；受阻模块自动跳过，全部模块都受阻时仍会阻断。确认前可修改方向、重排、删除、复制或合并。"
  },
  {
    title: "绑定主体与可选模特",
    body: "每个商品目标至少绑定 1 张自有或已授权的主体图并确认素材权利；模特图完全可选，并以独立角色进入任务。新链不创建、不选择、不审核事实卡，同行原图、原文和竞品事实不会成为自家事实或生成素材。"
  },
  {
    title: "一次锁定进入批量",
    body: "只点一次「锁定结构并进入批量」即可保存不可变 revision，并自动建立绑定当前全部已授权主体与可选模特的默认目标。正式来源、至少一个安全模块、授权、视觉服务商能力、精确 revision / 账号 / 任务身份和防重复计费仍是硬门禁。"
  },
  {
    title: "批量生成、恢复与归档",
    body: "每个目标生成 5–16 个独立分屏；支持双并发、停止、失败屏重试、刷新恢复和逐目标长详情预览。结果先写入当前账号的本机图片档案，取得安全完成权威后才标记完成；不同商品的主体、模特、提示词、图片和结果严格隔离。"
  }
];

describe("tools page collector release contract", () => {
  const sourceFile = parsePage(toolsPageSource);

  it("publishes the verified v1.9.43 collector package metadata", () => {
    const collector = objectRecord(findConstInitializer(sourceFile, "COLLECTOR"), "COLLECTOR");
    expect(collector).toMatchObject({
      version: "1.9.43",
      zipHref: "/downloads/sycm-keyword-collector-v1.9.43.zip",
      downloadName: "少壮AI自动化-v1.9.43.zip",
      sizeLabel: "约 5.1 MB"
    });
  });

  it("publishes five ordered reference-detail steps and consumes them in one labelled card", () => {
    expect(objectArray(sourceFile, "REFERENCE_DETAIL_STEPS")).toEqual(
      expectedReferenceDetailSteps
    );
    expect(referenceDetailCardStructure(sourceFile)).toEqual({
      blockCount: 1,
      hasLabelledArticle: true,
      hasLabelTarget: true,
      orderedListCount: 1,
      mapsSteps: true
    });
  });

  it("fails structurally if steps are reordered or detached from the reference card", () => {
    const detached = parsePage(
      toolsPageSource.replace("REFERENCE_DETAIL_STEPS.map", "DETACHED_STEPS.map")
    );
    expect(referenceDetailCardStructure(detached).mapsSteps).toBe(false);

    const firstTitle = 'title: "提取同行详情"';
    const secondTitle = 'title: "分析并整理结构框架"';
    const reordered = parsePage(
      toolsPageSource
        .replace(firstTitle, 'title: "__TEMP_REFERENCE_STEP__"')
        .replace(secondTitle, firstTitle)
        .replace('title: "__TEMP_REFERENCE_STEP__"', secondTitle)
    );
    expect(objectArray(reordered, "REFERENCE_DETAIL_STEPS")).not.toEqual(
      expectedReferenceDetailSteps
    );
  });

  it("keeps both Link/L-number detail descriptions in their production arrays", () => {
    const features = objectArray(sourceFile, "FEATURES");
    const usageGroups = objectArray(sourceFile, "USAGE_GROUPS");
    expect(features).toContainEqual({
      title: "链接成详（L 编号）",
      desc: "保留原有 L001、L002、L003 等链接清单定位逻辑，按每条链接自己的详情定位和文案逻辑生成连续分屏；每一屏都是独立工位，稳定按 L 号和屏号落位，部分失败不会拖住整批。"
    });
    expect(usageGroups).toContainEqual({
      title: "链接成详（L 编号）与清单生图",
      desc: "链接成详继续使用现有链接清单定位逻辑：选择连续 L 编号和主图 / 详情模式，上传商品主体多角度图，插件按每条链接自己的规划顺序提词，再按编号并发生图。生成后可在结果卡点击“引导重生”，标注局部并锁定其他区域后精确修复。"
    });
  });

  it("removes retired reference-detail and collector wording", () => {
    for (const retiredClaim of [
      "参考图模式会先反推并覆盖当前提示词",
      "保存 revision，逐项完成商品事实与目标素材核验后再显式审批",
      "多张自家商品事实卡",
      "分别选择事实卡",
      "核验事实",
      "确认并进入批量生成",
      "1–6 张参考图",
      "原 1–6 张参考图",
      "分日商品排行",
      "商品排行分日下载",
      "插件「商品排行」",
      "货盘 / 无界源表",
      "货盘、无界商品、无界人群",
      'title: "商品排行"',
      'title: "货盘"',
      'title: "无界商品"',
      'title: "无界人群"'
    ]) {
      expect(toolsPageSource).not.toContain(retiredClaim);
    }
  });

  it("publishes the autonomous reference-detail release gates", () => {
    for (const supportedClaim of [
      "warning",
      "fallback",
      "partial",
      "受阻模块自动跳过",
      "全部模块都受阻",
      "至少绑定 1 张自有或已授权的主体图",
      "模特图完全可选",
      "不创建、不选择、不审核事实卡",
      "锁定结构并进入批量",
      "防重复计费",
      "安全完成权威"
    ]) {
      expect(toolsPageSource).toContain(supportedClaim);
    }
  });

  it("keeps the supported SKU and market-evidence release contracts", () => {
    for (const supportedClaim of [
      "对象 / 参考 SKU 原图",
      "冻结为不可变视觉基底",
      "只替换其中的商品主体",
      "其他可见细节保持原样",
      "不得重新设计、改色、重排或增删",
      "真实 JPG",
      "业务 SKU 标题",
      "技术 SKU 编号",
      "用户自定义最终宽×高",
      "每边 256–4096 px",
      "总像素不超过 16,777,216",
      "用户指定的精确尺寸验收",
      "市场商品榜",
      "Top300 商品卡",
      "市场排行、商品榜或竞品表"
    ]) {
      expect(toolsPageSource).toContain(supportedClaim);
    }
  });

  it("removes the retired background-only SKU contract", () => {
    for (const retiredClaim of [
      "模型只创作无字、无商品背景",
      "字体、字号、文字位置、整体布局和商品主体位置由浏览器固定",
      "仅背景色、邻近渐变和轻背景氛围可变",
      "商品规格.jpg",
      "等比裁切且不拉伸"
    ]) {
      expect(toolsPageSource).not.toContain(retiredClaim);
    }
  });
});
