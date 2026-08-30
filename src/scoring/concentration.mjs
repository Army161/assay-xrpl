/**
 * Holder concentration — the headline risk metric for any tokenized asset.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID
 * ------------------------------------
 * A large issuer has more trustlines than a serverless function can page
 * through. The naive implementation sums the balances it managed to fetch and
 * divides each holder by that sum. On a live probe of RLUSD that produced
 * "top holder = 70.96% of supply". The true figure was ~4.9%, because the
 * sample covered 72M of 1,041M issued. The naive version overstated
 * concentration by 14x and would have been read as a solvency alarm.
 *
 * So: concentration is ALWAYS computed against `totalSupply`, taken from the
 * issuer's authoritative `gateway_balances` obligations — never against the
 * sum of whatever we happened to page through. When coverage is partial we
 * say so, and we report what the unseen remainder could at most contain.
 */

/**
 * @param {number[]} balances  holder balances (any order, zeros tolerated)
 * @param {number}   totalSupply  authoritative issued supply
 * @param {object}   coverage  { complete, holdersSeen, pagesFetched }
 */
export function concentration(balances, totalSupply, coverage = {}) {
  const held = balances.filter(b => Number.isFinite(b) && b > 0).sort((a, b) => b - a);

  if (!held.length || !Number.isFinite(totalSupply) || totalSupply <= 0) {
    return {
      measurable: false,
      reason: !held.length ? 'no non-zero holders observed' : 'issued supply unknown',
    };
  }

  const observed = held.reduce((a, b) => a + b, 0);
  const coveragePct = +(observed / totalSupply * 100).toFixed(2);
  // Supply we did not see. It sits with holders we never paged to, so every
  // concentration figure below is a floor, not a point estimate.
  const unobserved = Math.max(0, totalSupply - observed);

  const topShare = n => +(held.slice(0, n).reduce((a, b) => a + b, 0) / totalSupply * 100).toFixed(3);

  // Herfindahl-Hirschman Index over the full supply. Unobserved supply is
  // treated as perfectly dispersed, which is the assumption most favourable to
  // the issuer — we would rather understate risk than manufacture an alarm.
  const hhi = Math.round(held.reduce((acc, b) => acc + (b / totalSupply * 100) ** 2, 0));

  return {
    measurable: true,
    totalSupply,
    observedSupply: +observed.toFixed(6),
    coveragePct,
    complete: Boolean(coverage.complete),
    holdersObserved: held.length,
    pagesFetched: coverage.pagesFetched ?? null,

    top1Pct: topShare(1),
    top5Pct: topShare(5),
    top10Pct: topShare(10),
    top50Pct: topShare(50),
    largestHolding: held[0],

    hhi,
    hhiBand: hhiBand(hhi),

    // What the figures above cannot rule out.
    unobservedSupply: +unobserved.toFixed(6),
    unobservedPct: +(unobserved / totalSupply * 100).toFixed(2),

    caveat: coverage.complete
      ? null
      : `Holder set is partial: ${coveragePct}% of issued supply observed across ` +
        `${coverage.pagesFetched ?? '?'} pages. Concentration figures are lower bounds — ` +
        `an unpaged holder could hold up to ${(unobserved / totalSupply * 100).toFixed(2)}% more.`,
  };
}

/**
 * HHI bands. Borrowed from the US DOJ/FTC merger guidelines, where the same
 * index measures market concentration, and stated as such so nobody thinks we
 * invented thresholds to make a chart look decisive.
 */
function hhiBand(hhi) {
  if (hhi >= 2500) return { band: 'highly-concentrated', note: 'HHI ≥ 2500 (DOJ/FTC "highly concentrated" threshold).' };
  if (hhi >= 1500) return { band: 'moderately-concentrated', note: 'HHI 1500–2499 (DOJ/FTC "moderately concentrated").' };
  if (hhi > 0)     return { band: 'dispersed', note: 'HHI < 1500 (DOJ/FTC "unconcentrated").' };
  return { band: 'unknown', note: 'Insufficient data.' };
}

/**
 * Gini coefficient over observed holders. 0 = perfectly equal, 1 = one holder
 * has everything. Deliberately scoped to the OBSERVED set and labelled that
 * way: unlike the share figures there is no honest way to extrapolate a Gini
 * across holders we never saw.
 */
export function gini(balances) {
  const x = balances.filter(b => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  const n = x.length;
  if (n < 2) return null;
  const sum = x.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * x[i];
  return +(((2 * weighted) / (n * sum)) - (n + 1) / n).toFixed(4);
}
