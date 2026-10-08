// Мастер установки для стримера: node setup.js (или двойной клик по «Установить.bat»).
//   1) спрашивает имя канала;
//   2) вход бота по коду (twitch.tv/activate) — без консоли разработчика и секретов;
//   3) проверяет, модератор ли бот;
//   4) записывает .env и data/tokens.json.
// Используется публичное приложение автора игры (TWITCH.publicClientId); своё можно указать в .env.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { exec } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { writeFileAtomic } from './persistence.js';
import { normalizeChannelName, upsertEnv, readEnvValue, pollDeviceCode, nodeVersionOk } from './setup_lib.js';

const T = CONFIG.TWITCH;
const ENV_FILE = '.env';
const say = (text = '') => console.log(text);
const fail = (text) => {
  console.error(`\n❌ ${text}`);
  process.exit(1);
};

if (!nodeVersionOk()) fail(`Нужен Node.js 20 или новее, у вас ${process.versions.node}. Скачайте LTS с https://nodejs.org`);

const envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
const clientId = readEnvValue(envText, 'TWITCH_CLIENT_ID') || T.publicClientId;
if (!clientId) {
  fail('В проекте ещё не указан Client ID приложения (TWITCH.publicClientId в src/config.js).\n'
    + '   Если у вас своё приложение — впишите TWITCH_CLIENT_ID в файл .env.');
}

let auth;
let api;
try {
  auth = await import('@twurple/auth');
  api = await import('@twurple/api');
} catch {
  fail('Не установлены пакеты. Запустите «Установить.bat» или выполните: npm install');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
say('⚔️  Установка бота «Босс для чата Твича»\n');

// 1. Канал
const previous = readEnvValue(envText, 'TWITCH_CHANNEL');
let channel = null;
while (!channel) {
  const answer = await rl.question(`Имя вашего канала на Твиче${previous ? ` [${previous}]` : ''}: `);
  channel = normalizeChannelName(answer || previous);
  if (!channel) say('   Это не похоже на имя канала. Пример: ninja (как в адресе twitch.tv/ninja)');
}

// 2. Вход бота по коду
say('\nТеперь войдём в аккаунт БОТА (не в свой основной аккаунт!).');
const device = await auth.startDeviceCodeFlow(clientId, T.scopes);
say(`\n   1. Откройте: ${device.verificationUri}`);
say('   2. Войдите под аккаунтом бота (удобно в приватном окне браузера).');
say(`   3. Если попросят код, введите: ${device.userCode}`);
say('   4. Нажмите «Authorize» (Разрешить).\n');
const opener = process.platform === 'win32' ? `start "" "${device.verificationUri}"` : process.platform === 'darwin' ? `open "${device.verificationUri}"` : `xdg-open "${device.verificationUri}"`;
exec(opener, () => {});
say('Жду подтверждения…');

let token;
try {
  token = await pollDeviceCode(() => auth.exchangeDeviceCode(clientId, device.deviceCode, T.scopes), {
    intervalSeconds: device.interval,
    expiresInSeconds: device.expiresIn,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
} catch (err) {
  fail(err.message);
}
const info = await auth.getTokenInfo(token.accessToken, clientId);
const botName = info.userName;
say(`✅ Вход выполнен: @${botName}`);

if (botName.toLowerCase() === channel) {
  fail(`Вы вошли под своим основным аккаунтом (${botName}). Бот пока работает только с отдельного аккаунта.\n`
    + '   Заведите аккаунт для бота и запустите установку снова, войдя под ним.');
}

writeFileAtomic(T.tokensFile, JSON.stringify(token, null, 2), { mode: 0o600 });
const vars = { TWITCH_CHANNEL: channel, BOT_USER_NAME: botName };
fs.writeFileSync(ENV_FILE, upsertEnv(envText || '# Настройки бота (создано мастером установки)\n', vars));

// 3. Модератор ли бот
try {
  const provider = new auth.RefreshingAuthProvider({ clientId });
  provider.onRefresh((userId, data) => writeFileAtomic(T.tokensFile, JSON.stringify(data, null, 2), { mode: 0o600 }));
  const botId = await provider.addUserForToken(token, ['chat']);
  const client = new api.ApiClient({ authProvider: provider });
  const ch = await client.users.getUserByName(channel);
  if (!ch) {
    say(`\n⚠️  Канал «${channel}» не найден на Твиче. Проверьте имя и запустите установку снова.`);
  } else {
    const moderated = await client.moderation.getModeratedChannelsPaginated(botId).getAll();
    if (moderated.some((c) => c.id === ch.id)) {
      say(`✅ @${botName} — модератор канала ${ch.displayName}.`);
    } else {
      say(`\n⚠️  @${botName} пока не модератор канала ${ch.displayName}.`);
      say(`   Напишите в чате своего канала: /mod ${botName}`);
      say('   Без этого бот работает, но медленнее (и не сможет присылать ссылки, если они запрещены в чате).');
    }
  }
} catch (err) {
  say(`\n⚠️  Не удалось проверить модератора: ${err?.message ?? err}`);
}

rl.close();
say('\n🎉 Готово! Запускайте бота: двойной клик по «Запустить бота.bat» (или команда node bot.js).');
say('   В чате напишите !босс, чтобы начать бой.');
say('   Если бот не запускался больше 30 дней — просто пройдите эту установку ещё раз.');
