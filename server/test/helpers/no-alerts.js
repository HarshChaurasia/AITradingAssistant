/**
 * Imported by every test file that can reach the alert path.
 *
 * The execution and risk tests call the real alert helpers with stub brokers.
 * Without this, running the suite delivers fictional fills to a real phone -
 * which happened: stub tickets 555, 777 and 888 arrived on Telegram looking
 * exactly like live trades.
 *
 * Setting it here as well as in the notifier is deliberate. One guard on an
 * outbound-message path is one bug away from being no guard.
 */
process.env.NODE_ENV = 'test';
