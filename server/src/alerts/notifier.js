/**
 * Telegram alerts.
 *
 * sendAlert never throws. An alerting outage is the least important failure
 * in this process, and it must never stop or corrupt trading.
 */

async function sendAlert(text, {
  fetchImpl = fetch,
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  logger = console
} = {}) {
  // Belt: the test suite exercises the execution path with stub brokers, and
  // those paths call the real alert helpers. Without this, running the tests
  // sends fictional fills to a real phone - which happened, with the stub
  // ticket numbers 555, 777 and 888 arriving as if they were trades.
  if (process.env.NODE_ENV === 'test') {
    return { sent: false, reason: 'alerts are disabled under NODE_ENV=test' };
  }

  if (!botToken || !chatId) {
    return { sent: false, reason: 'alerts are not configured' };
  }

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      const detail = await response.text();
      const reason = `telegram returned ${response.status}: ${detail}`;
      logger.error(reason);
      return { sent: false, reason };
    }

    return { sent: true };
  } catch (error) {
    logger.error(`alert failed: ${error.message}`);
    return { sent: false, reason: error.message };
  }
}

module.exports = { sendAlert };
