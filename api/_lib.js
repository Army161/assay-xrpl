/**
 * Shared API plumbing: caching, tiering, responses.
 *
 * A full assay makes 10–25 sequential paginated RPC calls against public XRPL
 * infrastructure. Caching is not an optimisation here — it is what keeps us
 * from being throttled into uselessness and what makes a free tier viable.
 */
import { tierForApiKey } from './_stripe.js';

const memo = new Map();
const MEMO_TTL_MS = 4 * 60 * 1000;

export function cached(key) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value;
  memo.delete(key);
  return null;
}

export function remember(key, value) {
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 60) memo.delete(memo.keys().next().value);
  return value;
}

/**
 * Tiers gate DEPTH, not access.
 *
 * `maxPages` is the real product lever: holder coverage. Free gets a usable
 * sample; paid tiers page deeper and therefore tighten the lower bound on
 * concentration. Every tier gets the same methodology and the same honest
 * caveat — we never sell a more flattering number, only a more complete one.
 */
export const TIERS = {
  free:    { maxPages: 5,  cacheSeconds: 600, watchlist: 3,   agentCalls: 0 },
  desk:    { maxPages: 25, cacheSeconds: 180, watchlist: 25,  agentCalls: 200 },
  firm:    { maxPages: 60, cacheSeconds: 60,  watchlist: 200, agentCalls: 2000 },
  enterprise: { maxPages: 200, cacheSeconds: 0, watchlist: Infinity, agentCalls: Infinity },
};

export async function resolveTier(req) {
  const key = req.headers['x-api-key']
    || new URL(req.url, 'http://x').searchParams.get('key');
  if (!key) return { name: 'free', ...TIERS.free };

  const staticTable = Object.fromEntries(
    (process.env.ASSAY_KEYS || '').split(',').filter(Boolean).map(p => p.split(':'))
  );
  const staticTier = staticTable[key];
  if (staticTier && TIERS[staticTier]) {
    return { name: staticTier, ...TIERS[staticTier], source: 'static' };
  }

  const memoKey = `tier:${key}`;
  const hit = cached(memoKey);
  if (hit) return hit;

  const stripeTier = await tierForApiKey(key);
  if (stripeTier && TIERS[stripeTier]) {
    return remember(memoKey, { name: stripeTier, ...TIERS[stripeTier], source: 'stripe' });
  }

  // Unknown or lapsed key degrades to free with a warning rather than 401.
  // A risk dashboard going blank mid-review is worse than one that says
  // plainly that it is showing you less than you paid for.
  return { name: 'free', ...TIERS.free, keyRejected: true };
}

export function send(res, status, body, { cacheSeconds = 0 } = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, content-type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0
      ? `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`
      : 'no-store'
  );
  res.status(status).end(JSON.stringify(body, null, 2));
}

export function fail(res, status, message, hint) {
  send(res, status, { error: message, ...(hint ? { hint } : {}) });
}

export function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

/** Standard provenance block. Every number we publish must be traceable. */
export const provenance = (tier, ledger) => ({
  source: 'XRP Ledger mainnet, public RPC (xrplcluster.com / s1-s2.ripple.com)',
  ledgerIndex: ledger?.index ?? null,
  ledgerClosedAt: ledger?.closedAt ?? null,
  tier: tier.name,
  holderPageCeiling: tier.maxPages,
});
