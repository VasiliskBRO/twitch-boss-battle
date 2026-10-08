// Лог в файл с ротацией по размеру: bot.log, bot.log.1 … bot.log.(maxFiles-1).
// Секреты (токены, client secret) вырезаются из каждой строки: addSecret(value).

import fs from 'node:fs';
import path from 'node:path';

export function createLogger({ file, maxBytes = 2 * 1024 * 1024, maxFiles = 5, now = Date.now, echo = false } = {}) {
  const secrets = new Set();
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  const redact = (text) => {
    let out = String(text);
    for (const s of secrets) if (s) out = out.split(s).join('***');
    return out;
  };

  const rotate = () => {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`);
    }
  };

  const write = (level, msg) => {
    const line = `${new Date(now()).toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(msg)}\n`;
    if (echo) process.stderr.write(line);
    if (!file) return;
    try {
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(file, line);
    } catch {
      // Лог не должен ронять бота.
    }
  };

  return {
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
    addSecret: (value) => { if (value && String(value).length >= 4) secrets.add(String(value)); },
    redact,
  };
}

// Логгер, который ничего не пишет (тесты).
export const silentLogger = { info() {}, warn() {}, error() {}, addSecret() {}, redact: (s) => s };
