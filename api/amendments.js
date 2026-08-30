/**
 * GET /api/amendments — which institutional ledger features are live.
 *
 * Worth its own endpoint: several of these flipped from inactive to enabled
 * during this project. Any product that hardcodes the list eventually tells
 * customers a feature is unavailable when it has been live for months.
 */
import { amendments, ledgerHead } from '../src/index.mjs';
import { send, fail } from './_lib.js';

export const config = { maxDuration: 30 };

const CONTEXT = {
  Credentials: 'XLS-70. On-ledger attestations (KYC, accreditation) issued by a trusted party.',
  PermissionedDomains: 'XLS-80. Gates who may hold or trade an asset by required credentials.',
  PermissionedDEX: 'Order books restricted to members of a permissioned domain.',
  MPTokensV1: 'Multi-Purpose Tokens — the fixed-supply primitive for tokenized RWAs.',
  DeepFreeze: 'Freeze that also blocks the holder from sending to the issuer.',
  Clawback: 'Issuer recovery of issued tokens. Must be enabled before first issuance.',
  TokenEscrow: 'Escrow for issued tokens, not just XRP.',
  AMM: 'Native automated market maker.',
  Batch: 'Atomic multi-transaction submission.',
  PermissionDelegation: 'Delegated account permissions to another account.',
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');

  try {
    const [amd, ledger] = await Promise.all([amendments(), ledgerHead().catch(() => null)]);
    const enriched = Object.fromEntries(
      Object.entries(amd.amendments).map(([name, s]) => [
        name, { ...s, whatItEnables: CONTEXT[name] || null },
      ])
    );
    const live = Object.entries(enriched).filter(([, v]) => v.enabled).map(([k]) => k);

    return send(res, 200, {
      observedAt: amd.observedAt,
      ledger,
      liveCount: live.length,
      live,
      amendments: enriched,
      note: 'Read from the network at request time, never hardcoded.',
    }, { cacheSeconds: 300 });
  } catch (e) {
    return fail(res, 502, `Could not read amendments: ${e.message}`);
  }
}
