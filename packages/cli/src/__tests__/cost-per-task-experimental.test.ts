/**
 * Phase-A integration + guardrail tests for the experimental outcome signals.
 *
 * These lock the safety properties the accuracy plan requires:
 *  - behavior-preserving: with no extended signals, `classifyOutcome` is the
 *    legacy ladder verbatim (07 §7.5);
 *  - a decisive base verdict is never flipped by signals;
 *  - no-signal never becomes failure;
 *  - the `experimentalSignals` flag is never enabled by a production call site.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyOutcome } from '../cost-per-task/index.js';
import type { OutcomeSignal } from '../cost-per-task/outcome-types.js';
import type { ProjectGitActivity } from '../recap/types.js';

const git = (o: Partial<ProjectGitActivity>): ProjectGitActivity => ({
  commitsToday: 0, filesChanged: 0, linesAdded: 0, linesRemoved: 0, subjects: [], pushed: false, prMerged: null, ...o,
});

const repair: OutcomeSignal = { id: 'repair_turn', value: -1, evidence: 'repair_turn' };
const accept: OutcomeSignal = { id: 'acceptance_turn', value: 1, evidence: 'acceptance_turn' };

describe('classifyOutcome — experimental signals (Phase A)', () => {
  // The four base cases produced by the legacy ladder.
  const highCommitted = { confidence: 'high' as const, git: git({ commitsToday: 1, pushed: true }), hasMutatingWork: true };
  const mediumNoCommit = { confidence: 'medium' as const, git: git({ commitsToday: 0 }), hasMutatingWork: true }; // → in_flight
  const lowFailed = { confidence: 'low' as const, git: git({ commitsToday: 0 }), hasMutatingWork: true };       // → failed
  const lowUnobs = { confidence: 'low' as const, git: null, hasMutatingWork: false };                            // → unobservable

  it('is behavior-preserving: no extended signals ⇒ legacy verdict verbatim', () => {
    // Passing `undefined` (flag off) must equal omitting the arg entirely.
    for (const item of [highCommitted, mediumNoCommit, lowFailed, lowUnobs]) {
      const legacy = classifyOutcome(item);
      const offExplicit = classifyOutcome(item, null, undefined);
      expect(offExplicit).toEqual(legacy);
    }
    expect(classifyOutcome(mediumNoCommit).outcome).toBe('in_flight');
    expect(classifyOutcome(lowFailed).outcome).toBe('failed');
    expect(classifyOutcome(lowUnobs).outcome).toBe('unobservable');
  });

  it('a repair signal flips a held-out (in_flight) base to failed', () => {
    expect(classifyOutcome(mediumNoCommit, null, [repair]).outcome).toBe('failed');
  });

  it('an acceptance signal flips a held-out (unobservable) base to success', () => {
    expect(classifyOutcome(lowUnobs, null, [accept]).outcome).toBe('success');
  });

  it('never flips a decisive base: success stays success even with a repair signal', () => {
    expect(classifyOutcome(highCommitted, null, [repair]).outcome).toBe('success');
  });

  it('never flips a decisive base: failed stays failed even with an acceptance signal', () => {
    expect(classifyOutcome(lowFailed, null, [accept]).outcome).toBe('failed');
  });

  it('no signals ⇒ held-out base is unchanged, never failure', () => {
    expect(classifyOutcome(mediumNoCommit, null, []).outcome).toBe('in_flight');
    expect(classifyOutcome(lowUnobs, null, []).outcome).toBe('unobservable');
  });

  it('an explicit label still wins over any extended signals', () => {
    expect(classifyOutcome(mediumNoCommit, 'success', [repair])).toEqual({ outcome: 'success', labelled: true });
    expect(classifyOutcome(highCommitted, 'fail', [accept])).toEqual({ outcome: 'failed', labelled: true });
  });
});

describe('experimentalSignals flag is never enabled by production code (security review Sec-4)', () => {
  it('no source file outside __tests__ sets `experimentalSignals: true`', () => {
    const srcRoot = join(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const text = readFileSync(full, 'utf8');
        if (/experimentalSignals\s*:\s*true/.test(text)) offenders.push(full);
      }
    };
    walk(srcRoot);
    expect(offenders, `experimentalSignals must stay off in production code; found in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
