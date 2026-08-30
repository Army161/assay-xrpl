/**
 * Compliance posture — what an issuer's on-chain configuration says about
 * whether it *could* meet its regulatory obligations.
 *
 * SCOPE, STATED UP FRONT
 * ----------------------
 * This measures CAPABILITY, not COMPLIANCE. We can see that an issuer retained
 * the ability to freeze a trustline; we cannot see whether it has a policy for
 * using that ability, an authorisation from a regulator, or reserves backing
 * the token. Nothing here is legal advice or a certification, and the output
 * says so on every response. An issuer scoring 100 can still be breaking the
 * law; an issuer scoring 40 may be perfectly licensed with off-chain controls.
 *
 * What it is good for: a fast, evidence-linked first pass that tells a
 * diligence or risk team where to point their questions.
 *
 * Regulatory anchors are cited per-check so a reviewer can audit our reasoning
 * rather than trust a number.
 */

/**
 * Each check returns { pass, weight, evidence, matters }.
 * `matters` explains the consequence, because "lsfNoFreeze: true" means
 * nothing to a compliance officer without it.
 */
const CHECKS = {
  /**
   * Asset freezing is the single most commonly mandated issuer power.
   * An issuer that has permanently renounced freeze (lsfNoFreeze) cannot honour
   * a sanctions designation or a court order against a specific holder.
   * That is a deliberate, irreversible choice on XRPL.
   */
  freezeCapability: {
    weight: 0.28,
    label: 'Freeze capability retained',
    anchor: 'MiCA Art. 34 (governance/risk); EU/OFAC sanctions require asset immobilisation.',
    evaluate: f => ({
      pass: !f.lsfNoFreeze,
      evidence: f.lsfNoFreeze
        ? 'lsfNoFreeze is set — freeze has been permanently renounced and cannot be restored.'
        : 'Issuer retains the ability to freeze individual trustlines.',
      matters: f.lsfNoFreeze
        ? 'Cannot immobilise a sanctioned or court-ordered holder on-ledger.'
        : 'Can immobilise a specific holder if legally compelled.',
    }),
  },

  /**
   * Clawback lets an issuer recover tokens sent in error or to an illicit
   * party. Required in practice for many regulated/tokenised securities.
   * Must be enabled BEFORE any token is issued — it cannot be added later.
   */
  clawbackCapability: {
    weight: 0.18,
    label: 'Clawback enabled',
    anchor: 'Common requirement for regulated securities and error-recovery obligations.',
    evaluate: f => ({
      pass: f.lsfAllowTrustLineClawback,
      evidence: f.lsfAllowTrustLineClawback
        ? 'lsfAllowTrustLineClawback is set.'
        : 'Clawback not enabled. On XRPL this is irreversible once tokens are issued.',
      matters: f.lsfAllowTrustLineClawback
        ? 'Issuer can recover misdirected or illicitly held tokens.'
        : 'No on-ledger route to recover tokens; recovery depends entirely on off-chain process.',
    }),
  },

  /**
   * RequireAuth means holders must be individually approved before they can
   * hold the asset — a permissioned holder base. This is how a KYC'd
   * distribution is enforced at the ledger level.
   */
  holderAuthorisation: {
    weight: 0.20,
    label: 'Holder authorisation required',
    anchor: 'TFR/Travel Rule and MiCA CASP obligations presume a known counterparty.',
    evaluate: f => ({
      pass: f.lsfRequireAuth,
      evidence: f.lsfRequireAuth
        ? 'lsfRequireAuth is set — trustlines require issuer approval.'
        : 'Any account may open a trustline without issuer approval.',
      matters: f.lsfRequireAuth
        ? 'Holder base is permissioned; issuer approves each counterparty.'
        : 'Holder base is open; issuer cannot restrict who acquires the asset on-ledger.',
    }),
  },

  /**
   * A published, verifiable domain ties the ledger account to a real-world
   * legal entity. Without it, an address is anonymous and no counterparty can
   * confirm who issued what they are holding.
   */
  identityDisclosure: {
    weight: 0.14,
    label: 'Issuer identity published',
    anchor: 'MiCA white-paper/disclosure obligations; basic counterparty diligence.',
    evaluate: (f, ctx) => ({
      pass: Boolean(ctx.domain),
      evidence: ctx.domain
        ? `Domain field set to ${ctx.domain}`
        : 'No Domain field set on the issuing account.',
      matters: ctx.domain
        ? 'Ledger account is publicly linked to a named domain.'
        : 'No on-ledger link between this issuer and any legal entity.',
    }),
  },

  /**
   * Master key disabled means the account is controlled by a regain-able
   * signer set / multisig rather than a single key. This is the difference
   * between an institutional custody arrangement and one person's laptop.
   */
  keyGovernance: {
    weight: 0.12,
    label: 'Master key disabled (delegated signing)',
    anchor: 'Operational-resilience expectations under MiCA Art. 34.',
    evaluate: f => ({
      pass: f.lsfDisableMaster,
      evidence: f.lsfDisableMaster
        ? 'Master key disabled — account is under a configured signer set.'
        : 'Master key is active; a single key can move issuer funds.',
      matters: f.lsfDisableMaster
        ? 'Consistent with multisig or delegated institutional custody.'
        : 'Single-key compromise would be sufficient to control the issuer.',
    }),
  },

  /**
   * Global freeze is an EMERGENCY state, not a healthy configuration. It halts
   * every holder at once. Present here inverted: its absence is the pass.
   */
  notInEmergencyFreeze: {
    weight: 0.08,
    label: 'Not under global freeze',
    anchor: 'Operational status signal.',
    evaluate: f => ({
      pass: !f.lsfGlobalFreeze,
      evidence: f.lsfGlobalFreeze
        ? 'lsfGlobalFreeze is ACTIVE — all holders of this asset are frozen.'
        : 'No global freeze in effect.',
      matters: f.lsfGlobalFreeze
        ? 'The asset is currently immobilised network-wide. Treat as a live incident.'
        : 'Asset is transferable under normal conditions.',
    }),
  },
};

/**
 * @param {object} flags   decoded account flags
 * @param {object} ctx     { domain, hasCredentials, hasPermissionedDomain }
 */
export function posture(flags, ctx = {}) {
  const checks = {};
  let earned = 0;
  let possible = 0;

  for (const [id, spec] of Object.entries(CHECKS)) {
    const r = spec.evaluate(flags, ctx);
    checks[id] = {
      label: spec.label,
      pass: r.pass,
      weight: spec.weight,
      evidence: r.evidence,
      matters: r.matters,
      anchor: spec.anchor,
    };
    possible += spec.weight;
    if (r.pass) earned += spec.weight;
  }

  const score = Math.round((earned / possible) * 100);

  // A live global freeze dominates everything else. Surfacing it as a normal
  // failed check inside an otherwise decent score would bury an active incident.
  const emergency = flags.lsfGlobalFreeze
    ? 'GLOBAL FREEZE ACTIVE — every holder of this asset is currently immobilised.'
    : null;

  return {
    score,
    band: band(score),
    emergency,
    checks,
    institutionalPrimitives: {
      credentials: ctx.hasCredentials ?? null,
      permissionedDomain: ctx.hasPermissionedDomain ?? null,
      note: 'XLS-70 Credentials and XLS-80 Permissioned Domains are the ledger-native ' +
            'route to a KYC-gated holder base. Both are enabled on mainnet.',
    },
    disclaimer:
      'Measures on-ledger CAPABILITY, not regulatory compliance. Does not assess reserves, ' +
      'licensing, or off-chain controls. Not legal advice and not a certification.',
  };
}

function band(score) {
  if (score >= 80) return 'institutional';
  if (score >= 55) return 'partial';
  if (score >= 30) return 'permissive';
  return 'unrestricted';
}

export const POSTURE_BANDS = {
  institutional: 'Configured with the controls a regulated issuer is typically expected to hold.',
  partial: 'Some issuer controls present; notable gaps against a regulated profile.',
  permissive: 'Few issuer controls. Workable for a permissionless asset, weak for a regulated one.',
  unrestricted: 'Effectively no on-ledger issuer controls. Cannot freeze, claw back, or gate holders.',
};
