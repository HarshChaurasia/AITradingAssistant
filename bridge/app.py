"""Read-only MT5 bridge.

Transport and serialisation only - no trading logic lives here.
Binds to 127.0.0.1 and requires the X-Bridge-Token header on every route.

Phase 1 is read-only: no order placement endpoints exist yet by design.
"""

import json
import os
import time
from functools import wraps

import MetaTrader5 as mt5
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "server", ".env"))

app = Flask(__name__)

BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "")

TIMEFRAMES = {
    "M1": mt5.TIMEFRAME_M1,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1,
}


def require_token(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not BRIDGE_TOKEN:
            return jsonify(error="BRIDGE_TOKEN is not configured on the bridge"), 500
        if request.headers.get("X-Bridge-Token") != BRIDGE_TOKEN:
            return jsonify(error="unauthorized"), 401
        return fn(*args, **kwargs)

    return wrapper


# MetaTrader5 holds the Python GIL for the whole of a blocking initialize():
# a failed connect freezes the entire process for ~65 seconds, and a background
# thread cannot work around it (measured - a 1Hz heartbeat thread recorded zero
# ticks during the call). So the connection is attempted once, at startup,
# before the server accepts requests. Handlers only ever read the cached state,
# which keeps every route fast whether or not MT5 is reachable.
_state = {"connected": False, "message": "not attempted"}


def connect():
    """Attempt to attach to the terminal. Blocks. Never call from a handler."""
    login = os.getenv("MT5_LOGIN")
    password = os.getenv("MT5_PASSWORD")
    server = os.getenv("MT5_SERVER")
    path = os.getenv("MT5_TERMINAL_PATH") or None

    kwargs = {}
    if path:
        kwargs["path"] = path
    if login and password and server:
        kwargs.update(login=int(login), password=password, server=server)

    if mt5.initialize(**kwargs):
        _state.update(connected=True, message="ok")
        return True

    first_error = mt5.last_error()
    mt5.shutdown()

    # Fall back to attaching to a terminal that is already logged in by hand.
    if mt5.initialize(**({"path": path} if path else {})) and mt5.account_info() is not None:
        _state.update(connected=True, message="attached to the running terminal session")
        return True

    mt5.shutdown()
    _state.update(connected=False, message=f"initialize failed: {first_error}")
    return False


def connected():
    """Cheap, non-blocking liveness check against the cached state."""
    if not _state["connected"]:
        return False
    if mt5.account_info() is None:
        _state.update(connected=False, message="connection to the terminal was lost")
        return False
    return True


def not_connected_response():
    return jsonify(error=_state["message"], connected=False), 503


# --- Broker timezone -------------------------------------------------------
#
# MT5 exposes no API for the trade server's timezone, and bar times come back
# labelled in that timezone. The only live measurement available is "how far
# ahead of UTC is the newest tick", which is valid ONLY while the market is
# open. At a weekend the newest tick is hours stale and that measurement
# silently produces a nonsense offset - measured here as -15.5h on a Saturday,
# which would have shifted every stored candle by fifteen hours.
#
# So: prefer an explicit configured value, accept a live measurement only from
# a genuinely fresh tick, cache the last good one, and otherwise report the
# offset as unknown so the Node side can refuse to store mislabelled candles.

OFFSET_CACHE_PATH = os.path.join(os.path.dirname(__file__), "offset.json")
MAX_TICK_AGE_SECONDS = 300
# Real trade servers sit between UTC-12 and UTC+14.
MIN_OFFSET, MAX_OFFSET = -12 * 3600, 14 * 3600

OFFSET_PROBE_SYMBOLS = ("EURUSD", "XAUUSD", "USDJPY", "GBPUSD", "BTCUSD", "US500")


def _read_cached_offset():
    try:
        with open(OFFSET_CACHE_PATH, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _write_cached_offset(offset):
    try:
        with open(OFFSET_CACHE_PATH, "w", encoding="utf-8") as fh:
            json.dump({"offset": offset, "measured_at": int(time.time())}, fh)
    except OSError:
        pass


def _measure_offset():
    """Offset from the freshest tick, or None if no tick is recent enough."""
    now = time.time()
    freshest = None
    for name in OFFSET_PROBE_SYMBOLS:
        try:
            if not mt5.symbol_select(name, True):
                continue
            tick = mt5.symbol_info_tick(name)
        except Exception:
            continue
        if tick is None or not tick.time:
            continue
        if freshest is None or tick.time > freshest:
            freshest = tick.time

    if freshest is None:
        return None
    if now - freshest > MAX_TICK_AGE_SECONDS:
        return None  # Market closed: the tick is a timestamp, not a clock.

    # Broker offsets are whole or half hours; rounding removes sampling jitter.
    candidate = int(round((freshest - now) / 1800.0) * 1800)
    if candidate < MIN_OFFSET or candidate > MAX_OFFSET:
        return None
    return candidate


def broker_offset():
    """Return (offset_seconds, source, trustworthy)."""
    configured = os.getenv("MT5_SERVER_UTC_OFFSET_SECONDS")
    measured = _measure_offset()

    if measured is not None:
        _write_cached_offset(measured)

    if configured not in (None, ""):
        value = int(configured)
        if measured is not None and measured != value:
            print(
                f"WARNING: configured broker offset {value}s disagrees with the "
                f"live measurement {measured}s - update MT5_SERVER_UTC_OFFSET_SECONDS",
                flush=True,
            )
        return value, "config", True

    if measured is not None:
        return measured, "live", True

    cached = _read_cached_offset()
    if cached:
        return int(cached["offset"]), "cached", True

    return 0, "unknown", False


@app.get("/health")
@require_token
def health():
    if not connected():
        return jsonify(
            ok=False,
            message=_state["message"],
            mt5_initialized=False,
            terminal=None,
            account_login=None,
            server_utc_offset_seconds=0,
        )

    info = mt5.terminal_info()
    account = mt5.account_info()
    return jsonify(
        ok=True,
        message=_state["message"],
        mt5_initialized=info is not None,
        terminal=info.name if info else None,
        account_login=account.login if account else None,
        server=account.server if account else None,
        balance=account.balance if account else None,
        trade_allowed=info.trade_allowed if info else False,
        **dict(zip(
            ("server_utc_offset_seconds", "offset_source", "offset_trustworthy"),
            broker_offset(),
        )),
    )


@app.get("/account")
@require_token
def account():
    if not connected():
        return not_connected_response()
    a = mt5.account_info()
    if a is None:
        return jsonify(error=f"account_info failed: {mt5.last_error()}"), 502
    return jsonify(
        login=a.login,
        currency=a.currency,
        balance=a.balance,
        equity=a.equity,
        margin_free=a.margin_free,
        leverage=a.leverage,
        server=a.server,
    )


@app.get("/symbols")
@require_token
def symbols():
    if not connected():
        return not_connected_response()

    all_symbols = mt5.symbols_get()
    if all_symbols is None:
        return jsonify(error=f"symbols_get failed: {mt5.last_error()}"), 502

    out = []
    for s in all_symbols:
        out.append(
            {
                "name": s.name,
                "description": s.description,
                "digits": s.digits,
                "point": s.point,
                "contract_size": s.trade_contract_size,
                "tick_size": s.trade_tick_size or s.point,
                "tick_value": s.trade_tick_value,
                "min_lot": s.volume_min,
                "lot_step": s.volume_step,
                "max_lot": s.volume_max,
                "spread": s.spread,
                "currency_profit": s.currency_profit,
                "currency_margin": s.currency_margin,
            }
        )
    return jsonify(symbols=out)


@app.get("/candles")
@require_token
def candles():
    if not connected():
        return not_connected_response()

    symbol = request.args.get("symbol")
    timeframe = request.args.get("timeframe", "H1")
    count = int(request.args.get("count", 500))

    if not symbol:
        return jsonify(error="symbol is required"), 400
    if timeframe not in TIMEFRAMES:
        return jsonify(error=f"unknown timeframe {timeframe}"), 400
    count = max(1, min(count, 20000))

    # A symbol must be selected in Market Watch before its history is readable.
    if not mt5.symbol_select(symbol, True):
        return jsonify(error=f"symbol_select failed for {symbol}: {mt5.last_error()}"), 400

    # The first request for a symbol/timeframe often only triggers the
    # terminal's history download and returns stale or empty data, so ask
    # again after a short pause before giving up.
    rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[timeframe], 0, count)
    if rates is None or len(rates) < min(count, 2):
        time.sleep(1.5)
        rates = mt5.copy_rates_from_pos(symbol, TIMEFRAMES[timeframe], 0, count)

    if rates is None:
        return jsonify(error=f"copy_rates failed: {mt5.last_error()}"), 502

    offset, offset_source, offset_trustworthy = broker_offset()
    out = [
        {
            # Broker-time epoch. The Node side subtracts the offset.
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
            "real_volume": int(r["real_volume"]),
            "spread": int(r["spread"]),
        }
        for r in rates
    ]
    return jsonify(
        symbol=symbol,
        timeframe=timeframe,
        server_utc_offset_seconds=offset,
        offset_source=offset_source,
        offset_trustworthy=offset_trustworthy,
        candles=out,
    )


@app.post("/reconnect")
@require_token
def reconnect():
    """Retry the connection. Blocks the whole process - operator-triggered only."""
    ok = connect()
    return jsonify(connected=ok, message=_state["message"]), (200 if ok else 503)


if __name__ == "__main__":
    # 127.0.0.1 only. This process can read a funded trading account.
    print("connecting to MetaTrader 5 ...", flush=True)
    if connect():
        print(f"MT5 connected: {_state['message']}", flush=True)
    else:
        print(f"MT5 unavailable: {_state['message']}", flush=True)
        print("Serving anyway; POST /reconnect to retry.", flush=True)

    app.run(
        host="127.0.0.1",
        port=int(os.getenv("BRIDGE_PORT", 8000)),
        debug=False,
        threaded=True,
    )
