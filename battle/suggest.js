// Подсказка на опечатку в команде: «@ник, такой команды нет. Может, ты про !атака?»
// Отвечаем только на близкие к нашим командам опечатки (и на набор в другой раскладке),
// чтобы не перебивать команды других ботов (!uptime, !discord, !so …).

// staff — только стримеру и модераторам; phases — когда команда имеет смысл (null — всегда).
export const KNOWN_COMMANDS = [
  { cmd: '!join', phases: ['lobby', 'running'] },
  { cmd: '!атака', phases: ['running'] },
  { cmd: '!навык', phases: ['running'] },
  { cmd: '!особый', phases: ['running'] },
  { cmd: '!я', phases: null },
  { cmd: '!очки', phases: null },
  { cmd: '!топ', phases: null },
  { cmd: '!босс', phases: ['idle', 'ended'], staff: true },
  { cmd: '!стоп', phases: ['lobby', 'running'], staff: true },
  { cmd: '!карта', phases: ['running'], staff: true },
  { cmd: '!рука', phases: ['running'], staff: true },
];

// Частые «русские» написания команд, которые опечаткой не считаются.
const ALIASES = {
  '!джоин': '!join', '!джойн': '!join', '!жоин': '!join', '!вступить': '!join', '!войти': '!join',
  '!атаковать': '!атака', '!удар': '!атака', '!скилл': '!навык', '!скил': '!навык', '!ульта': '!особый',
};

// Клавиши латинской раскладки → те же клавиши в русской (ЙЦУКЕН) и обратно.
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const EN_TO_RU = Object.fromEntries([...EN].map((c, i) => [c, RU[i]]));
const RU_TO_EN = Object.fromEntries([...RU].map((c, i) => [c, EN[i]]));
const swapLayout = (word, map) => [...word].map((c) => map[c] ?? c).join('');

const normalize = (word) => word.toLowerCase().replace(/ё/g, 'е');

// Расстояние Дамерау — Левенштейна (вставка, удаление, замена, перестановка соседних).
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Допустимое число правок: короткие слова — одна, длинные — две. «!я» и подобные — только раскладка.
function maxEdits(word) {
  const letters = word.length - 1; // без «!»
  if (letters <= 2) return 0;
  if (letters <= 4) return 1;
  return 2;
}

// Возвращает известную команду, которую, скорее всего, имели в виду, или null.
// command — первое слово сообщения с «!»; candidates — список строк команд.
export function findSuggestion(command, candidates) {
  const word = normalize(command);
  if (!word.startsWith('!') || word.length < 2 || candidates.includes(word)) return null;

  // 1. Русское написание: «!джоин» → «!join».
  if (ALIASES[word] && candidates.includes(ALIASES[word])) return ALIASES[word];

  // 2. Набрано в другой раскладке: «!fnfrf» → «!атака», «!ощшт» → «!join».
  for (const variant of [swapLayout(word, EN_TO_RU), swapLayout(word, RU_TO_EN)]) {
    if (candidates.includes(variant)) return variant;
  }

  // 3. Оборванная команда (от трёх букв): «!особ» → «!особый», если вариант единственный.
  if (word.length >= 4) {
    const prefixed = candidates.filter((c) => c.startsWith(word));
    if (prefixed.length === 1) return prefixed[0];
  }

  // 4. Опечатка: единственная ближайшая команда в пределах допуска.
  let best = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const cand of candidates) {
    const dist = editDistance(word, cand);
    if (dist < bestDistance) {
      best = cand;
      bestDistance = dist;
      tie = false;
    } else if (dist === bestDistance) {
      tie = true;
    }
  }
  const limit = Math.min(maxEdits(word), maxEdits(best ?? ''));
  return best && !tie && bestDistance <= limit ? best : null;
}

// Команды, которые имеет смысл подсказать этому пользователю в этой фазе боя.
export function availableCommands(phase, isStaff) {
  return KNOWN_COMMANDS
    .filter((c) => !c.staff || isStaff)
    .filter((c) => c.phases === null || c.phases.includes(phase))
    .map((c) => c.cmd);
}

export function renderSuggestion(displayName, suggestion) {
  return `@${displayName}, такой команды нет. Может, ты про ${suggestion}?`.slice(0, 500);
}
