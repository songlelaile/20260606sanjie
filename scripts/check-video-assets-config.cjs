#!/usr/bin/env node
'use strict';
// Read-only local readiness. Never contacts Ark, creates a grant or prints a key.
const fs = require('node:fs/promises');
const { readConfiguration } = require('../src/lib/video-assets-r51/site-adapter.cjs');
async function main() {
  let configuration = null;
  try { configuration = await readConfiguration(); } catch { /* No private path/parser text. */ }
  const secret = ref => typeof ref === 'string' && /^[A-Z][A-Z0-9_]{2,119}$/.test(ref) && !ref.startsWith('NEXT_PUBLIC_') && !!process.env[ref]?.trim();
  let sourceDirectoryReady = false;
  try { const stat = await fs.lstat(process.env.VIDEO_ASSET_SOURCE_DIRECTORY || ''); sourceDirectoryReady = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o777) === 0o700; } catch { /* Absent. */ }
  let databaseReady = false, prisma;
  if (process.env.DATABASE_URL) try {
    const { PrismaClient } = require('@prisma/client'); prisma = new PrismaClient({ log: [] });
    const rows = await prisma.$queryRawUnsafe("SELECT to_regclass('public.video_asset_binding_state') IS NOT NULL AS present");
    databaseReady = rows[0]?.present === true;
  } catch { /* Only the boolean is public. */ } finally { await prisma?.$disconnect(); }
  const accounts = configuration?.accounts || [];
  const accountConfigured = account => account.enabled === true && ['tenant', 'platform'].includes(account.mode) &&
    typeof account.providerAccountId === 'string' && !account.providerAccountId.includes('replace-') && !!account.projectName &&
    [account.accessKeyIdRef, account.secretAccessKeyRef, account.apiKeyRef].every(secret) &&
    Number.isSafeInteger(account.cloudLimit) && account.cloudLimit > 0 && Number.isSafeInteger(account.externalUsed) && account.externalUsed >= 0;
  const result = {
    configurationValid: !!configuration, sourceDirectoryReady, databaseReady,
    sourceSigningKeyReady: secret(configuration?.sourceSigningKeyRef),
    enabledAccountCount: accounts.filter(a => a.enabled === true).length,
    configuredAccountCount: accounts.filter(accountConfigured).length,
    enabledGrantCount: (configuration?.grants || []).filter(g => g.enabled === true).length,
    providerVerified: false, actualUploadVerified: false, actualVideoVerified: false
  };
  const ready = result.configurationValid && sourceDirectoryReady && databaseReady && result.sourceSigningKeyReady &&
    result.enabledAccountCount > 0 && result.enabledAccountCount === result.configuredAccountCount && result.enabledGrantCount > 0;
  process.stdout.write(JSON.stringify({ localConfigurationReady: ready, checks: result }, null, 2) + '\n');
  process.exitCode = ready ? 0 : 2;
}
main().catch(() => { process.stdout.write('{"localConfigurationReady":false,"error":"PREFLIGHT_UNAVAILABLE"}\n'); process.exitCode = 2; });
