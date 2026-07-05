/**
 * Pure-function coverage for the calibration metrics (07 §7.3–7.4):
 * confusion-derived precision/recall/F1, accuracy, Brier, and the failed-class
 * precision floor.
 */
import { describe, it, expect } from 'vitest';
import {
  labelToOutcome,
  classMetricsFor,
  accuracy,
  brierScore,
  calibrationMetrics,
  FAILED_PRECISION_FLOOR,
  type LabelledPair,
} from '../cost-per-task/calibration.js';

const pair = (predicted: LabelledPair['predicted'], actual: LabelledPair['actual'], score: number | null = null): LabelledPair =>
  ({ predicted, actual, score });

describe('labelToOutcome', () => {
  it('maps the three label values to outcomes', () => {
    expect(labelToOutcome('success')).toBe('success');
    expect(labelToOutcome('fail')).toBe('failed');
    expect(labelToOutcome('partial')).toBe('in_flight');
  });
});

describe('classMetricsFor', () => {
  it('perfect agreement → precision/recall/f1 = 1', () => {
    const pairs = [pair('success', 'success'), pair('success', 'success')];
    const m = classMetricsFor(pairs, 'success');
    expect(m).toMatchObject({ support: 2, predicted: 2, truePositives: 2, precision: 1, recall: 1, f1: 1 });
  });

  it('precision is null when the class is never predicted; recall null when never actual', () => {
    const pairs = [pair('success', 'success')];
    const failed = classMetricsFor(pairs, 'failed');
    expect(failed.precision).toBeNull(); // predicted 0
    expect(failed.recall).toBeNull();    // support 0
    expect(failed.f1).toBeNull();
  });

  it('computes TP / FP / FN correctly on a mixed set', () => {
    // failed: predicted on p1,p2; actual on p1,p3 → TP=1, predicted=2, support=2
    const pairs = [
      pair('failed', 'failed'),  // TP
      pair('failed', 'success'), // FP
      pair('success', 'failed'), // FN
    ];
    const m = classMetricsFor(pairs, 'failed');
    expect(m.truePositives).toBe(1);
    expect(m.predicted).toBe(2);
    expect(m.support).toBe(2);
    expect(m.precision).toBeCloseTo(0.5, 10);
    expect(m.recall).toBeCloseTo(0.5, 10);
    expect(m.f1).toBeCloseTo(0.5, 10);
  });
});

describe('accuracy', () => {
  it('null on empty, fraction otherwise', () => {
    expect(accuracy([])).toBeNull();
    expect(accuracy([pair('success', 'success'), pair('failed', 'success')])).toBeCloseTo(0.5, 10);
  });
});

describe('brierScore', () => {
  it('null when no observable pair carries a score', () => {
    expect(brierScore([pair('success', 'success', null)])).toBeNull();
    // in_flight actual is not observable → excluded even with a score
    expect(brierScore([pair('in_flight', 'in_flight', 0.4)])).toBeNull();
  });

  it('perfect predictions score 0', () => {
    const pairs = [pair('success', 'success', 1), pair('failed', 'failed', -1)];
    expect(brierScore(pairs)).toBeCloseTo(0, 10);
  });

  it('an uninformative score (0 → p=0.5) scores 0.25', () => {
    expect(brierScore([pair('success', 'success', 0)])).toBeCloseTo(0.25, 10);
  });

  it('clamps scores outside [-1, 1]', () => {
    // score 5 → clamp 1 → p=1; actual success → 0 error
    expect(brierScore([pair('success', 'success', 5)])).toBeCloseTo(0, 10);
  });
});

describe('calibrationMetrics', () => {
  it('reports observableN, per-class metrics, and the failed-precision floor', () => {
    const pairs = [
      pair('failed', 'failed', -1),     // observable, correct failed
      pair('failed', 'failed', -1),     // observable, correct failed
      pair('success', 'success', 1),    // observable
      pair('in_flight', 'in_flight', 0),// not observable
    ];
    const m = calibrationMetrics(pairs, 0.7);
    expect(m.n).toBe(4);
    expect(m.observableN).toBe(3);
    expect(m.failedPrecision).toBe(1); // 2/2 predicted-failed are failed
    expect(m.meetsFailedFloor).toBe(true);
    expect(m.accuracy).toBeCloseTo(1, 10);
  });

  it('fails the floor when failed-precision is below it', () => {
    const pairs = [pair('failed', 'failed'), pair('failed', 'success')]; // precision 0.5
    const m = calibrationMetrics(pairs, 0.7);
    expect(m.failedPrecision).toBeCloseTo(0.5, 10);
    expect(m.meetsFailedFloor).toBe(false);
  });

  it('fails the floor when failed is never predicted (precision null)', () => {
    const m = calibrationMetrics([pair('success', 'failed')], 0.7);
    expect(m.failedPrecision).toBeNull();
    expect(m.meetsFailedFloor).toBe(false);
  });

  it('uses the default floor when none is given', () => {
    expect(FAILED_PRECISION_FLOOR).toBeGreaterThan(0);
    const m = calibrationMetrics([pair('failed', 'failed')]);
    expect(m.meetsFailedFloor).toBe(true); // precision 1 ≥ default
  });
});
