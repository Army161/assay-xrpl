/** GET /api/portfolio — every registry asset, ranked by risk. */
import { assayAll, ledgerHead, ISSUERS } from '../src/index.mjs';
import { cached, remember, resolveTier, send, fail, provenance } from './_lib.js';

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  const tier = await resolveTier(req);
  const url = new URL(req.url, 'http://x');

  const requested = (url.searchParams.get('assets') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const ids = requested.length ? requested : ISSUERS.map(i => i.id);

  if (ids.length > tier.watchlist) {
    return fail(res, 402, `Watchlist limit reached: ${ids.length} requested, ${tier.watchlist} allowed on the ${tier.name} tier`,
      'Upgrade for a larger watchlist.');
  }

  // Portfolio view pages shallower than a single assay on purpose: N assets in
  // one request would otherwise blow the function's wall-clock budget. The
  // per-asset endpoint is the place to go deep.
  const pages = Math.max(2, Math.min(tier.maxPages, 6));
  const key = `portfolio:${ids.join(',')}:${pages}`;

  const hit = cached(key);
  if (hit) return send(res, 200, { ...hit, cache: 'hit' }, { cacheSeconds: tier.cacheSeconds });

  try {
    const [out, ledger] = await Promise.all([
      assayAll(ids, { maxPages: pages }),
      ledgerHead().catch(() => null),
    ]);

    const ok = out.assets.filter(a => !a.error);
    const failed = out.assets.filter(a => a.error);

    // Rank by weakest posture first — a risk dashboard should open on the
    // thing most likely to need attention, not alphabetically.
    const ranked = [...ok].sort(
      (a, b) => (a.posture?.score ?? 999) - (b.posture?.score ?? 999)
    );

    const body = {
      observedAt: out.observedAt,
      provenance: { ...provenance(tier, ledger), holderPageCeiling: pages },
      summary: {
        assetsAssayed: ok.length,
        assetsFailed: failed.length,
        totalIssuedByCurrency: totals(ok),
        weakestPosture: ranked[0]
          ? { asset: ranked[0].asset?.currency, score: ranked[0].posture?.score, band: ranked[0].posture?.band }
          : null,
        activeGlobalFreezes: ok.filter(a => a.posture?.emergency).map(a => a.asset?.currency),
      },
      assets: ranked,
      failures: failed,
      note: 'Portfolio view pages holders shallowly for speed. Use /api/assay?asset=<id> for full depth on one asset.',
      cache: 'miss',
    };

    remember(key, body);
    return send(res, 200, body, { cacheSeconds: tier.cacheSeconds });
  } catch (e) {
    return fail(res, 502, `Portfolio assay failed: ${e.message}`);
  }
}

function totals(assets) {
  const t = {};
  for (const a of assets) {
    for (const s of a.supplies || []) {
      t[s.currency] = +((t[s.currency] || 0) + s.issued).toFixed(2);
    }
  }
  return t;
}
