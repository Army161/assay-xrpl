/**
 * POST /api/agent — natural-language analyst over live XRPL state.
 *
 * The agent is given TOOLS, not a data dump. That matters: it means every
 * factual claim in an answer traces to a call this file made against mainnet
 * in the last few seconds, rather than to the model's recollection of what
 * RLUSD's supply was during training. The system prompt forbids answering
 * ledger questions without a tool call for exactly that reason.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { assay, assayAll, ledgerHead, amendments, ISSUERS } from '../src/index.mjs';
import { resolveTier, send, fail, readBody } from './_lib.js';

export const config = { maxDuration: 300 };

const MODEL = 'claude-opus-5';
const MAX_QUESTION_CHARS = 2000;

const SYSTEM = `You are the Assay analyst: an expert on tokenized assets issued on the XRP Ledger.

You answer questions about issuers, token supply, holder concentration, and on-ledger
compliance posture, using ONLY data returned by your tools.

Rules you do not break:
- Never state a supply figure, holder count, concentration percentage, or flag state
  from memory. Call a tool. Ledger state changes every few seconds.
- Concentration figures are computed against authoritative issued supply and are LOWER
  BOUNDS when holder coverage is partial. If a report says coverage is partial, say so
  when you quote a concentration number. Do not round the caveat away.
- Compliance posture measures on-ledger CAPABILITY, not regulatory compliance. An issuer
  that can freeze is not thereby licensed or solvent. Never imply otherwise, and never
  present output as legal advice or certification.
- You cannot see reserves. Issued supply is what the ledger says was issued; whether it
  is backed is an off-chain question you have no visibility into. Say that plainly when
  asked about backing or solvency.
- If a tool fails or returns nothing, say so. Do not fill the gap with plausible numbers.

Be direct and quantitative. Lead with the finding, then the evidence. A risk analyst is
reading this and needs the number and its caveat, not a preamble.`;

/** Tools. Each wraps a function already unit-tested against mainnet. */
function buildTools(maxPages) {
  return [
    betaTool({
      name: 'assay_asset',
      description:
        'Full report for one tokenized asset: issued supply, holder concentration (top1/5/10, HHI), ' +
        'compliance posture with per-check evidence, top holders, and issuer account flags. ' +
        'Accepts a known issuer id or any XRPL r-address.',
      inputSchema: {
        type: 'object',
        properties: {
          asset: {
            type: 'string',
            description: `Issuer id (${ISSUERS.map(i => i.id).join(', ')}) or an XRPL r-address.`,
          },
          currency: {
            type: 'string',
            description: 'Optional currency symbol when the issuer issues several, e.g. "USD".',
          },
        },
        required: ['asset'],
        additionalProperties: false,
      },
      run: async ({ asset, currency }) => {
        try {
          const r = await assay(asset, { currency, maxPages });
          return JSON.stringify(r);
        } catch (e) {
          return `TOOL ERROR: ${e.message}`;
        }
      },
    }),

    betaTool({
      name: 'compare_assets',
      description:
        'Assay several assets at once and rank them by compliance posture, weakest first. ' +
        'Use for portfolio-level or comparative questions.',
      inputSchema: {
        type: 'object',
        properties: {
          assets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Issuer ids or r-addresses. Omit to use the full registry.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      run: async ({ assets }) => {
        try {
          const r = await assayAll(assets?.length ? assets : undefined, { maxPages: 4 });
          return JSON.stringify(r);
        } catch (e) {
          return `TOOL ERROR: ${e.message}`;
        }
      },
    }),

    betaTool({
      name: 'ledger_status',
      description:
        'Current validated ledger index and close time, plus which institutional amendments ' +
        '(Credentials, PermissionedDomains, MPTokensV1, Clawback, DeepFreeze, ...) are live on ' +
        'mainnet right now. Use to timestamp findings or to check whether a ledger feature exists.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      run: async () => {
        try {
          const [head, amd] = await Promise.all([ledgerHead(), amendments()]);
          return JSON.stringify({ ledger: head, ...amd });
        } catch (e) {
          return `TOOL ERROR: ${e.message}`;
        }
      },
    }),

    betaTool({
      name: 'list_known_issuers',
      description: 'The curated registry of verified issuers with their addresses and categories.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      run: async () => JSON.stringify(ISSUERS),
    }),
  ];
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.method !== 'POST') {
    return fail(res, 405, 'Method not allowed', 'POST { "question": "..." }');
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return fail(res, 503, 'The analyst is not configured on this deployment',
      'Set ANTHROPIC_API_KEY. Every other endpoint works without it.');
  }

  const tier = await resolveTier(req);
  if (tier.agentCalls === 0) {
    return fail(res, 402, 'The analyst is not included on the free tier',
      'Upgrade to Desk or above. All measurement endpoints remain free.');
  }

  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return fail(res, 400, 'Invalid JSON body'); }

  const question = String(body.question || '').trim();
  if (!question) return fail(res, 400, 'Missing "question"');
  if (question.length > MAX_QUESTION_CHARS) {
    return fail(res, 400, `Question too long (${question.length} chars, max ${MAX_QUESTION_CHARS})`);
  }

  const client = new Anthropic();

  try {
    const runner = client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      tools: buildTools(tier.maxPages),
      messages: [{ role: 'user', content: question }],
      max_iterations: 12,
    });

    // Track which tools ran so the response can show its work. An analyst
    // answer with no visible provenance is not auditable.
    const toolsUsed = [];
    for await (const message of runner) {
      for (const block of message.content || []) {
        if (block.type === 'tool_use') toolsUsed.push({ tool: block.name, input: block.input });
      }
      // The runner does not auto-resume a paused server-tool turn; without
      // this the answer silently truncates.
      if (message.stop_reason === 'pause_turn') {
        runner.pushMessages({ role: 'assistant', content: message.content });
      }
    }

    const final = await runner.done();

    if (final.stop_reason === 'refusal') {
      return fail(res, 422, 'The model declined to answer this request',
        final.stop_details?.explanation || 'No further detail provided.');
    }

    const answer = (final.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    return send(res, 200, {
      question,
      answer: answer || '(the analyst returned no text)',
      toolsUsed,
      model: MODEL,
      stopReason: final.stop_reason,
      usage: {
        inputTokens: final.usage?.input_tokens,
        outputTokens: final.usage?.output_tokens,
      },
      disclaimer:
        'Generated from live XRPL data by an AI analyst. On-ledger capability only — ' +
        'not investment, legal, or compliance advice. Verify before acting.',
    });
  } catch (e) {
    if (e?.status === 429) {
      return fail(res, 429, 'Analyst rate limit reached', 'Retry shortly.');
    }
    return fail(res, 502, `Analyst failed: ${e.message}`);
  }
}
