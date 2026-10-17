import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve("src");
const corePath = path.join(sourceRoot, "lib/algorithm/three-stage.ts");
const configPath = path.join(sourceRoot, "lib/algorithm/three-stage-config.ts");
const parse = (filename: string) => ts.createSourceFile(filename, readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.tsx?$/.test(filename) && !/\.(?:test|ui-test)\./.test(filename) ? [filename] : [];
  });
}

function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every(element => element.isTypeOnly)) continue;
      imports.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.every(element => element.isTypeOnly)) continue;
      imports.push(statement.moduleSpecifier.text);
    }
  }
  function dynamicImports(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, dynamicImports);
  }
  dynamicImports(source);
  return imports;
}

function localModule(specifier: string, importer: string): string | undefined {
  const base = specifier.startsWith("@/") ? path.join(sourceRoot, specifier.slice(2)) : specifier.startsWith(".") ? path.resolve(path.dirname(importer), specifier) : null;
  if (!base) return undefined;
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  });
}

describe("three-stage server and public configuration boundary", () => {
  it("keeps a server-only guard on calculations and no runtime dependencies in public defaults", () => {
    expect(runtimeSpecifiers(parse(corePath))).toContain("server-only");
    expect(runtimeSpecifiers(parse(configPath))).toEqual([]);
  });

  it("prevents all client entry points from importing core calculations transitively", () => {
    const parsed = new Map(sourceFiles(sourceRoot).map(filename => [filename, parse(filename)]));
    const clients = [...parsed].filter(([, source]) => {
      const first = source.statements[0];
      return first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client";
    });
    expect(clients.length).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const [entry] of clients) {
      const queue = [[entry]];
      const seen = new Set<string>();
      while (queue.length) {
        const chain = queue.shift()!;
        const filename = chain.at(-1)!;
        if (filename === corePath) {
          leaks.push(chain.map(part => path.relative(sourceRoot, part)).join(" -> "));
          break;
        }
        if (seen.has(filename)) continue;
        seen.add(filename);
        const source = parsed.get(filename);
        if (!source) continue;
        for (const specifier of runtimeSpecifiers(source)) {
          const dependency = localModule(specifier, filename);
          if (dependency) queue.push([...chain, dependency]);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
