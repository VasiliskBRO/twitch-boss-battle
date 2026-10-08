// Разбор строки консольного режима.
// «@мод имя: текст», «@стример имя: текст», «имя: текст» или просто «текст» (от «зритель»).
export function parseConsoleLine(line) {
  const m = line.match(/^@(мод|стример)\s+([^:]+):\s*(.*)$/i);
  if (m) {
    const badges = m[1].toLowerCase() === 'мод' ? { moderator: '1' } : { broadcaster: '1' };
    return { name: m[2].trim(), text: m[3], badges };
  }
  const p = line.match(/^([^:!]+):\s*(.*)$/);
  if (p) return { name: p[1].trim(), text: p[2], badges: {} };
  return { name: 'зритель', text: line, badges: {} };
}
