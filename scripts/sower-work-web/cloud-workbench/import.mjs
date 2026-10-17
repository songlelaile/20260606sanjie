import { createRequire } from 'node:module';
import { merge, analysisPlan, DEMAND_TYPES } from './workflow/scripts/core.mjs';
const require = createRequire(import.meta.url);
const { keywordMergeKey } = require('./workflow/vendor/keywordMerge.cjs');
export { DEMAND_TYPES, analysisPlan };
export const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') { quoted = false; afterQuote = true; } else cell += ch; }
    else if (ch === '"') { if (cell || afterQuote) fail('CSV_QUOTE_INVALID'); quoted = true; }
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      row.push(cell); cell = ''; afterQuote = false;
      if (ch !== ',') { if (row.some(value => value !== '')) rows.push(row); row = []; if (ch === '\r' && text[i + 1] === '\n') i++; }
    } else { if (afterQuote) fail('CSV_TRAILING_TEXT'); cell += ch; }
    if (cell.length > 4096 || row.length > 100 || rows.length > 5001) fail('INPUT_LIMIT', 413);
  }
  if (quoted) fail('CSV_QUOTE_UNCLOSED');
  row.push(cell); if (row.some(value => value !== '')) rows.push(row);
  if (!rows.length || rows.length > 5001) fail('CSV_EMPTY_OR_TOO_LARGE');
  const header = rows.shift().map((value, i) => i === 0 ? value.replace(/^\uFEFF/, '').trim() : value.trim());
  if (new Set(header).size !== header.length || header.some(value => !value || ['__proto__', 'prototype', 'constructor'].includes(value))) fail('CSV_HEADER_INVALID');
  return rows.map(values => { if (values.length !== header.length) fail('CSV_COLUMN_MISMATCH'); return Object.fromEntries(header.map((key, i) => [key, values[i]])); });
}
const text = buffer => { try { const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (value.includes('\0')) fail('TEXT_UNREADABLE'); return value; } catch { fail('TEXT_UNREADABLE'); } };
export function jsonFile(buffer) { try { return JSON.parse(text(buffer)); } catch { fail('JSON_INVALID'); } }
export function decodeContent(value) {
  if (typeof value !== 'string') fail('FILE_ENCODING_INVALID');
  if (value.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) fail('FILE_SIZE_LIMIT', 413);
  const padding = value.indexOf('=');
  if (value.length % 4 || /[^A-Za-z0-9+/=]/.test(value) || (padding >= 0 && !/^={1,2}$/.test(value.slice(padding)))) fail('FILE_ENCODING_INVALID');
  const buffer = Buffer.from(value, 'base64'); if (buffer.toString('base64') !== value) fail('FILE_ENCODING_INVALID');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) fail('FILE_SIZE_LIMIT', 413); return buffer;
}
export function importKeywords(buffer, fileName, suppliedScope, sourceKind = '热词榜') {
  let input;
  if (/\.json$/i.test(fileName)) input = jsonFile(buffer);
  else if (/\.csv$/i.test(fileName)) {
    const rows = parseCsv(text(buffer));
    const scope = suppliedScope;
    const groups = new Map();
    for (const original of rows) {
      const kw = original.kw ?? original['关键词']; if (typeof kw !== 'string' || !kw.trim() || kw.length > 500) fail('KEYWORD_INVALID');
      const raw = original.pop ?? original['人气'] ?? '';
      const pop = /^\d+(?:\.\d+)?$/.test(String(raw).trim()) && Number.isFinite(Number(raw)) && Number(raw) <= Number.MAX_SAFE_INTEGER ? Number(raw) : null;
      const kind = original.kind || original['来源'] || sourceKind;
      if (!['热词榜', '衍生词榜'].includes(kind)) fail('SOURCE_KIND_INVALID');
      if (!groups.has(kind)) groups.set(kind, []); groups.get(kind).push({ kw, pop, original });
    }
    input = { scope, sources: [...groups].map(([kind, words]) => ({ kind, words, scope, artifactId: 'pending-original-hash' })) };
  } else fail('KEYWORD_FILE_TYPE_UNSUPPORTED');
  if (!input || !Array.isArray(input.sources) || input.sources.length > 10 || input.sources.reduce((total, source) => total + (source.words?.length || 0), 0) > 5000) fail('KEYWORD_LIMIT', 413);
  const scopeLimit = value => { if (!value || ['accountId', 'workspaceId', 'platform', 'categoryId', 'startDate', 'endDate'].some(key => typeof value[key] !== 'string' || value[key].length > 256) || (value.objectId !== null && (typeof value.objectId !== 'string' || value.objectId.length > 256))) fail('SCOPE_FIELD_INVALID'); };
  scopeLimit(input.scope);
  for (const source of input.sources) { scopeLimit(source.scope); if (!Array.isArray(source.words) || source.words.some(word => !word || typeof word.kw !== 'string' || word.kw.length > 500)) fail('KEYWORD_INVALID'); }
  return input;
}
export function mergeImported(input, originalHash) {
  const bound = { ...input, browserCollectionVerified: false, sources: input.sources.map((source, i) => ({ ...source, originalArtifactId: source.artifactId ?? null, artifactId: `uploaded:${originalHash}:source:${i + 1}` })) };
  return merge(bound);
}
export function validateAnnotations(merged, values) {
  if (!Array.isArray(values) || values.length !== merged.words.length) fail('ANNOTATION_COVERAGE_INCOMPLETE');
  const expected = new Set(merged.words.map(word => keywordMergeKey(word.kw))); const seen = new Set();
  return values.map(value => {
    if (!value || typeof value.kw !== 'string') fail('ANNOTATION_KEYWORD_MISMATCH');
    const key = keywordMergeKey(value.kw); if (!expected.has(key) || seen.has(key)) fail('ANNOTATION_KEYWORD_MISMATCH'); seen.add(key);
    if (!Array.isArray(value.parts) || !value.parts.length || value.parts.length > 20 || value.parts.length !== value.partTypes?.length || value.parts.some(part => typeof part !== 'string' || !part.trim() || part.length > 500) || value.partTypes.some(type => !DEMAND_TYPES.includes(type)) || keywordMergeKey(value.parts.join('')) !== key) fail('ANNOTATION_ROOT_MAPPING_INVALID');
    return { kw: value.kw, parts: value.parts.map(part => part.trim()), partTypes: value.partTypes.slice(), method: 'human', revision: 'cloud-human-confirmed-v1' };
  });
}
export function csvExport(sheet) {
  const safe = value => { let string = value == null ? '' : String(value); if (/^[\s\u0000-\u001f]*[=+\-@]/.test(string)) string = "'" + string; return '"' + string.replace(/"/g, '""') + '"'; };
  return Buffer.from('\uFEFF' + [sheet.headers, ...sheet.rows].map(row => row.map(safe).join(',')).join('\r\n') + '\r\n');
}
export function knowledgeText(fileName, buffer) {
  if (!/\.(?:txt|md|json|pdf|doc|docx|xlsx|png|jpg|jpeg|webp)$/i.test(fileName)) fail('KNOWLEDGE_FILE_TYPE_UNSUPPORTED');
  if (/\.(?:txt|md|json)$/i.test(fileName)) { const all = text(buffer); return { status: 'ready', statusCode: 'ok', text: all.slice(0, 1000000), textChars: Math.min(all.length, 1000000), truncated: all.length > 1000000 }; }
  if (/\.(?:png|jpg|jpeg|webp)$/i.test(fileName)) return { status: 'ready', statusCode: 'image_no_ocr', text: '', textChars: 0, truncated: false };
  return { status: 'pending', statusCode: 'parser_unavailable', text: '', textChars: 0, truncated: false };
}
