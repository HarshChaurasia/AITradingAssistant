const { publicCase, getCase, COSTS } = require('../cases');
const { backtestCase, loadStrategy } = require('../lib/backtest');

/**
 * The agent's instrument panel.
 *
 * Every tool is a thin wrapper over the same backtest engine the live system
 * trades on, so the agent's evidence and the operator's evidence are the same
 * artefact. None of these tools can reach the ground-truth label - the agent
 * has to earn its verdict from measurements, exactly as a person would.
 *
 * The ledger is not a debugging aid. It is the record the verifier reads to
 * decide whether a verdict is supported by evidence the agent actually
 * gathered, rather than by an assertion it found convincing.
 */

const MAX_SWEEP_VALUES = 8;

const DEFINITIONS = [
  {
    name: 'describe_case',
    description:
      'Metadata for the case under review: the strategy, the instrument, how '
      + 'many bars exist, where the in-sample and out-of-sample windows sit, '
      + 'and the exact cost model that will be charged.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'describe_strategy',
    description:
      'The strategy\'s entry rules in plain terms, its tunable parameters and '
      + 'their default values.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'run_backtest',
    description:
      'Replay the strategy bar by bar and return performance metrics. Fills '
      + 'happen at the next bar\'s open; when one bar spans both the stop and '
      + 'the target, the stop is assumed to hit first.',
    input_schema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          enum: ['in_sample', 'out_of_sample', 'full'],
          description: 'Which bars may generate signals.'
        },
        costModel: {
          type: 'string',
          enum: ['realistic', 'wide', 'zero'],
          description:
            "Defaults to the case's own model. 'zero' charges no spread, "
            + 'slippage or commission, which answers whether a result survives '
            + 'being paid for.'
        },
        params: {
          type: 'object',
          description: 'Parameter overrides. Omitted parameters keep their defaults.'
        }
      },
      required: ['window']
    }
  },
  {
    name: 'sweep_parameter',
    description:
      'Run the same backtest across several values of one parameter and return '
      + 'a metric for each. Useful for seeing how sensitive a result is to the '
      + 'exact setting it was measured at.',
    input_schema: {
      type: 'object',
      properties: {
        param: { type: 'string', description: 'Parameter name to vary.' },
        values: {
          type: 'array',
          items: { type: 'number' },
          description: `Values to try (at most ${MAX_SWEEP_VALUES}).`
        },
        window: { type: 'string', enum: ['in_sample', 'out_of_sample', 'full'] },
        costModel: { type: 'string', enum: ['realistic', 'wide', 'zero'] }
      },
      required: ['param', 'values', 'window']
    }
  },
  {
    name: 'submit_verdict',
    description:
      'Record the final answer. Submit this once, when the evidence supports a '
      + 'conclusion.',
    input_schema: {
      type: 'object',
      properties: {
        verdict: {
          type: 'string',
          enum: ['EDGE', 'NO_EDGE'],
          description:
            'EDGE means the strategy is expected to make money on this '
            + 'instrument after costs. NO_EDGE means it is not.'
        },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        reasoning: {
          type: 'string',
          description: 'Why the measurements support this verdict, in a few sentences.'
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'The specific measurements the verdict rests on.'
        }
      },
      required: ['verdict', 'confidence', 'reasoning', 'evidence']
    }
  }
];

/** Human-readable entry rules, so the agent is not reasoning about a name. */
const STRATEGY_NOTES = {
  'trend-breakout':
    'Long when price closes above the prior N-bar high while the fast EMA is '
    + 'above the slow EMA; short on the mirror image. Stop and target are ATR '
    + 'multiples.',
  'mean-reversion':
    'Long when RSI is oversold while price holds above the long trend EMA; '
    + 'short on the mirror image. Stop and target are ATR multiples.',
  'macd-trend': 'MACD signal-line crossings filtered by a trend EMA.',
  'bollinger-squeeze': 'Breakout from a low-volatility Bollinger band squeeze.',
  supertrend: 'Entries on SuperTrend direction flips.',
  'ma-crossover': 'Classic fast/slow EMA crossover. A deliberate control.'
};

function createTools(caseId) {
  const testCase = getCase(caseId);
  const ledger = [];

  function record(entry) {
    ledger.push(entry);
    return entry;
  }

  const handlers = {
    describe_case: () => ({
      ...publicCase(caseId),
      note:
        'The cost model above is what a broker would charge. A result measured '
        + 'without it is not a result you can trade.'
    }),

    describe_strategy: () => {
      const strategy = loadStrategy(testCase.strategy);
      return {
        name: strategy.name,
        rules: STRATEGY_NOTES[strategy.name] || 'See defaultParams.',
        defaultParams: strategy.defaultParams
      };
    },

    run_backtest: ({ window, costModel = null, params = {} }) => {
      const result = backtestCase({ caseId, window, costModel, params });
      return record(result);
    },

    sweep_parameter: ({ param, values, window, costModel = null }) => {
      if (!Array.isArray(values) || values.length === 0) {
        return { error: 'values must be a non-empty array' };
      }
      const capped = values.slice(0, MAX_SWEEP_VALUES);
      return {
        param,
        window,
        costModel: costModel || testCase.costs,
        results: capped.map((value) => {
          const result = backtestCase({
            caseId, window, costModel, params: { [param]: value }
          });
          record(result);
          return {
            value,
            trades: result.trades,
            returnPct: result.returnPct,
            profitFactor: result.profitFactor,
            maxDrawdownPct: result.maxDrawdownPct
          };
        })
      };
    }
  };

  function call(name, input) {
    if (name === 'submit_verdict') return { recorded: true };
    const handler = handlers[name];
    if (!handler) return { error: `unknown tool: ${name}` };
    try {
      return handler(input || {});
    } catch (error) {
      return { error: error.message };
    }
  }

  return { definitions: DEFINITIONS, call, ledger, costs: COSTS[testCase.costs] };
}

module.exports = { createTools, DEFINITIONS, STRATEGY_NOTES };
