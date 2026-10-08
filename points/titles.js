// Звания: проверка условий и показ звания с наибольшим приоритетом.

import { CONFIG } from '../src/config.js';

export function getTitleDef(id, config = CONFIG) {
  return config.TITLES.find((t) => t.id === id) ?? null;
}

function meets(record, title) {
  return (record[title.condition.stat] ?? 0) >= title.condition.min;
}

// Звания, условия которых выполнены, но которых ещё нет в record.titles (по убыванию приоритета).
export function checkNewTitles(record, config = CONFIG) {
  const owned = new Set(record.titles ?? []);
  return config.TITLES
    .filter((t) => !owned.has(t.id) && meets(record, t))
    .sort((a, b) => b.priority - a.priority);
}

// Звание для показа: наивысший приоритет среди полученных; null, если званий нет.
export function topTitle(record, config = CONFIG) {
  const owned = (record.titles ?? []).map((id) => getTitleDef(id, config)).filter(Boolean);
  if (owned.length === 0) return null;
  return owned.sort((a, b) => b.priority - a.priority)[0];
}
