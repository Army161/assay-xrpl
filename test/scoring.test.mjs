/**
 * Scoring tests. No network — these pin the maths, especially the one that
 * would silently produce a false alarm.
 */
import assert from 'node:assert/strict';
import { concentration, gini } from '../src/scoring/concentration.mjs';
import { posture } from '../src/scoring/posture.mjs';
import { decodeAccountFlags, decodeCurrency, encodeCurrency } from '../src/xrpl/client.mjs';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); fail++; }
};

console.log('\nconcentration');

/**
 * THE REGRESSION THIS SUITE EXISTS FOR.
 *
 * Real RLUSD numbers observed on 2026-08-30: issued supply 1,040,586,333 and a
 * partial holder page whose largest entry was 51,031,064. Dividing by the
 * SAMPLED sum (71,916,578) yields 70.96% and reads as a solvency alarm.
 * Dividing by issued supply yields 4.90%, which is the truth.
 */
t('divides by issued supply, not the observed sum', () => {
  const balances = [51031064.54, 2053112, 219650.81, 65727.90, 26179.71];
  const observedSum = balances.reduce((a, b) => a + b, 0);
  const issued = 1040586333.75;

  const c = concentration(balances, issued, { complete: false, pagesFetched: 25 });

  assert.equal(c.top1Pct, 4.904, 'top1 must be against issued supply');
  const naive = +(balances[0] / observedSum * 100).toFixed(3);
  assert.ok(naive > 70, 'sanity: the naive figure really is the alarming one');
  assert.ok(c.top1Pct < 5, 'must not reproduce the naive figure');
});

t('flags partial coverage and quantifies the unseen remainder', () => {
  const c = concentration([100, 50], 1000, { complete: false, pagesFetched: 3 });
  assert.equal(c.complete, false);
  assert.equal(c.coveragePct, 15);
  assert.equal(c.unobservedPct, 85);
  assert.match(c.caveat, /lower bounds/);
  assert.match(c.caveat, /85\.00% more/);
});

t('omits the caveat when coverage is complete', () => {
  const c = concentration([600, 400], 1000, { complete: true, pagesFetched: 1 });
  assert.equal(c.complete, true);
  assert.equal(c.caveat, null);
  assert.equal(c.top1Pct, 60);
});

t('HHI uses DOJ/FTC bands', () => {
  // One holder with everything: HHI = 100^2 = 10000.
  assert.equal(concentration([1000], 1000, { complete: true }).hhiBand.band, 'highly-concentrated');
  // 100 equal holders of 1% each: HHI = 100 * 1 = 100.
  const many = Array.from({ length: 100 }, () => 10);
  assert.equal(concentration(many, 1000, { complete: true }).hhiBand.band, 'dispersed');
});

t('reports not-measurable rather than guessing', () => {
  assert.equal(concentration([], 1000).measurable, false);
  assert.equal(concentration([1, 2], 0).measurable, false);
  assert.equal(concentration([1, 2], null).measurable, false);
});

t('zero and negative balances are excluded', () => {
  const c = concentration([100, 0, -5, 50], 1000, { complete: true });
  assert.equal(c.holdersObserved, 2);
});

console.log('\ngini');
t('gini is 0 for perfect equality, near 1 for total concentration', () => {
  const equal = gini([10, 10, 10, 10]);
  assert.ok(Math.abs(equal) < 0.001, `expected ~0, got ${equal}`);
  const skewed = gini([1, 1, 1, 100000]);
  assert.ok(skewed > 0.7, `expected >0.7, got ${skewed}`);
});
t('gini needs at least two holders', () => assert.equal(gini([5]), null));

console.log('\nposture');

t('an issuer that renounced freeze fails the freeze check', () => {
  const flags = decodeAccountFlags(0x00200000);            // lsfNoFreeze
  const p = posture(flags, { domain: 'example.com' });
  assert.equal(p.checks.freezeCapability.pass, false);
  assert.match(p.checks.freezeCapability.evidence, /permanently renounced/);
});

t('clawback bit 0x80000000 is decoded without sign error', () => {
  // Naive `flags & 0x80000000` is negative in JS; a truthiness check on it
  // still passes, but any arithmetic on the result is wrong. Pin the decode.
  const flags = decodeAccountFlags(0x80000000);
  assert.equal(flags.lsfAllowTrustLineClawback, true);
  assert.equal(flags.lsfNoFreeze, false);
});

t('global freeze surfaces as an emergency, not just a failed check', () => {
  const p = posture(decodeAccountFlags(0x00400000), { domain: 'x.com' });
  assert.ok(p.emergency, 'emergency must be set');
  assert.match(p.emergency, /GLOBAL FREEZE ACTIVE/);
});

t('no global freeze means no emergency', () => {
  assert.equal(posture(decodeAccountFlags(0), {}).emergency, null);
});

t('missing domain fails identity disclosure', () => {
  const p = posture(decodeAccountFlags(0), { domain: null });
  assert.equal(p.checks.identityDisclosure.pass, false);
});

t('score is bounded and banded', () => {
  const worst = posture(decodeAccountFlags(0x00200000 | 0x00400000), { domain: null });
  const best = posture(
    decodeAccountFlags(0x00040000 | 0x00100000 | 0x80000000),
    { domain: 'ripple.com' }
  );
  assert.ok(worst.score >= 0 && worst.score <= 100);
  assert.ok(best.score >= 0 && best.score <= 100);
  assert.ok(best.score > worst.score, 'a controlled issuer must outscore an uncontrolled one');
  assert.equal(best.band, 'institutional');
});

t('every check carries evidence and a consequence', () => {
  const p = posture(decodeAccountFlags(0), { domain: null });
  for (const [id, c] of Object.entries(p.checks)) {
    assert.ok(c.evidence?.length > 10, `${id} needs evidence`);
    assert.ok(c.matters?.length > 10, `${id} needs a consequence`);
    assert.ok(c.anchor?.length > 5, `${id} needs a regulatory anchor`);
  }
});

t('disclaimer is always present', () => {
  assert.match(posture(decodeAccountFlags(0), {}).disclaimer, /not legal advice/i);
});

console.log('\ncurrency codes');
t('RLUSD hex round-trips', () => {
  const hex = '524C555344000000000000000000000000000000';
  assert.equal(decodeCurrency(hex), 'RLUSD');
  assert.equal(encodeCurrency('RLUSD'), hex);
});
t('three-char codes pass through untouched', () => {
  assert.equal(decodeCurrency('USD'), 'USD');
  assert.equal(encodeCurrency('USD'), 'USD');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
