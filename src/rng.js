// Контракт rng как в части 1: rng(min, max) возвращает целое из [min, max] включительно.

// Дробное число в [0, 1) из целочисленного rng.
export function rand01(rng) {
  return rng(0, 999999) / 1e6;
}

// entries: [{ item, weight }], u: число в [0, 1). Возвращает item или null, если весов нет.
export function pickWeighted(entries, u) {
  const total = entries.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return null;
  const target = u * total;
  let cumulative = 0;
  for (const e of entries) {
    cumulative += e.weight;
    if (target < cumulative) return e.item;
  }
  return entries[entries.length - 1].item;
}
