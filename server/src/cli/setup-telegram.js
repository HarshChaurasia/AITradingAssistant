require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');

/**
 * Wires up Telegram alerting from a bot token.
 *
 * The bot itself has to be created by hand in Telegram - only the account
 * owner can talk to @BotFather. Everything after that is automated here:
 * validating the token, discovering the chat id, writing the config, and
 * proving a real message arrives.
 */

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const API = 'https://api.telegram.org';

async function callTelegram(token, method, params = {}) {
  const url = new URL(`${API}/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `${method} returned ${response.status}`);
  }
  return body.result;
}

function writeEnv(updates) {
  const original = fs.readFileSync(ENV_PATH, 'utf8');
  let next = original;

  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    next = new RegExp(`^${key}=.*$`, 'm').test(next)
      ? next.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${next.replace(/\n*$/, '\n')}${line}\n`;
  }

  if (next !== original) fs.writeFileSync(ENV_PATH, next);
}

async function main() {
  const token = (process.argv[2] || process.env.TELEGRAM_BOT_TOKEN || '').trim();

  if (!token) {
    console.error(`
No bot token supplied.

Create one first - this part needs your Telegram account:

  1. Open Telegram and message @BotFather
  2. Send:  /newbot
  3. Give it any name and a username ending in "bot"
  4. BotFather replies with a token like 8123456789:AAH...

Then run:

  npm --prefix server run setup-telegram -- <that-token>
`);
    process.exit(1);
  }

  process.stdout.write('checking the token ... ');
  const me = await callTelegram(token, 'getMe');
  console.log(`ok, bot is @${me.username}`);

  // The chat id only exists once a human has messaged the bot: Telegram bots
  // cannot start a conversation, by design.
  process.stdout.write('looking for your chat ... ');
  const updates = await callTelegram(token, 'getUpdates', { limit: 20 });
  const chats = new Map();
  for (const u of updates) {
    const chat = u.message?.chat || u.channel_post?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (chats.size === 0) {
    console.log('none found');
    console.error(`
The bot has not been messaged yet, so Telegram has no chat to send to.
A bot cannot start a conversation - you have to speak first.

  1. Open Telegram, search for @${me.username}
  2. Press Start, or send it any message such as "hello"
  3. Run this command again
`);
    process.exit(1);
  }

  const [chatId, chat] = [...chats.entries()].at(-1);
  const who = chat.username ? `@${chat.username}` : (chat.title || chat.first_name || 'chat');
  console.log(`found ${who} (id ${chatId})`);

  writeEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: String(chatId) });
  console.log('wrote TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to server/.env');

  process.stdout.write('sending a test alert ... ');
  const { sendAlert } = require('../alerts/notifier');
  const result = await sendAlert(
    'Trading agent alerts are working. You will get a message here when an order fills, ' +
    'an order is rejected, the kill switch trips, the broker link drops, or the disk runs low.',
    { botToken: token, chatId }
  );

  if (!result.sent) throw new Error(result.reason);
  console.log('delivered - check Telegram');

  console.log('\nRestart the API so it picks up the new config:');
  console.log('  npx pm2 restart trading-api');
}

main().catch((error) => {
  console.error(`\nfailed: ${error.message}`);
  process.exit(1);
});
