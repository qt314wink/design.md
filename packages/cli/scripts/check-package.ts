#!/usr/bin/env bun
// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Package verification script for @google/design.md
 *
 * Runs 20 checks across 4 phases to ensure the package is correctly
 * structured for npm publication. Exit code 0 = all pass, 1 = failures.
 *
 * Usage: bun run scripts/check-package.ts
 */

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { Glob } from 'bun';
import { tmpdir } from 'os';

// ── Helpers ────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dir, '..');
const PKG_PATH = join(ROOT, 'package.json');

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✅ ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.error(`  ❌ ${label}`);
  if (detail) console.error(`     → ${detail}`);
  failed++;
}

function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass(label);
  else fail(label, detail);
}

function heading(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}

function readPkg(): Record<string, unknown> {
  return JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
}

function exec(cmd: string, opts?: { cwd?: string }): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      cwd: opts?.cwd ?? ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${process.env['HOME'] ?? ''}/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env['PATH'] ?? ''}`,
      },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ── Phase 1: Pre-pack validation ───────────────────────────────────

function phase1_config() {
  heading('Phase 1a: Package.json validation');

  const pkg = readPkg();

  const files = pkg['files'] as string[] | undefined;
  check('#1  `files` field exists', Array.isArray(files) && files.length > 0,
    'Add a "files" array to package.json to control what ships');

  const exports = pkg['exports'] as Record<string, Record<string, string>> | undefined;
  check('#2  `exports["."]` defined', !!exports?.['.'],
    'Missing exports["."] in package.json');

  if (exports?.['.']) {
    check('#3  `exports["."].types` field exists', !!exports['.']?.['types'],
      'Missing types condition in exports["."]');
  } else {
    fail('#3  `exports["."].types` field exists', 'Skipped — no exports');
  }

  const main = pkg['main'] as string | undefined;
  check('#4  `main` field exists', !!main,
    'Missing "main" field in package.json');

  const types = pkg['types'] as string | undefined;
  check('#5  `types` field exists', !!types,
    'Missing "types" field in package.json');

  // bin must expose a Windows-friendly alias (no dot in the name).
  // `design.md` collides with the .md file association on Windows/PowerShell.
  const bin = pkg['bin'] as Record<string, string> | string | undefined;
  const binEntries = typeof bin === 'object' && bin !== null ? Object.keys(bin) : [];
  const hasDotFreeAlias = binEntries.some((name) => !name.includes('.'));
  check('#5c bin map exposes a Windows-friendly alias (no dot in the name)',
    hasDotFreeAlias,
    `bin entries: ${binEntries.join(', ') || '(none)'} — add an alias without a dot for Windows compatibility`);
}

function phase1_paths() {
  heading('Phase 1b: Path resolution (post-build)');

  const pkg = readPkg();
  const exports = pkg['exports'] as Record<string, Record<string, string>> | undefined;
  const dotExport = exports?.['.'];

  if (dotExport) {
    const importPath = join(ROOT, dotExport['import'] ?? '');
    const typesPath = join(ROOT, dotExport['types'] ?? '');
    check('#2b `exports["."].import` resolves', existsSync(importPath),
      `Missing: ${dotExport['import']}`);
    check('#3b `exports["."].types` resolves', existsSync(typesPath),
      `Missing: ${dotExport['types']}`);
  }

  const main = pkg['main'] as string | undefined;
  check('#4b `main` resolves', !!main && existsSync(join(ROOT, main)),
    `Missing: ${main}`);

  const types = pkg['types'] as string | undefined;
  check('#5b `types` resolves', !!types && existsSync(join(ROOT, types)),
    `Missing: ${types}`);
}

// ── Phase 2: Clean build ───────────────────────────────────────────

function phase2() {
  heading('Phase 2: Clean build');

  const distPath = join(ROOT, 'dist');
  if (existsSync(distPath)) {
    rmSync(distPath, { recursive: true, force: true });
  }
  check('#6  Clean dist', !existsSync(distPath));

  const build = exec('bun run build');
  check('#7  Build succeeds', build.ok, build.stderr || 'tsc exited with non-zero');

  if (!existsSync(distPath)) {
    fail('#8  No test files in dist', 'dist/ does not exist after build');
    fail('#9  No fixture files in dist', 'dist/ does not exist after build');
    return;
  }

  const testGlob = new Glob('**/*.test.*');
  const testFiles = Array.from(testGlob.scanSync({ cwd: distPath, absolute: false }));
  check('#8  No test files in dist', testFiles.length === 0,
    `Found: ${testFiles.join(', ')}`);

  const fixtureGlob = new Glob('**/fixtures/**');
  const fixtureFiles = Array.from(fixtureGlob.scanSync({ cwd: distPath, absolute: false }));
  check('#9  No fixture files in dist', fixtureFiles.length === 0,
    `Found: ${fixtureFiles.join(', ')}`);
}

// ── Phase 3: Pack audit ────────────────────────────────────────────

function phase3() {
  heading('Phase 3: Pack audit');

  const pack = exec('npm pack --dry-run --json 2>/dev/null');
  let fileList: string[] = [];

  if (pack.ok) {
    try {
      const parsed = JSON.parse(pack.stdout);
      const files = (parsed[0]?.files ?? parsed.files ?? []) as Array<{ path: string }>;
      fileList = files.map((f) => f.path);
    } catch {
      const lines = pack.stdout.split('\n');
      fileList = lines
        .map((l) => l.replace(/^npm notice\s+\d+[\w.]+\s+/, '').trim())
        .filter((l) => l.includes('/') || l.endsWith('.js') || l.endsWith('.json'));
    }
  }

  check('#10 `npm pack --dry-run` succeeds', pack.ok && fileList.length > 0,
    'npm pack failed or returned empty file list');

  if (fileList.length === 0) {
    for (const n of ['#11', '#12', '#13', '#14', '#15']) {
      fail(`${n} (skipped)`, 'No file list from npm pack');
    }
    return;
  }

  const rawTs = fileList.filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.d.ts.map')
  );
  check('#11 No source .ts files in tarball', rawTs.length === 0, `Found: ${rawTs.join(', ')}`);

  const testInPack = fileList.filter((f) => f.includes('.test.'));
  check('#12 No test files in tarball', testInPack.length === 0, `Found: ${testInPack.join(', ')}`);

  const configInPack = fileList.filter((f) => f.includes('tsconfig'));
  check('#13 No config files in tarball', configInPack.length === 0, `Found: ${configInPack.join(', ')}`);

  const fixturesInPack = fileList.filter((f) => f.includes('fixtures'));
  check('#14 No fixtures in tarball', fixturesInPack.length === 0, `Found: ${fixturesInPack.join(', ')}`);

  const hasIndex = fileList.some((f) => f.includes('dist/index.js'));
  const hasTypes = fileList.some((f) => f.includes('dist/index.d.ts'));
  check('#15 Entry point present in tarball', hasIndex && hasTypes,
    `index.js: ${hasIndex}, index.d.ts: ${hasTypes}`);
}

// ── Phase 4: Consumer smoke test ───────────────────────────────────

function phase4() {
  heading('Phase 4: Consumer smoke test');

  const distIndex = join(ROOT, 'dist', 'linter', 'index.js');
  const distTypes = join(ROOT, 'dist', 'linter', 'index.d.ts');
  const tmpDir = mkdtempSync(join(tmpdir(), 'check-pkg-'));

  // 16. ESM import
  const smokeFile = join(tmpDir, 'smoke.mjs');
  writeFileSync(
    smokeFile,
    `import { lint } from '${distIndex}';\n` +
    `if (typeof lint !== 'function') { process.exit(1); }\n` +
    `console.log('ok');\n`
  );
  const importCheck = exec(`node ${smokeFile}`);
  if (!importCheck.ok) {
    console.error('STDOUT:', importCheck.stdout);
    console.error('STDERR:', importCheck.stderr);
  }
  check('#16 Import resolution (ESM)',
    importCheck.ok && importCheck.stdout.trim().endsWith('ok'),
    'Could not import lint() from dist/linter/index.js');

  // 17. Type declarations
  const dtsContent = existsSync(distTypes) ? readFileSync(distTypes, 'utf-8') : '';
  check('#17 Type declarations valid',
    dtsContent.includes('export') && dtsContent.includes('lint') && dtsContent.includes('LintReport'),
    'dist/linter/index.d.ts missing lint export or LintReport type');

  // 18. Runtime sanity — verifies LintReport shape including tailwindV4Config
  //     tailwindV4Config was added in feat: add tailwindV4Config to LintReport
  const sanityFile = join(tmpDir, 'sanity.mjs');
  writeFileSync(
    sanityFile,
    `import { lint } from '${distIndex}';\n` +
    `const result = lint('---\\nname: Test\\ncolors:\\n  primary: "#ff0000"\\n---');\n` +
    `const keys = Object.keys(result);\n` +
    `const expected = ['designSystem','findings','summary','tailwindConfig','tailwindV4Config'];\n` +
    `const missing = expected.filter(k => !keys.includes(k));\n` +
    `if (missing.length > 0) {\n` +
    `  console.error('Missing keys:', missing.join(', '), '\u2014 actual:', keys.join(', '));\n` +
    `  process.exit(1);\n` +
    `}\n` +
    `if (typeof result.designSystem !== 'object') { console.error('designSystem not object'); process.exit(1); }\n` +
    `if (!Array.isArray(result.findings)) { console.error('findings not array'); process.exit(1); }\n` +
    `if (typeof result.summary.errors !== 'number') { console.error('summary.errors not number'); process.exit(1); }\n` +
    `if (typeof result.tailwindV4Config.success !== 'boolean') { console.error('tailwindV4Config.success not boolean'); process.exit(1); }\n` +
    `console.log('ok');\n`
  );
  const sanityCheck = exec(`node ${sanityFile}`);
  if (!sanityCheck.ok) {
    console.error('STDOUT:', sanityCheck.stdout);
    console.error('STDERR:', sanityCheck.stderr);
  }
  check('#18 Runtime sanity (LintReport shape + tailwindV4Config)',
    sanityCheck.ok && sanityCheck.stdout.trim().endsWith('ok'),
    'lint() did not return expected shape including tailwindV4Config');

  // 19. CLI --help
  const cliIndex = join(ROOT, 'dist', 'index.js');
  const cliCheck = exec(`node ${cliIndex} --help`);
  check('#19 CLI entry point valid',
    cliCheck.ok && !cliCheck.stderr.includes('ENOENT'),
    'CLI failed to run or reported missing files');

  // 20. CLI spec command
  const specCheck = exec(`node ${cliIndex} spec`);
  check('#20 CLI spec command valid',
    specCheck.ok && !specCheck.stderr.includes('Failed to load spec.md'),
    'CLI spec command failed to load spec.md');

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── Main ───────────────────────────────────────────────────────────

console.log('🔍 Package verification: @google/design.md\n');

phase1_config();
phase2();
phase1_paths();
phase3();
phase4();

console.log(`\n${'═'.repeat(60)}`);
console.log(`  ✅ ${passed} passed   ❌ ${failed} failed`);
console.log(`${'═'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
