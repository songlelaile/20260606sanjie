import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
if (root !== '/Users/shaozhuang/20260606sanjie') throw new Error('Wrong project root');
const out = path.join(root, '.codex-deploy/creative-uat-20261001');
const dest = path.join(out, 'source');
mkdirSync(dest, { recursive: true });
execFileSync('tar', ['-xzf', '/Users/shaozhuang/Downloads/cursor-production-source-20261001.tar.gz', '-C', dest]);
const cursor = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'b59de14'], { encoding: 'utf8' }).trim().split('\n');
const scope = [
 'public/creative', 'src/lib/model-gateway', 'src/components/model-gateway', 'src/app/api/model-gateway', 'src/app/api/v1', 'src/app/v1',
 'src/app/models', 'src/app/login', 'src/app/management', 'src/components/management', 'src/app/api/auth', 'src/app/api/managed-users',
 'src/app/api/invite-codes', 'src/app/api/creative', 'src/app/api/management/creative-orders', 'src/components/creative',
 'src/lib/accounts.ts', 'src/lib/accounts.test.ts', 'src/lib/store/user-store.ts', 'src/lib/store/user-store.test.ts', 'src/lib/store/runtime-store.ts',
 'src/lib/creative-access-policy.ts', 'src/lib/creative-access-policy.test.ts', 'src/lib/creative-entitlements.ts',
 'src/lib/creative-web.test.ts', 'src/lib/creative-proxy.ts', 'src/lib/creative-proxy.test.ts', 'src/lib/server-session.ts',
 'src/lib/auth.ts', 'src/lib/auth.test.ts', 'src/lib/auth-redirect-url.ts', 'src/lib/auth-redirect-url.test.ts',
 'src/lib/uat-environment.ts', 'src/lib/uat-environment.test.ts', 'src/lib/read-json-with-limit.ts', 'src/lib/read-json-with-limit.test.ts', 'src/app/layout.tsx', 'src/components/AppShell.tsx',
 'src/middleware.ts', 'src/middleware.test.ts', 'next.config.mjs', '.env.example', 'vitest.config.ts', '.eslintrc.json',
 'prisma/schema.prisma', 'prisma/migrations/20261001150000_gateway_payment_audit',
 'scripts/payment-uat-db.mjs', 'scripts/payment-uat-db.d.mts', 'scripts/creative-http-uat.mjs'
];
for (const name of [...new Set([...cursor, ...scope])]) {
 const source = path.join(root, name);
 if (existsSync(source)) { mkdirSync(path.dirname(path.join(dest, name)), { recursive: true }); cpSync(source, path.join(dest, name), { recursive: true }); }
}
mkdirSync(path.join(dest, 'docs'), { recursive: true });
for (const name of readdirSync(path.join(root, 'docs')).filter(n => /uat-.*20261001.*\.md$/.test(n))) cpSync(path.join(root, 'docs', name), path.join(dest, 'docs', name));
// Local dependencies stay external; production installer copies its retained dependencies before generating Prisma.
const manifest = [];
function walk(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p=path.join(dir,entry.name); if(entry.name==='node_modules'||entry.name.startsWith('.next')||entry.name==='acceptance'||(entry.name.startsWith('.env')&&entry.name!=='.env.example')) continue; if(entry.isDirectory()) walk(p); else if(entry.isFile()) manifest.push({path:path.relative(dest,p),sha256:createHash('sha256').update(readFileSync(p)).digest('hex')}); } }
walk(dest);
writeFileSync(path.join(out, 'source-manifest.json'), JSON.stringify({ date:'2026-10-01', productionBaseSha256:'07daccedcfac36837c283f2fcbb686ad900d596975b9f4111db21c2d2cf942e1', cursorCommit:'b59de1410eb3cefbb17d01d5f13ce468520a3b56', files:manifest },null,2));
console.log(JSON.stringify({source:dest,files:manifest.length}));
