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

function assertCurrentCreativeCopy(source: string): void {
  const sourceFile = parsePage(source);
  const aiCards = descendants(sourceFile, (node): node is ts.JsxElement =>
    isJsxElementWith(node, "section", "tool-card")
  );
  invariant(aiCards.length === 1, "exactly one AI tool card required");
  const card = aiCards[0];
  const renderedText = descendants(card, ts.isJsxText).map((node) => node.text).join(" ");
  for (const retired of [/当前为\s*TEST/, /本次是\s*v1\.9\.80/, /更新成功\s*·\s*v1\.9\.80/]) {
    invariant(!retired.test(renderedText), "retired current release wording");
  }
  for (const prefix of ["本次是 v", "更新成功 · v"]) {
    invariant(descendants(card, ts.isJsxElement).some((element) => element.children.some((child, index, children) =>
      ts.isJsxText(child) && child.text.includes(prefix) &&
      ts.isJsxExpression(children[index + 1]) &&
      (children[index + 1] as ts.JsxExpression).expression?.getText(sourceFile) === "COLLECTOR.version"
    )), "current version must be rendered from COLLECTOR.version");
  }
  const features = objectArray(sourceFile, "FEATURES");
  const usage = objectArray(sourceFile, "USAGE_GROUPS");
  const flow = usage.find((entry) => entry.title === "图片参考流转");
  const links = usage.find((entry) => entry.title === "链接成详（L 编号）与清单生图");
  const featureFlow = features.find((entry) => entry.title === "参考流转、修复与拼接");
  invariant(Boolean(flow && links && featureFlow), "official creative guidance is missing");
  for (const entry of [flow!, links!, featureFlow!]) {
    invariant(entry.desc.includes("官网") && entry.desc.includes("上传"), "creative guidance must require website upload");
    invariant(!entry.desc.includes("插件会把当前") && !entry.desc.includes("插件按每条链接自己的规划顺序提词") && !entry.desc.includes("并预填正确位置"), "automatic cross-device creation claim");
  }
  const navigation = features.find((entry) => entry.title === "创作功能统一进入官网");
  invariant(Boolean(navigation), "official navigation feature missing");
  for (const name of ["主图", "详情", "SKU", "爆款裂变", "服装", "买家秀", "产品精修", "生成视频"]) {
    invariant(navigation!.desc.includes(name), "creative destination missing");
  }
  invariant(navigation!.desc.includes("不会自动跨端导入") && renderedText.includes("已有本机历史和原件保留"), "history and upload boundary missing");
  invariant(renderedText.includes("尚未完成全新 Mac 的系统安装拦截验收"), "fresh Mac acceptance boundary missing");
}

function assertImmutableToolsGuard(source: string): number {
  const guard = readFileSync(resolve(process.cwd(), "scripts/predeploy-guard.sh"), "utf8");
  const version = guard.match(/^EXPECTED_VERSION="([^"]+)"$/m)?.[1];
  invariant(version, "guard expected version is missing");
  const lines = guard.split("\n").filter((line) =>
    /^(?:require_fixed|forbid_fixed)\s/.test(line) && line.includes(" src/app/tools/page.tsx ")
  );
  invariant(lines.length > 0, "tools fixed publication protections are missing");
  for (const line of lines) {
    const parsed = line.match(/^(require_fixed|forbid_fixed)\s+("(?:\\.|[^"\\])*"|'[^']*')\s+src\/app\/tools\/page\.tsx\s/);
    invariant(parsed, "unparsed tools fixed publication protection");
    const literal = parsed[2];
    const needle = (literal.startsWith("'") ? literal.slice(1, -1) : JSON.parse(literal) as string)
      .replaceAll("${EXPECTED_VERSION}", version);
    invariant(source.includes(needle) === (parsed[1] === "require_fixed"), `tools publication protection: ${needle}`);
  }
  return lines.length;
}

const expectedReferenceDetailSteps = [
  {
    title: "提取同行详情",
    body: "粘贴淘宝 / 天猫 / 1688 同行商品 URL，或在商品页点击「摘取详情页面」。淘宝 / 天猫从“图文详情”开始，在“店铺推荐”之前停止，并排除紧前最后一整张详情图；1688 从“商品详情”开始，在“【平台活动下价格】”之前停止。从页面任意位置启动后先回到顶部，再逐屏等待图片加载并识别结束标记。完成后打开待导入预览，点击“导入本次摘取”才进入批量详情。插件只扫描当前登录账号可见、页面已公开加载的正文，按原页面顺序形成只读来源快照；未找到结束标记时提示重试，不提交不完整详情。"
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

  it("publishes the frozen current official collector downloads and excludes migration packages", () => {
    const collector = objectRecord(findConstInitializer(sourceFile, "COLLECTOR"), "COLLECTOR");
    const receipt = JSON.parse(readFileSync(resolve(process.cwd(), "frozen/extension-updates-v1.json"), "utf8")) as {
      products: Array<{ productId: string; version: string; bootstrapVersion: string }>;
      artifacts: Array<{ path: string; size: number; sha256: string }>;
    };
    const releases = receipt.products.filter((entry) => entry.productId === "ai-automation");
    expect(releases).toHaveLength(1);
    const release = releases[0];
    expect(release.version).toMatch(/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2,3}$/);
    const zipHref = `/downloads/sycm-keyword-collector-v${release.version}.zip`;
    const macHref = `/downloads/shaozhuang-ai-v${release.version}-macos-full.zip`;
    const zipArtifacts = receipt.artifacts.filter((entry) => entry.path === `public${zipHref}`);
    const macArtifacts = receipt.artifacts.filter((entry) => entry.path === `public${macHref}`);
    expect(zipArtifacts).toHaveLength(1);
    expect(macArtifacts).toHaveLength(1);
    for (const artifact of [...zipArtifacts, ...macArtifacts]) {
      expect(artifact.size).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(collector).toMatchObject({
      version: release.version,
      zipHref,
      downloadName: `少壮AI自动化-v${release.version}.zip`,
      platform: "Chrome / Edge 116+",
      sizeLabel: `Mac 完整包约 ${(macArtifacts[0].size / 1_000_000).toFixed(1)} MB`,
      macHref,
      macDownloadName: `少壮AI自动化-v${release.version}-Mac完整安装包.zip`
    });
    expect(collector.version).not.toBe(release.bootstrapVersion);
    for (const href of [collector.zipHref, collector.macHref]) {
      expect(href).not.toContain("bootstrap");
      expect(href).not.toContain(release.bootstrapVersion);
    }
    expect(collector.downloadName).not.toContain("TEST");
    expect(collector.macDownloadName).not.toContain("TEST");
  });

  it("renders the current formal version and explains website creation without automatic migration", () => {
    expect(() => assertCurrentCreativeCopy(toolsPageSource)).not.toThrow();
  });

  it.each([
    ["stale update note", "本次是 v{COLLECTOR.version} 官网模块统一导航。", "本次是 v1.9.80 TEST。"],
    ["stale restart receipt", "更新成功 · v{COLLECTOR.version}", "更新成功 · v1.9.80"],
    ["whole release TEST label", "Windows 尚无本机助手安装器。", "Windows 尚无本机助手安装器。当前为 TEST。"],
    ["automatic image transfer", "先在插件下载所需原图、译图或除字图，再在官网手动上传；不会自动携带图片或预填创作内容。", "插件会把当前原图带到对应工作台并预填正确位置。"],
    ["plugin L-number generation", "由用户在官网上传清单和商品主体多角度图，核对提示词与参数后手动开始；插件不会自动跨端导入清单、素材或创作草稿。", "插件按每条链接自己的规划顺序提词，再按编号并发生图。"]
  ])("rejects the observed %s regression", (_label, current, retired) => {
    expect(toolsPageSource).toContain(current);
    expect(() => assertCurrentCreativeCopy(toolsPageSource.replaceAll(current, retired))).toThrow();
  });

  it("satisfies every unchanged tools fixed requirement and prohibition in the production predeploy guard", () => {
    expect(assertImmutableToolsGuard(toolsPageSource)).toBeGreaterThan(0);
  });

  it.each([
    "v1.9.67–v1.9.74 可按提示安排包内离线升级",
    "尚未完成全新 Mac 的系统安装拦截验收"
  ])("rejects removal of the protected installation boundary %s", (boundary) => {
    expect(toolsPageSource).toContain(boundary);
    expect(() => assertImmutableToolsGuard(toolsPageSource.replace(boundary, "__REMOVED_BOUNDARY__"))).toThrow();
  });

  it("publishes the current model-aware regeneration repair contract", () => {
    for (const claim of ["按当前模型适配", "gpt-image-2 使用结构化修复方案", "gpt-image-2.5-sunburst（Image-2.5-sunburst）使用独立", "修改 / 保留 / 证据", "根据模型使用修复指令、参考图和蒙版", "保留圈选范围外的原图", "修复结果另存为新图"]) {
      expect(toolsPageSource).toContain(claim);
    }
  });

  it("keeps one updater help anchor with separate fixed-directory and protected-directory instructions", () => {
    const blocks = descendants(sourceFile, ts.isJsxElement).filter(
      (element) => jsxAttribute(element.openingElement, "id") === "update-help"
    );
    expect(blocks).toHaveLength(1);
    const cards = descendants(blocks[0], (node): node is ts.JsxElement => isJsxElementWith(node, "article"));
    expect(cards).toHaveLength(2);
    const normal = descendants(cards[0], ts.isJsxText).map((node) => node.text).join(" ");
    const protectedDirectory = descendants(cards[1], ts.isJsxText).map((node) => node.text).join(" ");
    expect(normal).toContain("安装本机助手.command");
    expect(normal).toContain("无需逐台准备修复文件");
    expect(normal).toContain("完全退出 Chrome");
    expect(protectedDirectory).toContain("合并覆盖到 Chrome 当前加载的这个原目录");
    expect(toolsPageSource).not.toContain("插件内更新适用于能授权写入的原安装目录");
    for (const claim of ["MANIFEST_SCOPE_CHANGED", "随包离线升级", "UPDATE_FAILED", "检测到新版本不等于已经写入完成", "场景延展", "超远观", "珠宝饰品", "少壮跨版本档案-v1", "待补存", "不重新提交生成", "先检查本机图库连接", "127.0.0.1", "插件 ZIP 不会安装或启动图库助手", "同账号也不会自动同步另一台电脑的文件"]) expect(toolsPageSource).toContain(claim);
    for (const boundary of ["UnpackedExtensions", "网页更新器无法取得写入权限",  "失败时回滚，不搬动目录", "不修改 Chrome 安全策略",  "不修改 Chrome 配置、API 与图视频历史数据"]) {
      expect(protectedDirectory).toContain(boundary);
    }
    expect(objectArray(sourceFile, "INSTALL_STEPS")[0].body).toContain("不要直接选择 ZIP");
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
      desc: "链接成详进入官网详情模块，以当前已上线能力为准；链接清单与主体素材需由用户在官网手动上传，不会自动跨端导入。既有 L001、L002、L003 等清单定位与分屏规则可作为创作参考。"
    });
    expect(usageGroups).toContainEqual({
      title: "链接成详（L 编号）与清单生图",
      desc: "在插件选好 L 编号并导出链接清单，点击主图或详情入口进入官网对应模块。由用户在官网上传清单和商品主体多角度图，核对提示词与参数后手动开始；插件不会自动跨端导入清单、素材或创作草稿。"
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

// R51: the download page must state tenant configuration and shared cloud capacity.
it("states the R51 asset lifecycle and billing boundary", () => {
  for (const text of ["完成当前账号素材权限配置", "自动素材区最多 50 张", "绑定素材单独保留，最多 50 张", "Entry 云端合计最多 50 张", "不会自动使用其他账号付费", "视频默认关闭可见水印"]) expect(toolsPageSource).toContain(text);
});
