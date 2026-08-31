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
    body: "粘贴淘宝 / 天猫同行商品 URL，或在商品页点击「提取当前商品详情」。插件只扫描页面已公开加载的完整图文，并按照原页面顺序生成只读来源快照。"
  },
  {
    title: "形成一句话分屏蓝图",
    body: "把来源快照按原顺序拆成 5–16 个最终分屏；每屏只突出一句可编辑的核心内容 / 描述方向。确认前可修改方向、重排、删除、复制、合并和锁定模块。"
  },
  {
    title: "建立自家事实与素材",
    body: "建立多张自家商品事实卡，绑定自有或已授权的商品主体图、模特图和素材槽；同行来源素材仅用于结构参考，不直接作为自家商品素材。"
  },
  {
    title: "一次确认进入批量",
    body: "准备好后只点一次「确认并进入批量生成」；系统内部自动保存 revision、核验事实与授权素材并完成显式审批，不让用户反复审核。任一步失败只显示一个可操作原因，修改后可再次确认。"
  },
  {
    title: "建立多个生成目标",
    body: "从同一个已确认蓝图新增多个自家商品目标，分别选择事实卡、主体 / 模特图、SKU、人群、语言与卖点角度。"
  },
  {
    title: "批量生成与恢复",
    body: "每个目标生成 5–16 个独立分屏；支持双并发、停止、失败屏重试、刷新恢复和逐目标长详情预览。"
  },
  {
    title: "安全归档并隔离结果",
    body: "结果先写入当前账号的本机图片档案，成功取得安全句柄后才标记完成；不同商品的事实、提示词、图片和结果严格隔离。"
  }
];

describe("tools page collector release contract", () => {
  const sourceFile = parsePage(toolsPageSource);

  it("publishes the verified v1.9.32 collector package metadata", () => {
    const collector = objectRecord(findConstInitializer(sourceFile, "COLLECTOR"), "COLLECTOR");
    expect(collector).toMatchObject({
      version: "1.9.32",
      zipHref: "/downloads/sycm-keyword-collector-v1.9.32.zip",
      downloadName: "少壮AI自动化-v1.9.32.zip",
      sizeLabel: "约 4.5 MB"
    });
  });

  it("publishes seven ordered reference-detail steps and consumes them in one labelled card", () => {
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
    const secondTitle = 'title: "形成一句话分屏蓝图"';
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
