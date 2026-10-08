// Сохранение состояния боя в data/battle.json: атомарно (временный файл → rename).
// Формат: { savedAtMs, state } — state это toJSON() движка.

import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file, content, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) {
    try { fs.chmodSync(file, mode); } catch { /* в Windows права 600 работают лишь частично */ }
  }
}

export function saveBattle(file, engineJson, nowMs) {
  writeFileAtomic(file, JSON.stringify({ savedAtMs: nowMs, state: JSON.parse(engineJson) }));
}

// Что делать с сохранённым боем при запуске:
//   { status: 'none' }                       — файла нет
//   { status: 'resume', engineJson }         — бой не завершён и свежий
//   { status: 'stale', hadBattle: true }     — бой был, но сохранён слишком давно (файл удалён)
//   { status: 'finished' }                   — бой уже закончен или не начинался (файл удалён)
//   { status: 'corrupt' }                    — файл не читается (переименован в .corrupt)
export function loadBattle(file, nowMs, maxAgeMs) {
  if (!fs.existsSync(file)) return { status: 'none' };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fs.renameSync(file, `${file}.corrupt`);
    return { status: 'corrupt' };
  }
  const phase = saved?.state?.phase;
  const active = phase === 'lobby' || phase === 'running';
  if (!active) {
    fs.rmSync(file, { force: true });
    return { status: 'finished' };
  }
  if (!(nowMs - saved.savedAtMs <= maxAgeMs)) {
    fs.rmSync(file, { force: true });
    return { status: 'stale', hadBattle: true };
  }
  return { status: 'resume', engineJson: JSON.stringify(saved.state), savedAtMs: saved.savedAtMs };
}
