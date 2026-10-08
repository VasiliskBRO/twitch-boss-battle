// Русское склонение: plural(5, ['воин', 'воина', 'воинов']) === 'воинов'.
export function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export const TURN_FORMS = ['ход', 'хода', 'ходов'];

// Обрезает строку до max UTF-16 символов (как считает String.length), не разрывая эмодзи.
export function clip(str, max) {
  if (str.length <= max) return str;
  let out = '';
  for (const ch of str) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return out + '…';
}

const TEMPLATE_FORMATS = {
  // floor, чтобы 62.5% показывалось как 62%; эпсилон гасит ошибки float.
  pct: (v) => `${Math.floor(v * 100 + 1e-9)}%`,
  x: (v) => `×${+v.toFixed(2)}`,
  num: (v) => String(+v.toFixed(2)),
  turns: (v) => `${v} ${plural(v, TURN_FORMS)}`,
  // «в этом ходу» для 1, «на 2 хода» для остальных.
  forTurns: (v) => (v === 1 ? 'в этом ходу' : `на ${v} ${plural(v, TURN_FORMS)}`),
};

// Подставляет числа в шаблон: {путь|формат}, путь внутри values ('0.pct').
export function fillTemplate(text, values) {
  return text.replace(/\{([^}|]+)\|(\w+)\}/g, (_, path, fmt) => {
    const value = path.split('.').reduce((o, k) => o?.[k], values);
    if (value === undefined || !TEMPLATE_FORMATS[fmt]) throw new Error(`Bad template slot {${path}|${fmt}}`);
    return TEMPLATE_FORMATS[fmt](value);
  });
}
