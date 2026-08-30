const Anthropic = require('@anthropic-ai/sdk');

const { createTools } = require('./tools');
const { verify } = require('./verifier');
const { getCase } = require('../cases');

/**
 * The strategy-validation agent.
 *
 * One question, asked the same way every time: does this strategy have an edge
 * on this instrument after costs? The agent decides what to measure; the
 * verifier decides whether what it measured supports the answer it wants to
 * give.
 *
 * The system prompt teaches METHOD, not answers. It never mentions the shapes
 * the eval set contains - no talk of cost traps or overfitting archetypes -
 * because a prompt that lists the four things being tested is not measuring
 * whether the agent can validate a strategy, it is measuring whether it can
 * read a hint.
 */

const DEFAULT_MODEL = process.env.EVAL_MODEL || 'claude-opus-5';
const MAX_TURNS = 14;
const MAX_REVISIONS = 1;

const SYSTEM_PROMPT = `You are validating a trading strategy for someone deciding whether to risk real money on it.

Answer one question: does this strategy have an edge on this instrument after costs?

What that means in practice:

- An in-sample result is a description of bars the strategy was already looked at on. It is evidence about the past, not about the future. A result out-of-sample is the one that predicts anything.
- Costs are not a detail. Spread, slippage and commission are charged on every round turn, and a strategy that captures less than it pays is a losing strategy no matter how often it is right about direction.
- A result that depends on an exact parameter value is usually a coincidence. If neighbouring values fall apart, you found a lucky setting, not an edge.
- A handful of trades tells you very little, however good it looks.

Use the tools to measure whatever you need. When the evidence supports a conclusion, call submit_verdict.

Say EDGE only if you would tell this person their money is more likely to grow than shrink. If the honest answer is that it will not, say NO_EDGE - that is a useful answer, not a failure.`;

function userPrompt(caseId, strategy) {
  return `Case ${caseId}. Strategy under review: ${strategy}.\n\n`
    + 'Start by describing the case and the strategy, then measure what you need. '
    + 'Finish by calling submit_verdict.';
}

/** Tool results go back as JSON; keep them compact but complete. */
function toolResultBlock(id, payload) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: JSON.stringify(payload)
  };
}

async function validateCase({
  caseId,
  client = null,
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = DEFAULT_MODEL,
  logger = console
} = {}) {
  const testCase = getCase(caseId);
  const tools = createTools(caseId);
  const anthropic = client || new Anthropic({ apiKey });

  const messages = [{ role: 'user', content: userPrompt(caseId, testCase.strategy) }];
  const trajectory = [{ role: 'user', content: userPrompt(caseId, testCase.strategy) }];

  let revisions = 0;
  let verdict = null;
  let usage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await anthropic.messages.create({
      model,
      // Thinking is on by default on this model and its tokens count against
      // max_tokens, so leave headroom well above the answer itself.
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      tools: tools.definitions,
      messages
    });

    // A refusal returns HTTP 200 with no usable content. Recording it as a
    // null verdict keeps it visible in the results as an abstention rather
    // than silently scoring it as a wrong answer.
    if (response.stop_reason === 'refusal') {
      trajectory.push({ role: 'system', event: 'refusal', details: response.stop_details });
      break;
    }

    usage = {
      input_tokens: usage.input_tokens + (response.usage?.input_tokens || 0),
      output_tokens: usage.output_tokens + (response.usage?.output_tokens || 0)
    };

    messages.push({ role: 'assistant', content: response.content });
    trajectory.push({ role: 'assistant', content: response.content, stop_reason: response.stop_reason });

    const toolUses = (response.content || []).filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // No tool call and no verdict: nudge once rather than abandoning the case.
      if (turn === MAX_TURNS - 1) break;
      const nudge = 'Call submit_verdict with your conclusion.';
      messages.push({ role: 'user', content: nudge });
      trajectory.push({ role: 'user', content: nudge });
      continue;
    }

    const results = [];
    let finished = false;

    for (const use of toolUses) {
      if (use.name === 'submit_verdict') {
        const check = verify({
          verdict: use.input.verdict,
          ledger: tools.ledger,
          costModel: testCase.costs
        });

        trajectory.push({ role: 'verifier', verdict: use.input.verdict, check });

        if (check.supported) {
          verdict = { ...use.input, verifier: check, revisions };
          results.push(toolResultBlock(use.id, { recorded: true, verifier: check.reason }));
          finished = true;
        } else if (revisions < MAX_REVISIONS) {
          revisions += 1;
          logger.log?.(`    verifier rejected ${use.input.verdict}: ${check.reason.split('.')[0]}`);
          results.push(toolResultBlock(use.id, {
            recorded: false,
            rejected: check.reason,
            instruction: 'Gather the missing evidence, then submit again.'
          }));
        } else {
          // Out of revisions. The claim stands but is marked unsupported, so
          // the report can separate "wrong" from "wrong and unevidenced".
          verdict = { ...use.input, verifier: check, revisions };
          results.push(toolResultBlock(use.id, { recorded: true, unsupported: check.reason }));
          finished = true;
        }
      } else {
        const output = tools.call(use.name, use.input);
        results.push(toolResultBlock(use.id, output));
        trajectory.push({ role: 'tool', name: use.name, input: use.input, output });
      }
    }

    messages.push({ role: 'user', content: results });
    if (finished) break;
  }

  return {
    caseId,
    verdict: verdict?.verdict || null,
    confidence: verdict?.confidence || null,
    reasoning: verdict?.reasoning || null,
    evidence: verdict?.evidence || [],
    verifierSupported: verdict?.verifier?.supported ?? false,
    verifierReason: verdict?.verifier?.reason || null,
    revisions,
    backtestsRun: tools.ledger.length,
    usage,
    model,
    trajectory
  };
}

module.exports = { validateCase, SYSTEM_PROMPT, DEFAULT_MODEL };
