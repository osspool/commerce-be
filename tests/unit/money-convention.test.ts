/**
 * Money convention guard (lint-as-test — be-prod uses biome, which lacks
 * flexible custom-AST rules, so this enforces the rule in CI instead).
 *
 * RULE: major→minor money conversion goes through `#shared/money`
 * (`majorToMinor` / `takaToPaisa`), never a raw `Math.round(x * 100)`. That
 * keeps one currency-aware authority (BDT=100, JPY=1, KWD=1000) and prevents
 * the magic-number drift the 2026-06 sweep removed.
 *
 * It flags the WRITE fingerprint `Math.round(<x> * 100)` (creating minor units)
 * but NOT `Math.round(<x> * 100) / 100` (2-decimal rounding of a MAJOR value —
 * a different, legitimate operation) and not comments.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('../../', import.meta.url)), 'src');

// `Math.round( <operand> * 100 )` NOT followed by `/ 100` (the latter is 2dp
// rounding of a major value, not minor-unit creation). The operand is captured
// so we can exclude rate→percentage conversions (`vdsRate * 100` → "50%"),
// which are display math, not money.
const MONEY_WRITE = /Math\.round\(([^;\n]*?)\*\s*100\s*\)(?!\s*\/\s*100)/;
const RATE_OPERAND = /rate|percent|ratio|margin/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

describe('money convention', () => {
  it('has no raw Math.round(x * 100) money conversions outside #shared/money', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.replace(/\\/g, '/').endsWith('shared/money.ts')) continue;
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        const m = line.match(MONEY_WRITE);
        if (!m) return;
        if (RATE_OPERAND.test(m[1])) return; // rate→percentage, not money
        offenders.push(`${file.replace(/\\/g, '/').split('/src/')[1]}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Use majorToMinor() from #shared/money for major→minor money, not raw ×100:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
