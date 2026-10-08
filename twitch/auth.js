// Разовая авторизация аккаунта бота (authorization code flow) → data/tokens.json.
//   node auth.js
// Откройте показанную ссылку в браузере, где вы вошли в Твич ПОД АККАУНТОМ БОТА.

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { CONFIG } from '../src/config.js';
import { writeFileAtomic } from './persistence.js';

const T = CONFIG.TWITCH;
const dotenv = await import('dotenv');
dotenv.config({ quiet: true });
const { exchangeCode, getTokenInfo } = await import('@twurple/auth');

const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const botName = process.env.BOT_USER_NAME;
if (!clientId || !clientSecret) {
  console.error('В .env нужны TWITCH_CLIENT_ID и TWITCH_CLIENT_SECRET (см. README, шаг 2).');
  process.exit(1);
}

const redirectUri = `http://localhost:${T.authPort}/callback`;
const state = crypto.randomBytes(16).toString('hex'); // защита от подделки ответа
const url = 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: T.scopes.join(' '),
  state,
  force_verify: 'true', // всегда показывать, под каким аккаунтом вы входите
});

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto"><h2>${title}</h2><p>${text}</p></body>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirectUri);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const reply = (code, title, text) => res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, text));
  if (u.searchParams.get('state') !== state) {
    reply(400, 'Ошибка', 'Ответ не от этого запуска auth.js. Запустите node auth.js заново.');
    return;
  }
  if (u.searchParams.get('error')) {
    reply(400, 'Доступ не выдан', u.searchParams.get('error_description') ?? 'Вы отказались.');
    console.error('Авторизация отклонена в браузере.');
    server.close();
    return;
  }
  try {
    const token = await exchangeCode(clientId, clientSecret, u.searchParams.get('code'), redirectUri);
    const info = await getTokenInfo(token.accessToken, clientId);
    writeFileAtomic(T.tokensFile, JSON.stringify(token, null, 2), { mode: 0o600 });
    const who = info.userName;
    const mismatch = botName && who.toLowerCase() !== botName.toLowerCase();
    reply(200, 'Готово!', `Токен сохранён для аккаунта <b>${who}</b>. Окно можно закрыть.`
      + (mismatch ? `<br><br>⚠️ В .env указан BOT_USER_NAME=${botName}, а вы вошли как ${who}.` : ''));
    console.log(`\n✅ Готово: токен для @${who} сохранён в ${T.tokensFile}`);
    console.log(`   Скоупы: ${info.scopes.join(', ')}`);
    if (mismatch) console.log(`⚠️  В .env указан BOT_USER_NAME=${botName}, а вошли вы как ${who}. Проверьте, под кем вы вошли в браузере.`);
  } catch (err) {
    reply(500, 'Ошибка', 'Не удалось получить токен — подробности в консоли.');
    console.error('Не удалось получить токен:', err?.message ?? err);
  }
  server.close();
});

server.listen(T.authPort, () => {
  console.log('1. Убедитесь, что в браузере вы вошли в Твич под АККАУНТОМ БОТА (удобно — в приватном окне).');
  console.log('2. Откройте ссылку и нажмите «Разрешить» (Authorize):\n');
  console.log(url + '\n');
  console.log(`Жду ответа Твича на ${redirectUri} …`);
  const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(opener, () => {}); // попытка открыть браузер; если не вышло — ссылка выше
});
