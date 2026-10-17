import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const copies = [
  'src/components/sower-work/SowerWorkStudio.tsx',
  'src/components/sower-work/SowerWallet.tsx',
  'src/components/sower-work/frame-status.ts',
  'src/components/sower-work/SowerWorkStudio.module.css',
  'src/app/globals.css',
  'src/lib/sower-work-credit-contract.ts',
  'src/lib/creative-credit-contract.ts',
  'src/lib/model-gateway/billing-contract.ts',
];
const write = async (root, file, value) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value); };

/** Create an explicit fixture shell while retaining the actual component and dependency bytes. */
export async function createFixtureProject({ workspace, directory, dependencies }) {
  await fs.mkdir(directory, { recursive: true });
  const manifest = [];
  for (const file of copies) {
    const bytes = await fs.readFile(path.join(workspace, file));
    await write(directory, file, bytes);
    const copied = await fs.readFile(path.join(directory, file));
    if (digest(copied) !== digest(bytes)) throw new Error('FIXTURE_COPY_HASH_MISMATCH');
    manifest.push({ source: path.join(workspace, file), relativePath: file, bytes: bytes.length, sha256: digest(bytes), exactByteCopy: true });
  }
  const sourcePackage = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  await write(directory, 'package.json', JSON.stringify({ name: 'sower-work-isolated-component-fixture', version: '0.0.0', private: true, scripts: { dev: 'next dev' }, dependencies: Object.fromEntries(['next', 'react', 'react-dom', 'lucide-react'].map((name) => [name, sourcePackage.dependencies[name]])), devDependencies: Object.fromEntries(['typescript', '@types/node', '@types/react', '@types/react-dom'].map((name) => [name, sourcePackage.devDependencies[name]])) }, null, 2));
  await write(directory, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['dom', 'dom.iterable', 'es2022'], strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'preserve', resolveJsonModule: true, isolatedModules: true, incremental: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./src/*'] } }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }, null, 2));
  await write(directory, 'next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
  await write(directory, 'next.config.mjs', "export default { poweredByHeader: false, allowedDevOrigins: ['localhost'], experimental: { workerThreads: false } };\n");
  await write(directory, 'src/app/layout.tsx', `import './globals.css';\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html lang="zh-CN"><body><div role="note" style={{ padding: '8px 16px', borderBottom: '1px solid var(--line)', color: 'var(--warn)', fontSize: 13 }}>本地隔离验收 · 实际组件副本 · 积分为只读测试数据 · 未连接真实支付或模型</div>{children}</body></html>; }\n`);
  await write(directory, 'src/app/sower-work/page.tsx', `import { SowerWorkStudio } from '@/components/sower-work/SowerWorkStudio';\nexport default function Page() { return <main className="main"><SowerWorkStudio /></main>; }\n`);
  await write(directory, 'src/app/models/page.tsx', `export default function Page() { return <main className="main"><h1>只读测试套餐</h1><p>此页面没有充值、支付或扣费能力。返回 Sower Work 继续验收。</p><a href="/sower-work">返回</a></main>; }\n`);
  await write(directory, 'src/app/api/sower-work/credits/route.ts', `import { SOWER_WORK_CREDIT_META } from '@/lib/sower-work-credit-contract';\nexport async function GET() { return Response.json({ data: { wallet: { exists: true, balanceCents: 123450, balancePoints: 12345 }, plan: { code: 'fixture_read_only', name: '只读测试套餐（非真实积分）', multiplierBps: 10000, ruleVersion: 1 }, models: [], catalogError: null, centsPerPoint: 10, observedAt: new Date().toISOString() }, meta: { ...SOWER_WORK_CREDIT_META, fixture: true, environment: 'isolated-local', realWalletRead: false } }, { headers: { 'Cache-Control': 'no-store', 'X-Sower-Fixture': 'read-only-synthetic-credits' } }); }\n`);
  await write(directory, 'src/app/api/sower-work/credits/ledger/route.ts', `import { SOWER_WORK_CREDIT_META } from '@/lib/sower-work-credit-contract';\nexport async function GET(request: Request) { const requested = Number(new URL(request.url).searchParams.get('page') || 1); const page = Number.isSafeInteger(requested) && requested > 0 ? requested : 1; const pageSize = 50; const all = Array.from({ length: 52 }, (_, i) => ({ id: 'fixture-ledger-' + i, billingEventId: 'fixture-event-' + i, kind: i === 51 ? 'opening' : 'recharge', status: 'fixture', error: '', createdAt: new Date(Date.UTC(2026, 9, 2, 0, 52 - i)).toISOString(), planCode: 'fixture_read_only', planName: '只读测试套餐', multiplierBps: 10000, ruleVersion: 1, endpoint: 'fixture-only', provider: '', model: '仅测试展示，不代表真实流水', requestId: 'fixture-' + i, deltaCents: 10, deltaPoints: 1, baseCostCents: 0, chargedCostCents: 0, chargedPoints: 0, balanceBeforeCents: (52 - i - 1) * 10, balanceBeforePoints: 52 - i - 1, balanceAfterCents: (52 - i) * 10, balanceAfterPoints: 52 - i, promptTokens: 0, completionTokens: 0, totalTokens: 0, imageCount: 0, durationMs: null, upstreamStatus: null })); return Response.json({ data: { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize }, meta: { ...SOWER_WORK_CREDIT_META, fixture: true, environment: 'isolated-local', realWalletRead: false } }, { headers: { 'Cache-Control': 'no-store', 'X-Sower-Fixture': 'read-only-synthetic-ledger' } }); }\n`);
  await fs.symlink(dependencies, path.join(directory, 'node_modules'));
  await write(directory, 'copied-components-manifest.json', JSON.stringify({ schema: 'SW_EXACT_COMPONENT_FIXTURE_V1', createdAt: new Date().toISOString(), finalRelease: false, copiedFiles: manifest, dependencyDirectory: dependencies, runtimeVersions: { node: process.version, next: JSON.parse(await fs.readFile(path.join(dependencies, 'next/package.json'), 'utf8')).version, react: JSON.parse(await fs.readFile(path.join(dependencies, 'react/package.json'), 'utf8')).version } }, null, 2));
  return manifest;
}
