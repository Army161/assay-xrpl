/**
 * Assay — public API.
 *
 * Assays a tokenized asset on the XRP Ledger: who holds it, how concentrated
 * that holding is, and what issuer controls exist on-ledger.
 */
import { analyse, supply, account, holders, institutionalPrimitives } from './xrpl/issuer.mjs';
import { ISSUERS, resolve, byId, looksLikeAddress } from './xrpl/registry.mjs';
import { concentration, gini } from './scoring/concentration.mjs';
import { posture, POSTURE_BANDS } from './scoring/posture.mjs';
import { rpc, pool, decodeCurrency, rippleTimeToIso } from './xrpl/client.mjs';

export {
  analyse, supply, account, holders, institutionalPrimitives,
  ISSUERS, resolve, byId, looksLikeAddress,
  concentration, gini, posture, POSTURE_BANDS,
  rpc, decodeCurrency, rippleTimeToIso,
};

export const VERSION = '0.1.0';

/**
 * Assay one asset by registry id or raw address.
 * Throws a plain Error with an actionable message on a bad identifier —
 * callers turn that into a 400, not a 500.
 */
export async function assay(identifier, opts = {}) {
  const target = resolve(identifier);
  if (!target) {
    throw new Error(
      `"${identifier}" is neither a known issuer id (${ISSUERS.map(i => i.id).join(', ')}) ` +
      `nor a valid XRPL r-address.`
    );
  }
  const report = await analyse(target.account, opts);
  return { ...report, registry: target.meta || null };
}

/**
 * Assay several assets concurrently. Individual failures are captured per
 * asset rather than failing the batch — a dashboard should render the rows it
 * can get, and say plainly which ones it could not.
 */
export async function assayAll(identifiers = ISSUERS.map(i => i.id), opts = {}) {
  const results = await pool(identifiers, 3, id =>
    assay(id, opts).catch(e => ({ identifier: id, error: String(e.message || e) }))
  );
  return { observedAt: new Date().toISOString(), assets: results };
}

/** Current validated ledger — proves liveness and timestamps every report. */
export async function ledgerHead() {
  const r = await rpc('ledger', { ledger_index: 'validated', transactions: false });
  return {
    index: Number(r?.ledger?.ledger_index),
    closedAt: r?.ledger?.close_time_human || null,
    hash: r?.ledger?.ledger_hash || null,
  };
}

/**
 * Which institutional amendments are live on mainnet.
 * Read from the network, never hardcoded — several of these flipped from
 * inactive to enabled during this project, and a stale hardcoded list would
 * have quietly told customers a feature was unavailable when it was not.
 */
const TRACKED_AMENDMENTS = [
  'Credentials', 'PermissionedDomains', 'PermissionedDEX', 'MPTokensV1',
  'DeepFreeze', 'Clawback', 'TokenEscrow', 'AMM', 'Batch', 'PermissionDelegation',
];

export async function amendments() {
  const r = await rpc('feature', {});
  const feats = Object.values(r?.features || {});
  const status = {};
  for (const name of TRACKED_AMENDMENTS) {
    const f = feats.find(x => x.name === name);
    status[name] = f ? { enabled: Boolean(f.enabled), supported: Boolean(f.supported) }
                     : { enabled: false, supported: false, note: 'not present on this server' };
  }
  return { observedAt: new Date().toISOString(), amendments: status };
}
