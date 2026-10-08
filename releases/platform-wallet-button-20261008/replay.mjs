/** Replay only this five-file patch into a new local fixture. No network or live writes. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const releaseRoot = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(releaseRoot, "manifest.json"), "utf8"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const need = (ok, message) => { if (!ok) throw new Error(message); };
const args = process.argv.slice(2);
need(args.length === 4 && args[0] === "--baseline" && args[2] === "--output", "Usage: node replay.mjs --baseline /verified/project-root --output /new/local-fixture");
const baseline = realpathSync(resolve(args[1]));
const output = resolve(args[3]);
need(!existsSync(output), "Output must be a new directory; existing files will not be replaced.");
need(output !== baseline && !output.startsWith(baseline + sep), "Output must be outside the baseline.");
need(manifest.schema === "SANJIE_PLATFORM_WALLET_BUTTON_REPLAY_V1" && manifest.files.length === 5, "Unexpected manifest scope.");
const allowed = new Set([
  "public/creative/web-chrome.js",
  "public/creative/labs/image-prompt-lab/background.js",
  "public/creative/labs/image-prompt-lab/promptlab.js",
  "public/creative/labs/image-prompt-lab/studio-genesis-ui.js",
  "public/creative/labs/image-prompt-lab/promptlab.html"
]);
need(manifest.files.every(file => allowed.has(file.path)) && new Set(manifest.files.map(file => file.path)).size === 5, "Unexpected production paths.");
const safePath = name => typeof name === "string" && name.startsWith("public/creative/") && /^[A-Za-z0-9._/-]+$/.test(name) && !isAbsolute(name) && !name.split("/").some(part => ["", ".", ".."].includes(part)) && /\.(?:js|html)$/.test(name);
const loaded = new Map();
for (const row of manifest.testBaselineAssets) {
  need(safePath(row.path) && !loaded.has(row.path), "Unexpected fixture path.");
  const path = resolve(baseline, row.path);
  need(!relative(baseline, path).startsWith("..") && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "Baseline asset must be a regular file.");
  const bytes = readFileSync(path);
  need(bytes.length === row.bytes && sha(bytes) === row.sha256, `Baseline SHA mismatch: ${row.path}`);
  loaded.set(row.path, bytes);
}
for (const row of manifest.files) {
  const bytes = loaded.get(row.path);
  need(bytes && bytes.length === row.beforeBytes && sha(bytes) === row.beforeSha256, `Production before SHA mismatch: ${row.path}`);
}
const patchBytes = readFileSync(resolve(releaseRoot, manifest.patch.path));
need(manifest.patch.path === "wallet-button.patch" && patchBytes.length === manifest.patch.bytes && sha(patchBytes) === manifest.patch.sha256, "Patch SHA mismatch.");
const patches = new Map();
const lines = patchBytes.toString("utf8").split("\n");
let index = 0;
while (index < lines.length) {
  if (lines[index] === "" && index === lines.length - 1) break;
  const oldHeader = /^--- a\/(.+)$/.exec(lines[index++]);
  const newHeader = /^\+\+\+ b\/(.+)$/.exec(lines[index++]);
  need(oldHeader && newHeader && oldHeader[1] === newHeader[1] && allowed.has(oldHeader[1]) && !patches.has(oldHeader[1]), "Patch path rejected.");
  const hunks = [];
  while (index < lines.length && !lines[index].startsWith("--- a/") && !(lines[index] === "" && index === lines.length - 1)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(lines[index++]);
    need(header, "Patch hunk header rejected.");
    const hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), body: [] };
    while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- a/") && !(lines[index] === "" && index === lines.length - 1)) {
      const line = lines[index++];
      need([" ", "+", "-"].includes(line[0]), "Unsupported patch body or missing final newline.");
      hunk.body.push(line);
    }
    hunks.push(hunk);
  }
  need(hunks.length > 0, "Empty file patch rejected.");
  patches.set(oldHeader[1], hunks);
}
need(patches.size === 5, "Patch must change exactly five files.");
for (const row of manifest.files) {
  const original = loaded.get(row.path).toString("utf8");
  need(original.endsWith("\n"), "Baseline must retain its final newline.");
  const originalLines = original.slice(0, -1).split("\n");
  const result = [];
  let cursor = 0;
  for (const hunk of patches.get(row.path)) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    need(start >= cursor && start <= originalLines.length, "Overlapping or invalid hunk range.");
    result.push(...originalLines.slice(cursor, start));
    cursor = start;
    need(result.length === hunk.newStart - 1, "Unexpected output hunk position.");
    let removed = 0, added = 0;
    for (const line of hunk.body) {
      if (line[0] !== "+") {
        need(originalLines[cursor] === line.slice(1), `Exact patch context mismatch: ${row.path}`);
        cursor += 1;
        removed += 1;
      }
      if (line[0] !== "-") { result.push(line.slice(1)); added += 1; }
    }
    need(removed === hunk.oldCount && added === hunk.newCount, "Hunk length mismatch.");
  }
  result.push(...originalLines.slice(cursor));
  const bytes = Buffer.from(result.join("\n") + "\n");
  need(bytes.length === row.afterBytes && sha(bytes) === row.afterSha256, `Production after SHA mismatch: ${row.path}`);
  loaded.set(row.path, bytes);
}
// All sources, patch contexts and target hashes are validated before any write.
mkdirSync(output, { mode: 0o700 });
for (const [name, bytes] of loaded) {
  const path = resolve(output, name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}
console.log(JSON.stringify({ fixtureRoot: output, creativeAssetTestRoot: resolve(output, "public/creative"), copiedPublicAssets: loaded.size, patchedFiles: manifest.files.length, fiveAfterHashesVerified: true, baselineChanged: false, providerCalls: 0 }, null, 2));
