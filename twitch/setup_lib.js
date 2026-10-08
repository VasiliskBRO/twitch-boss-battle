// Чистые функции мастера установки (setup.js) — без сети, их проверяют тесты.

// «@Имя», «twitch.tv/имя», «https://www.twitch.tv/Имя/» → «имя». null, если не похоже на логин Твича.
export function normalizeChannelName(input) {
  let s = String(input ?? '').trim();
  if (/\s/.test(s)) return null; // несколько слов — лучше переспросить, чем угадывать
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)?twitch\.tv\//i, '');
  s = s.split(/[/?#]/)[0].replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
}

// Обновляет переменные в тексте .env, сохраняя остальные строки и комментарии.
// vars: { KEY: 'value' }; значение null удаляет строку.
export function upsertEnv(text, vars) {
  const lines = String(text ?? '').split(/\r?\n/);
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in vars) {
      done.add(m[1]);
      if (vars[m[1]] !== null) out.push(`${m[1]}=${vars[m[1]]}`);
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [key, value] of Object.entries(vars)) {
    if (!done.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  return `${out.join('\n')}\n`;
}

// Читает значение переменной из текста .env (без dotenv — для подсказок мастера).
export function readEnvValue(text, key) {
  const m = String(text ?? '').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

// Ждёт, пока пользователь введёт код на twitch.tv/activate.
//   exchange() — попытка получить токен (Twurple exchangeDeviceCode), бросает ошибку, пока код не введён;
//   Твич отвечает 400 «authorization_pending» (ждём) или «slow_down» (ждём дольше).
// Возвращает токен; бросает Error с понятным текстом при отказе или истечении времени.
export async function pollDeviceCode(exchange, { intervalSeconds = 5, expiresInSeconds = 1800, sleep, now = Date.now }) {
  let interval = intervalSeconds;
  const deadline = now() + expiresInSeconds * 1000;
  for (;;) {
    try {
      return await exchange();
    } catch (err) {
      const text = `${err?.body ?? ''} ${err?.message ?? err}`.toLowerCase();
      if (text.includes('authorization_pending')) {
        // ещё не ввели код — ждём
      } else if (text.includes('slow_down')) {
        interval += 5;
      } else if (text.includes('access_denied') || text.includes('denied')) {
        throw new Error('Доступ не выдан: на странице Твича нажали «Отмена».');
      } else if (text.includes('invalid device code') || text.includes('expired')) {
        throw new Error('Код устарел. Запустите установку ещё раз.');
      } else {
        throw err;
      }
    }
    if (now() + interval * 1000 > deadline) throw new Error('Время на ввод кода вышло. Запустите установку ещё раз.');
    await sleep(interval * 1000);
  }
}

// Node.js не старше 20?
export function nodeVersionOk(version = process.versions.node) {
  return Number(String(version).split('.')[0]) >= 20;
}
