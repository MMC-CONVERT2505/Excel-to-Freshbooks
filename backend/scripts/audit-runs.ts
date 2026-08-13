/**
 * Reads the saved migration history from the database — the authoritative record
 * of what was pushed, to which FreshBooks company, and when.
 *
 * Read-only. This script never contacts FreshBooks and never deletes anything.
 *
 *   # All runs, newest first, with the company each one targeted
 *   npx tsx scripts/audit-runs.ts
 *
 *   # Only runs that went to a specific company
 *   npx tsx scripts/audit-runs.ts --token 3
 *
 *   # Every record pushed by one run (the exact undo list)
 *   npx tsx scripts/audit-runs.ts --run 12
 *
 *   # Write that list to a file / CSV for review
 *   npx tsx scripts/audit-runs.ts --run 12 --out pushed.json
 *   npx tsx scripts/audit-runs.ts --run 12 --csv pushed.csv
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';

// The production image ships compiled dist/ only (src/ is not copied), while local
// dev runs from source. Try dist first, fall back to src.
async function load(mod: string): Promise<any> {
  try { return await import(`../dist/${mod}.js`); }
  catch { return await import(`../src/${mod}.js`); }
}
const prisma = (await load('lib/prisma')).default;

const args = process.argv.slice(2);
const get  = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };

const runId    = get('--run')   ? Number(get('--run'))   : undefined;
const tokenArg = get('--token') ? Number(get('--token')) : undefined;
const outFile  = get('--out');
const csvFile  = get('--csv');

const fmt = (d: Date | null | undefined) =>
  d ? d.toISOString().replace('T', ' ').slice(0, 16) : '—';

async function listRuns() {
  const runs = await prisma.migrationRun.findMany({
    where:   tokenArg ? { tokenId: tokenArg } : {},
    orderBy: { createdAt: 'desc' },
    take:    40,
    include: {
      token:  { select: { companyLabel: true, accountId: true } },
      phases: { select: { entity: true, successCount: true, failedCount: true, skippedCount: true } },
    },
  });

  if (!runs.length) {
    console.log(tokenArg ? `\nNo runs found for token ${tokenArg}.\n` : '\nNo migration runs recorded.\n');
    return;
  }

  console.log('\n  RUN   STARTED             COMPANY                                 PUSHED  FAILED  SKIPPED  STATUS');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────────────────');
  for (const r of runs) {
    const pushed  = r.phases.reduce((s, p) => s + p.successCount, 0);
    const failed  = r.phases.reduce((s, p) => s + p.failedCount,  0);
    const skipped = r.phases.reduce((s, p) => s + p.skippedCount, 0);
    const company = `${r.token?.companyLabel ?? '(unknown)'}${r.tokenId ? ` [t${r.tokenId}]` : ''}`;
    console.log(
      `  ${String(r.id).padEnd(5)} ${fmt(r.startedAt ?? r.createdAt).padEnd(19)} ${company.slice(0, 38).padEnd(38)} ` +
      `${String(pushed).padStart(6)}  ${String(failed).padStart(6)}  ${String(skipped).padStart(7)}  ${r.status}`
    );
  }
  console.log('\n  Inspect one run:  npx tsx scripts/audit-runs.ts --run <RUN>\n');
}

async function showRun(id: number) {
  const run = await prisma.migrationRun.findUnique({
    where:   { id },
    include: {
      token:  { select: { companyLabel: true, accountId: true, businessId: true } },
      phases: { orderBy: { id: 'asc' }, include: { records: { orderBy: { sourceRow: 'asc' } } } },
    },
  });

  if (!run) { console.log(`\nNo run with id ${id}.\n`); return; }

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`  Run       : ${run.id}   (${run.status})`);
  console.log(`  Company   : ${run.token?.companyLabel ?? '(unknown)'}   token=${run.tokenId ?? '?'}  account=${run.token?.accountId ?? '?'}`);
  console.log(`  Started   : ${fmt(run.startedAt ?? run.createdAt)}`);
  console.log(`  Finished  : ${fmt(run.completedAt)}`);
  console.log('════════════════════════════════════════════════════════════════\n');

  const exported: Record<string, { naturalKey: string; sourceRow: number; pushedAt: string }[]> = {};
  const csvRows: string[] = ['entity,natural_key,source_row,pushed_at'];
  let total = 0, missingKey = 0;

  for (const phase of run.phases) {
    const ok = phase.records.filter(r => r.status === 'SUCCESS');
    if (!ok.length) continue;

    const list = ok.map(r => {
      if (!r.naturalKey) missingKey++;
      return {
        naturalKey: r.naturalKey ?? '(no key recorded)',
        sourceRow:  r.sourceRow,
        pushedAt:   (r.lastAttemptAt ?? r.updatedAt).toISOString(),
      };
    });

    exported[phase.entity] = list;
    total += list.length;

    console.log(`  ${String(phase.entity).padEnd(20)} ${String(list.length).padStart(5)} pushed`);
    for (const rec of list.slice(0, 5)) console.log(`      · ${rec.naturalKey}`);
    if (list.length > 5) console.log(`      · … and ${list.length - 5} more`);

    for (const rec of list) {
      csvRows.push(`${phase.entity},"${String(rec.naturalKey).replace(/"/g, '""')}",${rec.sourceRow},${rec.pushedAt}`);
    }
  }

  console.log(`\n  TOTAL PUSHED BY THIS RUN: ${total} record(s)`);
  if (missingKey) console.log(`  ⚠  ${missingKey} record(s) have no naturalKey — identify these from the source sheet.`);

  // externalId is declared in the schema but not written on push; say so plainly
  // rather than letting an empty column look like "nothing was created".
  console.log('  ℹ  FreshBooks IDs are not stored (externalId is never written on push),');
  console.log('     so matching is by natural key — invoice/bill number, organization, etc.\n');

  if (outFile) { writeFileSync(outFile, JSON.stringify(exported, null, 2)); console.log(`  JSON written to ${outFile}`); }
  if (csvFile) { writeFileSync(csvFile, csvRows.join('\n'));                console.log(`  CSV  written to ${csvFile}`); }
  if (outFile || csvFile) console.log('');
}

try {
  if (runId) await showRun(runId);
  else       await listRuns();
} finally {
  await prisma.$disconnect();
}
