// Контракт rng как в части 1: rng(min, max) возвращает целое из [min, max] включительно.

// Воспроизводимый rng по seed (mulberry32): одинаковый seed — одинаковые бои.
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return (min, max) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return min + Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * (max - min + 1));
  };
}

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
