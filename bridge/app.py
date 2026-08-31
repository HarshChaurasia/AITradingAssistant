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


# --- Write guards ------------------------------------------------------
#
# Three independent checks stand in front of every write. They overlap on
# purpose: this is the boundary where software starts spending money, and a
# single check is one bug away from being no check.

def trading_enabled():
    return os.getenv("MT5_ALLOW_TRADING", "false").lower() == "true"


def live_allowed():
    return os.getenv("MT5_ALLOW_LIVE", "false").lower() == "true"


def account_is_real():
    """True when the logged-in account trades real money."""
    info = mt5.account_info()
    if info is None:
        return True  # Unknown means treat it as real. Fail closed.
    # ACCOUNT_TRADE_MODE_REAL == 2 in the MT5 API.
    return int(info.trade_mode) == 2


def write_guard():
    """Return an error response when writing is not permitted, else None."""
    if not trading_enabled():
        return jsonify(
            error="trading is disabled on this bridge (set MT5_ALLOW_TRADING=true to enable)",
            code="trading_disabled",
        ), 403
    if account_is_real() and not live_allowed():
        return jsonify(
            error="refusing to trade a REAL account (set MT5_ALLOW_LIVE=true to permit)",
            code="live_account_blocked",
        ), 403
    return None



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
        trading_enabled=trading_enabled(),
        live_allowed=live_allowed(),
        account_is_real=account_is_real(),
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


# Retcodes that mean "the broker will not accept an order right now because
# the market is not trading". Measured against this account: Axi's demo server
# does NOT return these - it answered retcode 0 for EURUSD after 38 hours
# without a quote - so they confirm a closure when present but can never be
# relied on to detect one.
MARKET_CLOSED_RETCODES = {
    10018,  # TRADE_RETCODE_MARKET_CLOSED
    10017,  # TRADE_RETCODE_TRADE_DISABLED
}

# The deciding signal. An open market quotes: BTCUSD and ETHUSD were 1-2
# seconds old on the Sunday this was measured, while EURUSD, GBPUSD and XAUUSD
# were all 137,000-odd seconds old - Friday's close. Ten minutes sits three
# orders of magnitude away from both, so it tolerates a quiet moment on a thin
# instrument without ever calling a shut market open.
DEFAULT_STALE_TICK_SECONDS = 600


@app.get("/symbol/market-status")
@require_token
def symbol_market_status():
    """Is this symbol tradeable at this instant, according to the broker?

    There is no weekly session calendar to read: symbol_info_session_trade is
    MQL5-only and simply absent from the MetaTrader5 Python package, so an
    earlier attempt to build on it produced seven empty days for every symbol
    and raised nothing at all.

    What the broker does answer is quotes. An open market ticks; a shut one
    stops, and the gap is unmistakable - seconds against tens of hours. That
    is the deciding signal here. order_check is asked as well and its verdict
    is honoured when it reports the market closed, but this account's server
    answers retcode 0 for instruments that have not quoted since Friday, so it
    cannot be the only question.

    A hardcoded "forex is shut at the weekend" rule would be wrong in both
    directions: BTCUSD trades straight through Saturday, and plenty of
    instruments close early on Friday or take a daily break.
    """
    if not connected():
        return not_connected_response()

    symbol = request.args.get("symbol")
    if not symbol:
        return jsonify(error="symbol is required"), 400

    try:
        stale_after = int(request.args.get("stale_after", DEFAULT_STALE_TICK_SECONDS))
    except ValueError:
        stale_after = DEFAULT_STALE_TICK_SECONDS
    stale_after = max(60, min(stale_after, 86400))

    if not mt5.symbol_select(symbol, True):
        return jsonify(error=f"symbol_select failed for {symbol}: {mt5.last_error()}"), 400

    info = mt5.symbol_info(symbol)
    if info is None:
        return jsonify(error=f"symbol_info failed for {symbol}: {mt5.last_error()}"), 400

    trade_mode = int(info.trade_mode)
    tick = mt5.symbol_info_tick(symbol)
    offset, _source, _trustworthy = broker_offset()

    tick_age = None
    if tick is not None and tick.time:
        # tick.time is broker time, and so is now once the offset is applied.
        tick_age = max(0, int(time.time() + (offset or 0) - tick.time))

    def answer(is_open, reason, retcode=None):
        return jsonify(
            symbol=symbol,
            open=is_open,
            reason=reason,
            trade_mode=trade_mode,
            tick_age_seconds=tick_age,
            stale_after_seconds=stale_after,
            retcode=retcode,
        )

    # ENUM_SYMBOL_TRADE_MODE: 0 disabled, 1 long only, 2 short only,
    # 3 close only, 4 full. Below 4 the broker restricts the instrument
    # regardless of the hour.
    if trade_mode < 4:
        modes = {0: "disabled", 1: "long only", 2: "short only", 3: "close only"}
        return answer(False, f"the broker has {symbol} set to {modes.get(trade_mode, trade_mode)}")

    if tick_age is None:
        return answer(False, f"{symbol} has never quoted on this terminal")

    if tick_age > stale_after:
        hours = tick_age / 3600.0
        age = f"{hours:.1f}h" if hours >= 1 else f"{tick_age}s"
        return answer(False, f"{symbol} has not quoted for {age} - the market is closed")

    # The market is quoting. Ask the server whether it would actually accept an
    # order, which catches restrictions a tick cannot show. order_check places
    # nothing: it submits a candidate order for validation and returns.
    price = getattr(tick, "ask", 0) or getattr(tick, "bid", 0) or 0
    if not price:
        return answer(False, f"{symbol} is quoting but carries no price")

    check = mt5.order_check(
        {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(info.volume_min),
            "type": mt5.ORDER_TYPE_BUY,
            "price": float(price),
            "deviation": 20,
            "type_filling": filling_mode_for(symbol),
            "type_time": mt5.ORDER_TIME_GTC,
            "comment": "market-status probe",
        }
    )

    if check is None:
        # No answer is not a refusal. The tick already said the market is live.
        return answer(True, f"quoting {tick_age}s ago (order_check gave no answer)")

    retcode = int(check.retcode)
    if retcode in MARKET_CLOSED_RETCODES:
        return answer(False, f"the broker reports the market closed ({check.comment})", retcode)

    # Anything else - no money, invalid volume - means the market is trading
    # and only this particular probe order was unacceptable.
    return answer(True, f"quoting {tick_age}s ago, broker accepts orders (retcode {retcode})", retcode)


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
    # Six months of M5 is about 52,000 bars, so the old 20,000 cap silently
    # truncated any request for real history on a fast timeframe.
    count = max(1, min(count, 120000))

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



def filling_mode_for(symbol):
    """Pick a filling mode the broker actually supports for this symbol.

    Hardcoding IOC gets retcode 10030 'Unsupported filling mode' on brokers
    that only allow FOK, and the order never reaches the market. The symbol
    advertises what it accepts as a bitmask; honour it.
    """
    info = mt5.symbol_info(symbol)
    allowed = int(getattr(info, "filling_mode", 0)) if info else 0

    # SYMBOL_FILLING_FOK == 1, SYMBOL_FILLING_IOC == 2.
    if allowed & 1:
        return mt5.ORDER_FILLING_FOK
    if allowed & 2:
        return mt5.ORDER_FILLING_IOC
    # Neither advertised: RETURN is the safe fallback for market execution.
    return mt5.ORDER_FILLING_RETURN


@app.get("/positions")
@require_token
def positions():
    if not connected():
        return not_connected_response()

    rows = mt5.positions_get()
    if rows is None:
        return jsonify(positions=[])

    return jsonify(positions=[
        {
            "ticket": p.ticket,
            "symbol": p.symbol,
            # POSITION_TYPE_BUY == 0
            "side": "BUY" if p.type == 0 else "SELL",
            "volume": p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "swap": p.swap,
            "time": int(p.time),
        }
        for p in rows
    ])


@app.get("/deals")
@require_token
def deals():
    """Closed deals for one position, used to recover the realised result."""
    if not connected():
        return not_connected_response()

    ticket = request.args.get("ticket")
    if not ticket:
        return jsonify(error="ticket is required"), 400

    rows = mt5.history_deals_get(position=int(ticket))
    if rows is None:
        return jsonify(deals=[])

    return jsonify(deals=[
        {
            "ticket": d.ticket,
            "position_id": d.position_id,
            "symbol": d.symbol,
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "commission": d.commission,
            "swap": d.swap,
            "time": int(d.time),
            # DEAL_ENTRY_IN == 0, DEAL_ENTRY_OUT == 1
            "entry": int(d.entry),
        }
        for d in rows
    ])


@app.post("/order")
@require_token
def order():
    if not connected():
        return not_connected_response()

    blocked = write_guard()
    if blocked:
        return blocked

    body = request.get_json(silent=True) or {}
    symbol = body.get("symbol")
    side = str(body.get("side", "")).upper()
    lot = body.get("lot")
    sl = body.get("sl")
    tp = body.get("tp")

    if not symbol:
        return jsonify(error="symbol is required"), 400
    if side not in ("BUY", "SELL"):
        return jsonify(error="side must be BUY or SELL"), 400
    try:
        lot = float(lot)
    except (TypeError, ValueError):
        return jsonify(error="lot must be a number"), 400
    if lot <= 0:
        return jsonify(error="lot must be greater than zero"), 400

    # The stop loss check is repeated here on purpose. The Node risk engine
    # already enforces it; this is the last line of defence, and the one
    # failure mode that must never get through.
    try:
        sl = float(sl)
    except (TypeError, ValueError):
        return jsonify(error="a stop loss is required on every order", code="no_stop_loss"), 400
    if sl <= 0:
        return jsonify(error="a stop loss is required on every order", code="no_stop_loss"), 400

    if not mt5.symbol_select(symbol, True):
        return jsonify(error=f"symbol_select failed for {symbol}: {mt5.last_error()}"), 400

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify(error=f"no tick for {symbol}; the market may be closed"), 400

    price = tick.ask if side == "BUY" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL

    request_payload = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": order_type,
        "price": price,
        "sl": sl,
        "deviation": int(body.get("deviation", os.getenv("MT5_MAX_DEVIATION", 20))),
        "magic": 20260829,
        "comment": str(body.get("comment", "trading-agent"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode_for(symbol),
    }
    if tp:
        request_payload["tp"] = float(tp)

    result = mt5.order_send(request_payload)
    if result is None:
        return jsonify(error=f"order_send returned nothing: {mt5.last_error()}"), 502

    ok = result.retcode == mt5.TRADE_RETCODE_DONE
    return jsonify(
        ok=ok,
        retcode=int(result.retcode),
        comment=result.comment,
        ticket=int(result.order) if ok else None,
        position=int(getattr(result, "deal", 0)) or None,
        price=float(result.price) if ok else None,
        volume=float(result.volume) if ok else None,
    ), (200 if ok else 400)


@app.post("/close")
@require_token
def close_position():
    if not connected():
        return not_connected_response()

    blocked = write_guard()
    if blocked:
        return blocked

    body = request.get_json(silent=True) or {}
    ticket = body.get("ticket")
    if not ticket:
        return jsonify(error="ticket is required"), 400

    found = mt5.positions_get(ticket=int(ticket))
    if not found:
        return jsonify(error=f"no open position with ticket {ticket}"), 404
    position = found[0]

    tick = mt5.symbol_info_tick(position.symbol)
    if tick is None:
        return jsonify(error=f"no tick for {position.symbol}; the market may be closed"), 400

    # Closing is the opposite side at the opposite price.
    closing_buy = position.type != 0
    result = mt5.order_send({
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position.symbol,
        "volume": position.volume,
        "type": mt5.ORDER_TYPE_BUY if closing_buy else mt5.ORDER_TYPE_SELL,
        "position": int(ticket),
        "price": tick.ask if closing_buy else tick.bid,
        "deviation": int(body.get("deviation", os.getenv("MT5_MAX_DEVIATION", 20))),
        "magic": 20260829,
        "comment": "trading-agent close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode_for(position.symbol),
    })

    if result is None:
        return jsonify(error=f"order_send returned nothing: {mt5.last_error()}"), 502

    ok = result.retcode == mt5.TRADE_RETCODE_DONE
    return jsonify(ok=ok, retcode=int(result.retcode), comment=result.comment), (200 if ok else 400)


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
