/** GET /api/assay?asset=rlusd — full report for one tokenized asset. */
import { assay, ledgerHead, ISSUERS, looksLikeAddress } from '../src/index.mjs';
import { cached, remember, resolveTier, send, fail, provenance } from './_lib.js';

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  const url = new URL(req.url, 'http://x');
  const asset = url.searchParams.get('asset');
  const currency = url.searchParams.get('currency') || undefined;

  if (!asset) {
    return fail(res, 400, 'Missing "asset" parameter',
      `Pass a known id (${ISSUERS.map(i => i.id).join(', ')}) or any XRPL r-address.`);
  }
  const known = ISSUERS.some(i => i.id === asset.toLowerCase());
  if (!known && !looksLikeAddress(asset)) {
    return fail(res, 400, `"${asset}" is not a known issuer id or a valid XRPL address`,
      `Known ids: ${ISSUERS.map(i => i.id).join(', ')}`);
  }

  const tier = await resolveTier(req);
  const key = `assay:${asset}:${currency || '-'}:${tier.maxPages}`;

  const hit = cached(key);
  if (hit) return send(res, 200, { ...hit, cache: 'hit' }, { cacheSeconds: tier.cacheSeconds });

  try {
    const [report, ledger] = await Promise.all([
      assay(asset, { currency, maxPages: tier.maxPages }),
      ledgerHead().catch(() => null),
    ]);

    const body = {
      ...report,
      provenance: provenance(tier, ledger),
      ...(tier.keyRejected
        ? { warning: 'API key not recognised or subscription inactive; served on the free tier.' }
        : {}),
      ...(report.concentration && !report.concentration.complete
        ? { upgradeNote: `Holder coverage is capped at ${tier.maxPages} pages on the ${tier.name} tier. Higher tiers page deeper and tighten these bounds.` }
        : {}),
      cache: 'miss',
    };

    remember(key, body);
    return send(res, 200, body, { cacheSeconds: tier.cacheSeconds });
  } catch (e) {
    return fail(res, 502, `Assay failed: ${e.message}`,
      'Public XRPL endpoints throttle under load. Retry shortly.');
  }
}
