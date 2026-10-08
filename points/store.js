// Хранилище очков. Интерфейс Store:
//   load(), get(userId), update(userId, fn), top(n), rankOf(userId),
//   isBattleProcessed(battleId), markBattleProcessed(battleId), save()
// get/top возвращают копии: менять запись можно только через update.
//
// createFileStore: один JSON-файл. Запись атомарная (временный файл → rename), отложенная
// (debounce) и принудительная через save(). Перед перезаписью рабочий файл копируется в .bak;
// если основной файл повреждён, load() поднимает данные из .bak.

import nodeFs from 'node:fs';
import { CONFIG } from '../src/config.js';

const DATA_VERSION = 1;

function emptyData() {
  return { version: DATA_VERSION, users: {}, processedBattles: [] };
}

function isValidData(d) {
  return d && d.version === DATA_VERSION && typeof d.users === 'object' && Array.isArray(d.processedBattles);
}

// Рейтинг: больше очков выше; при равенстве выше тот, кто раньше впервые появился, затем userId.
export function compareRecords(a, b) {
  return b.totalPoints - a.totalPoints || a.firstSeenAt - b.firstSeenAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);
}

function makeStore(data, { persist = () => {}, schedule = () => {}, config = CONFIG } = {}) {
  let sorted = null; // кеш рейтинга, сбрасывается при update
  const ranking = () => (sorted ??= Object.values(data.users).sort(compareRecords));

  return {
    load() { return this; },
    get(userId) {
      const r = data.users[userId];
      return r ? structuredClone(r) : null;
    },
    // fn получает копию записи (или null для нового игрока) и возвращает новую запись.
    update(userId, fn) {
      const current = data.users[userId] ? structuredClone(data.users[userId]) : null;
      const next = fn(current);
      if (next) data.users[userId] = { ...next, userId };
      sorted = null;
      schedule();
      return next ? structuredClone(data.users[userId]) : null;
    },
    top(n) {
      return ranking().slice(0, n).map((r) => structuredClone(r));
    },
    rankOf(userId) {
      const i = ranking().findIndex((r) => r.userId === userId);
      return i < 0 ? null : i + 1;
    },
    isBattleProcessed(battleId) {
      return data.processedBattles.includes(battleId);
    },
    markBattleProcessed(battleId) {
      if (!data.processedBattles.includes(battleId)) data.processedBattles.push(battleId);
      const keep = config.POINTS.keepProcessedBattles;
      if (data.processedBattles.length > keep) data.processedBattles.splice(0, data.processedBattles.length - keep);
      schedule();
    },
    save() { persist(data); },
    // Для тестов и инструментов.
    snapshot() { return structuredClone(data); },
  };
}

export function createMemoryStore(initial = null, { config = CONFIG } = {}) {
  return makeStore(isValidData(initial) ? structuredClone(initial) : emptyData(), { config });
}

function readJson(fs, path) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    return isValidData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// { store, recoveredFromBackup }. Если нет ни основного файла, ни .bak — пустое хранилище.
export function createFileStore(filePath, { debounceMs = CONFIG.POINTS.storeDebounceMs, fs = nodeFs, config = CONFIG } = {}) {
  const bakPath = `${filePath}.bak`;
  const tmpPath = `${filePath}.tmp`;
  let timer = null;
  let recoveredFromBackup = false;

  let data = readJson(fs, filePath);
  if (!data && fs.existsSync(filePath)) {
    data = readJson(fs, bakPath); // основной файл повреждён
    recoveredFromBackup = data !== null;
  }
  data ??= readJson(fs, bakPath) ?? emptyData();

  const persist = (d) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // В .bak копируется только целый предыдущий файл: повреждённый не затирает хорошую копию.
    if (readJson(fs, filePath)) fs.copyFileSync(filePath, bakPath);
    fs.writeFileSync(tmpPath, JSON.stringify({ ...d, updatedAt: Date.now() }, null, 2));
    fs.renameSync(tmpPath, filePath);
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => persist(data), debounceMs);
    timer.unref?.(); // отложенная запись не держит процесс
  };

  const store = makeStore(data, { persist, schedule, config });
  store.recoveredFromBackup = recoveredFromBackup;
  store.filePath = filePath;
  return store;
}
