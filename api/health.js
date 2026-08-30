/** GET /api/health — liveness plus an honest capability list. */
import { ISSUERS, VERSION, ledgerHead, amendments } from '../src/index.mjs';
import { send, TIERS } from './_lib.js';
import { stripeConfigured, priceForTier } from './_stripe.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  // Ledger reachability is the real health signal — the service is only as up
  // as its data source. A 200 while mainnet is unreachable would be a lie.
  const [ledger, amd] = await Promise.all([
    ledgerHead().catch(e => ({ error: e.message })),
    amendments().catch(e => ({ error: e.message })),
  ]);

  send(res, 200, {
    ok: !ledger?.error,
    service: 'assay',
    version: VERSION,
    ledger,
    endpoints: {
      'GET  /api/assay?asset=<id|r-address>': 'Full report for one tokenized asset',
      'GET  /api/portfolio': 'Every registry asset, ranked weakest-posture-first',
      'GET  /api/amendments': 'Which institutional amendments are live on mainnet',
      'POST /api/agent': 'Natural-language analyst over live ledger state',
      'GET  /api/health': 'This',
    },
    registry: ISSUERS.map(i => ({ id: i.id, name: i.name, category: i.category })),
    tiers: Object.fromEntries(
      Object.entries(TIERS).map(([k, v]) => [k, {
        holderPages: v.maxPages === Infinity ? 'unlimited' : v.maxPages,
        cacheSeconds: v.cacheSeconds,
        watchlist: v.watchlist === Infinity ? 'unlimited' : v.watchlist,
        analyst: v.agentCalls > 0,
      }])
    ),
    billing: {
      configured: stripeConfigured() && Boolean(priceForTier('desk')),
    },
    analyst: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      note: 'Every measurement endpoint works without the analyst.',
    },
    institutionalAmendments: amd?.amendments ?? null,
    caveats: [
      'Concentration is computed against authoritative issued supply. When holder coverage ' +
      'is partial the figures are LOWER BOUNDS, and every response says so explicitly.',
      'Compliance posture measures on-ledger capability only. It is not a compliance ' +
      'certification, a reserve attestation, or legal advice.',
      'Reserve backing is an off-chain fact. Nothing here can verify it.',
    ],
  }, { cacheSeconds: 30 });
}
