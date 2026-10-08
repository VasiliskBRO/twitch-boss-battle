// Детерминированный хеш строки: FNV-1a (32 бита) + финальное перемешивание из murmur3 (fmix32).
// Без перемешивания у FNV-1a старшие биты слабо зависят от последних символов,
// а соли (':skill', ':rarity', id черты) дописываются именно в конец ключа.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Число в [0, 1).
export function hash01(str) {
  return hash32(str) / 4294967296;
}

// hashKey('b1', 'u1', 'skill') === hash01('b1:u1:skill')
export function hashKey(...parts) {
  return hash01(parts.join(':'));
}
