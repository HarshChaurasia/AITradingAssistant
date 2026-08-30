# Ground rules

The brief lists ten baseline requirements for every eligible project. Each is
answered below with the evidence a judge can check, not an assurance.

### 1. Build with tools and components you already know

Node 22, Express, MySQL, the MetaTrader 5 Python package, and the Anthropic
SDK. All standard, all used as intended.

### 2. Make clear what existed before the competition and what you added

**Everything in this repository was written during the competition window.**
The hackathon ran 28-31 August 2026; the first commit is `f4f3e7e`, *chore:
project scaffold*, at **2026-08-29 19:56**. Verify with:

    git log --format='%ad %s' --date=iso --reverse | head -1

Twenty-five commits, all inside the window. Nothing was carried in from an
earlier project.

Pre-existing components used as dependencies, not authored here: Node and its
standard library, Express, mysql2, the `MetaTrader5` Python package, the
Anthropic SDK, Vite and React. Listed in `package.json`, `server/package.json`
and `bridge/requirements.txt`.

### 3. Use every tool and component according to its license and service terms

All dependencies are used through their public interfaces at their published
versions. No scraping, no undocumented endpoints, no circumvention. The MT5
terminal is the broker's own installer, driven through the vendor's supported
Python API.

### 4. Keep consequential actions controlled through a sandbox or simulation, with human approval before the action happens

Placing an order is the consequential action here, and it is gated four
separate ways, **all off by default**:

| Flag | Effect while unset |
| --- | --- |
| `MT5_ALLOW_TRADING` | The bridge is read-only |
| `MT5_ALLOW_LIVE` | A real account is refused; demo only |
| `EXECUTION_ENABLED` | The scheduler never sends orders |
| `SCHEDULER_ENABLED` | No background loop runs at all |

Three rules are not configurable: every order carries a stop loss; a position
below the broker minimum is refused rather than rounded up; the kill switch
only ever resets by hand.

**The graded result touches none of this.** `npm run eval` runs against
generated price series. It never opens a broker connection, never reads a live
quote and cannot place an order - there is no code path from the eval to the
execution layer. The agent's output is a verdict, not a trade.

### 5. Make a qualified human reviewer part of any solution that could significantly affect someone

The agent **advises; it never acts.** Its output is `EDGE` or `NO_EDGE` with
its evidence, for a person deciding what to do next. Downstream, promotion of a
strategy from draft to backtested to demo to live is a deliberate human act -
`registerStrategies()` in `server/src/strategies/registry.js` explicitly does
not update status on restart - and live signals land in an approval queue
rather than an order.

The person affected is the operator themselves, reviewing their own strategy on
their own account.

### 6. Choose a legal and ethical use case that treats people and their data responsibly

Personal trading tooling, operated by its author on their own demo account. No
third party's data is processed, no advice is given to anyone else, no funds
but the operator's are at risk, and the system is designed to make the honest
answer - "this strategy loses money" - the easy one to reach.

### 7. Use information you are allowed to share

**The entire graded eval set is synthetic**, generated from fixed integer seeds
by `eval/lib/generators.js`. No market data, no broker data, no third-party
data, nothing licensed. Any machine reproduces the identical series from the
seeds in `eval/case-seeds.json`.

The live system reads the operator's own broker feed, which is not part of the
submission and is not required to reproduce any result.

### 8. Keep credentials and private information outside the submission

`.env` and `server/.env` are gitignored and were never committed. Verify:

    git ls-files | grep -i env
    # .env.example
    # server/.env.example

Both example files ship with empty values. `bridge/offset.json`, runtime cache
rather than source, is untracked and regenerates itself.

### 9. Connect every claim about your results to the evidence you submit

Every figure in `IMPROVEMENT-CHANGELOG.md` came from a command in this repo,
named alongside it. Results are written by the runner to
`eval/results/latest.md` and `latest.json`, not transcribed by hand. The
evaluation method and its success bar were committed **before** the comparison
ran - see [EVALUATION.md](EVALUATION.md) and its git timestamp. Where a result
is not yet measured, the changelog says so rather than estimating.

### 10. Give judges enough access to run the project and reproduce the main result

[REPRODUCTION.md](REPRODUCTION.md) is written for a clean machine. The main
result needs Node 22 and one Anthropic API key - **no broker account, no
MetaTrader terminal, no database**. Two of the three verification commands
(`npm run eval:test`, `npm run eval:cases`) need no key and no network at all.
