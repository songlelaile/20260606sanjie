import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('../provenance.json', import.meta.url), 'utf8'));
export const digest = (value) => createHash('sha256').update(value).digest('hex');
for (const entry of provenance.vendorFiles) {
  if (digest(readFileSync(new URL(`../vendor/${entry.file}`, import.meta.url))) !== entry.sha256) {
    throw new Error('Pinned plugin source integrity check failed');
  }
}
const { mergeKeywordSources, keywordMergeKey } = require('../vendor/keywordMerge.cjs');
const matrixSource = readFileSync(new URL('../vendor/linkmatrix.js', import.meta.url), 'utf8');
export const DEMAND_TYPES = ['品类', '属性', '人群', '功能', '场景', '风格', '品牌', '定制'];

function matrixCall(method, input) {
  // Only the hash-verified, bundled plugin is executable. User data stays JSON.
  const context = vm.createContext({ window: {}, serialized: JSON.stringify(input) });
  vm.runInContext(matrixSource, context, { timeout: 3000 });
  return JSON.parse(
    vm.runInContext(`JSON.stringify(window.LINKMATRIX.${method}(JSON.parse(serialized)))`, context, { timeout: 15000 })
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scopeKey(scope) {
  assert(scope && typeof scope === 'object', 'Missing scope');
  const fields = ['accountId', 'workspaceId', 'platform', 'categoryId', 'startDate', 'endDate'];
  fields.forEach((field) => assert(typeof scope[field] === 'string' && scope[field].trim(), `Missing scope.${field}`));
  for (const field of ['startDate', 'endDate']) {
    assert(
      /^\d{4}-\d{2}-\d{2}$/.test(scope[field]) &&
        !Number.isNaN(Date.parse(scope[field])) &&
        new Date(scope[field]).toISOString().slice(0, 10) === scope[field],
      `Invalid scope.${field}`
    );
  }
  assert(scope.startDate <= scope.endDate, 'Invalid date range');
  assert(
    scope.objectId === null || (typeof scope.objectId === 'string' && scope.objectId.trim()),
    'scope.objectId must be null or a nonempty string'
  );
  return JSON.stringify(fields.map((field) => scope[field]).concat(scope.objectId));
}

function envelope(stage, scope, input, data) {
  return {
    schemaVersion: 1,
    stage,
    scope,
    inputHash: digest(JSON.stringify(input)),
    pluginVersion: provenance.version,
    browserCollectionVerified: input.browserCollectionVerified === true,
    ...data,
  };
}

/** Merge only compatible snapshots; retain missing metrics separately from real zero. */
export function merge(input) {
  const scope = scopeKey(input.scope);
  assert(Array.isArray(input.sources) && input.sources.length > 0, 'No keyword sources');
  const ranked = [],
    derived = [],
    evidence = new Map();
  input.sources.forEach((source) => {
    assert(scopeKey(source.scope) === scope, 'Keyword source scope mismatch');
    assert(['热词榜', '衍生词榜'].includes(source.kind), 'Unsupported keyword source');
    assert(typeof source.artifactId === 'string' && source.artifactId.trim(), 'Missing source artifactId');
    assert(Array.isArray(source.words), 'Missing source words');
    source.words.forEach((word, index) => {
      assert(typeof word.kw === 'string' && keywordMergeKey(word.kw), 'Empty keyword');
      assert(
        word.pop === null || (typeof word.pop === 'number' && Number.isFinite(word.pop) && word.pop >= 0),
        'pop must be a finite exact number or null; preserve ranges in raw evidence'
      );
      const normalized = { ...word, source: source.kind };
      (source.kind === '热词榜' ? ranked : derived).push(normalized);
      const key = keywordMergeKey(word.kw);
      if (!evidence.has(key)) evidence.set(key, []);
      evidence.get(key).push({ artifactId: source.artifactId, row: index + 1, source: source.kind, original: word });
    });
  });
  assert(ranked.length + derived.length > 0, 'No keywords');
  const words = mergeKeywordSources(ranked, derived).map((word) => {
    const records = evidence.get(keywordMergeKey(word.kw));
    const metric = (kind) => {
      const values = records
        .filter((r) => !kind || r.source === kind)
        .map((r) => r.original.pop)
        .filter((v) => v !== null);
      return values.length ? Math.max(...values) : null;
    };
    return { ...word, pop: metric(), rankPop: metric('热词榜'), derivePop: metric('衍生词榜'), evidence: records };
  });
  return envelope('merged', input.scope, input, {
    words,
    stats: {
      inputCount: ranked.length + derived.length,
      uniqueCount: words.length,
      removedCount: ranked.length + derived.length - words.length,
    },
  });
}

/** Create analysis batches without pretending a model has been called. */
export function analysisPlan(input) {
  scopeKey(input.scope);
  assert(input.stage === 'merged' && Array.isArray(input.words) && input.words.length, 'Expected merged dataset');
  const batches = [];
  for (let offset = 0; offset < input.words.length; offset += 20) {
    batches.push({
      batchId: `B${String(batches.length + 1).padStart(4, '0')}`,
      words: input.words.slice(offset, offset + 20).map((w) => ({ kw: w.kw })),
    });
  }
  return envelope('analysis-plan', input.scope, input, {
    status: 'awaiting-analysis',
    maxConcurrency: 3,
    batchSize: 20,
    demandTypes: DEMAND_TYPES,
    batches,
    modelCalled: false,
  });
}

/** Validate externally produced annotations and use the original matching/generation engine. */
export function compare(input) {
  const merged = input.merged;
  const scope = scopeKey(merged?.scope);
  assert(merged.stage === 'merged' && Array.isArray(merged.words) && merged.words.length, 'Expected merged dataset');
  assert(scopeKey(input.market?.scope) === scope, 'Market scope mismatch');
  assert(
    input.market.kind === 'sycm-market-rank',
    'Taobao sales search is a separate evidence source; direct comparable rank required'
  );
  assert(
    input.market.complete === true && input.market.scopeVerified === true,
    'Market capture incomplete or scope unverified'
  );
  assert(typeof input.market.artifactId === 'string' && input.market.artifactId.trim(), 'Missing market artifactId');
  assert(Array.isArray(input.market.rows) && input.market.rows.length > 0, 'No market rows');
  assert(typeof input.category === 'string' && input.category.trim(), 'Missing category');
  assert(
    Array.isArray(input.annotations) && input.annotations.length === merged.words.length,
    'Annotation coverage incomplete'
  );
  const annotations = new Map();
  for (const item of input.annotations) {
    const key = keywordMergeKey(item.kw);
    assert(key && !annotations.has(key), 'Duplicate or empty annotation');
    assert(
      ['ai', 'human'].includes(item.method) && typeof item.revision === 'string' && item.revision.trim(),
      'Annotation method/revision required'
    );
    assert(
      Array.isArray(item.parts) && item.parts.length > 0 && item.parts.length === item.partTypes?.length,
      'Invalid root/type mapping'
    );
    assert(
      item.parts.every((part) => typeof part === 'string' && keywordMergeKey(part)),
      'Empty root'
    );
    assert(
      item.partTypes.every((type) => DEMAND_TYPES.includes(type)),
      'Unsupported demand type'
    );
    assert(keywordMergeKey(item.parts.join('')) === key, 'Roots must cover the original keyword in order');
    annotations.set(key, item);
  }
  const rootMap = new Map();
  const words = merged.words.map((word) => {
    const annotation = annotations.get(keywordMergeKey(word.kw));
    assert(annotation, 'Annotation keyword mismatch');
    // The inherited matrix treats missing popularity as zero; block this instead of silently filling it.
    assert(
      typeof word.pop === 'number' && Number.isFinite(word.pop) && word.pop >= 0,
      'Missing popularity: scored matrix requires complete metrics'
    );
    annotation.parts.forEach((root, index) => {
      const type = annotation.partTypes[index];
      const key = `${keywordMergeKey(root)}:${type}`;
      if (!rootMap.has(key)) rootMap.set(key, { root, type, pop: 0, count: 0 });
      const item = rootMap.get(key);
      item.pop += word.pop;
      item.count++;
    });
    return {
      ...word,
      parts: annotation.parts,
      partTypes: annotation.partTypes,
      demands: [...new Set(annotation.partTypes)],
    };
  });
  assert(
    Number.isInteger(input.limit ?? 20) && (input.limit ?? 20) > 0 && (input.limit ?? 20) <= 100,
    'limit must be 1..100'
  );
  const options = {
    extra: { words, roots: [...rootMap.values()] },
    mr: { rows: input.market.rows },
    category: input.category,
    limit: input.limit ?? 20,
    exclude: [],
  };
  const candidates = matrixCall('prepareDemandCandidates', options);
  const generated = matrixCall('generate', options);
  return envelope('comparison-draft', merged.scope, input, {
    status: 'draft-needs-review',
    keywords: words,
    roots: [...rootMap.values()],
    marketArtifactId: input.market.artifactId,
    marketSampleCount: input.market.rows.length,
    candidates,
    generated,
    aiCopyRefinementExecuted: false,
    limitations: [
      'Observed sample coverage is not proof of a market-wide gap',
      'Generated local copy requires review before use',
    ],
  });
}
