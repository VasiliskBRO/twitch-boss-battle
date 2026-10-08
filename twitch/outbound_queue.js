// Очередь исходящих сообщений: приоритеты, лимиты Твича, перегрузка, дубликаты, длина, потеря связи.
// Время внедряется (now), отправка — через send(text, { replyToMessageId }) адаптера.
// Отправка идёт по одному сообщению: pump() вызывается часто (раз в 50–100 мс) и сам решает,
// можно ли сейчас что-то отправить.

const PRIORITIES = ['high', 'normal', 'low'];
const MAX_LEN = 500;
const DUPLICATE_WINDOW_MS = 30_000; // Твич отбрасывает повтор последнего сообщения в течение 30 с

// Режет текст длиннее 500 символов по « | », затем по пробелам, в крайнем случае — жёстко.
export function splitMessage(text, max = MAX_LEN) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf(' | ');
    let skip = 3;
    if (cut < max * 0.3) {
      cut = window.lastIndexOf(' ');
      skip = 1;
    }
    if (cut < max * 0.3) {
      cut = max;
      skip = 0;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut + skip).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export class OutboundQueue {
  // config — CONFIG.TWITCH; send — async (text, opts) => void (бросает ошибку при неудаче);
  // onConsole(text) — печать сообщений to: 'console'; log — { info, warn, error }.
  constructor({ config, now, send, onConsole = () => {}, log = console }) {
    this.config = config;
    this.now = now;
    this.send = send;
    this.onConsole = onConsole;
    this.log = log;
    this.queues = { high: [], normal: [], low: [] };
    this.sentTimes = []; // моменты отправок в скользящем окне
    this.lastSentAt = -Infinity;
    this.lastSentText = null;
    this.duplicateCount = 0;
    this.isMod = false;
    this.connected = true;
    this.inFlight = false;
    this.seq = 0;
    this.stats = {
      enqueued: 0, sent: 0, dropped: 0, droppedBy: {}, failed: 0,
      byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, { enqueued: 0, sent: 0, dropped: 0 }])),
    };
  }

  get length() {
    return PRIORITIES.reduce((n, p) => n + this.queues[p].length, 0);
  }

  get limits() {
    return this.isMod ? this.config.limits.mod : this.config.limits.normal;
  }

  setMode(isMod) {
    if (this.isMod !== isMod) this.log.info(`очередь: режим лимитов ${isMod ? 'модератор' : 'обычный'}`);
    this.isMod = isMod;
  }

  setConnected(connected) {
    this.connected = connected;
    if (!connected) this.prune();
  }

  // message: { text, to: 'chat' | 'console' | 'whisper', priority, replyToMessageId? }
  enqueue(message) {
    const { text, to = 'chat', replyToMessageId } = message;
    const priority = PRIORITIES.includes(message.priority) ? message.priority : 'normal';
    if (!text) return;
    if (to === 'console') {
      this.onConsole(text);
      return;
    }
    if (to === 'whisper' && !this.config.whisperFallbackToChat) {
      this.log.info(`очередь: whisper не поддерживается, только в лог: ${text.slice(0, 120)}`);
      return;
    }
    for (const part of splitMessage(text)) {
      this.queues[priority].push({ id: ++this.seq, text: part, priority, enqueuedAt: this.now(), attempts: 0, notBefore: 0, replyToMessageId });
      this.stats.enqueued++;
      this.stats.byPriority[priority].enqueued++;
    }
    this.prune();
  }

  drop(item, reason) {
    this.stats.dropped++;
    this.stats.droppedBy[reason] = (this.stats.droppedBy[reason] ?? 0) + 1;
    this.stats.byPriority[item.priority].dropped++;
    this.log.warn(`очередь: удалено (${reason}, ${item.priority}): ${item.text.slice(0, 80)}`);
  }

  // Удаляет устаревшее и лишнее. high при перегрузке не удаляются никогда.
  prune() {
    const t = this.now();
    const keep = (list, pred, reason) => list.filter((item) => {
      if (pred(item)) return true;
      this.drop(item, reason);
      return false;
    });

    // low старше lowMaxAgeSeconds
    this.queues.low = keep(this.queues.low, (i) => t - i.enqueuedAt <= this.config.lowMaxAgeSeconds * 1000, 'low_age');

    // Без связи: low не держим, high и normal — не старше holdSeconds.
    if (!this.connected) {
      this.queues.low = keep(this.queues.low, () => false, 'offline');
      for (const p of ['high', 'normal']) {
        this.queues[p] = keep(this.queues[p], (i) => t - i.enqueuedAt <= this.config.holdSeconds * 1000, 'offline_age');
      }
    }

    // Переполнение: сначала самые старые low, затем самые старые normal.
    for (const p of ['low', 'normal']) {
      while (this.length > this.config.queueMax && this.queues[p].length > 0) {
        this.drop(this.queues[p].shift(), 'overflow');
      }
    }
  }

  // Можно ли отправить ещё одно сообщение прямо сейчас (окно и минимальный интервал).
  canSendNow() {
    const t = this.now();
    const windowMs = this.config.windowSeconds * 1000;
    while (this.sentTimes.length && this.sentTimes[0] <= t - windowMs) this.sentTimes.shift();
    return this.sentTimes.length < this.limits.perWindow && t - this.lastSentAt >= this.limits.minIntervalMs;
  }

  nextItem() {
    const t = this.now();
    for (const p of PRIORITIES) {
      const i = this.queues[p].findIndex((item) => item.notBefore <= t);
      if (i >= 0) return { p, i, item: this.queues[p][i] };
    }
    return null;
  }

  // Твич не принимает повтор последнего сообщения 30 с: меняем текст « ·2», « ·3» …
  dedupeText(text) {
    const t = this.now();
    const base = text;
    if (this.lastSentText !== null && t - this.lastSentAt < DUPLICATE_WINDOW_MS && this.lastBase === base) {
      this.duplicateCount++;
      const suffix = ` ·${this.duplicateCount + 1}`;
      return base.slice(0, MAX_LEN - suffix.length) + suffix;
    }
    this.duplicateCount = 0;
    return base;
  }

  // Отправляет не больше одного сообщения. Возвращает true, если что-то ушло.
  async pump() {
    this.prune();
    if (this.inFlight || !this.connected || !this.canSendNow()) return false;
    const next = this.nextItem();
    if (!next) return false;
    const { p, i, item } = next;
    this.queues[p].splice(i, 1);

    const text = this.dedupeText(item.text);
    const t = this.now();
    this.inFlight = true;
    this.sentTimes.push(t);
    this.lastSentAt = t;
    try {
      await this.send(text, { replyToMessageId: item.replyToMessageId, priority: item.priority });
      this.lastSentText = text;
      this.lastBase = item.text;
      this.stats.sent++;
      this.stats.byPriority[item.priority].sent++;
      return true;
    } catch (err) {
      this.stats.failed++;
      if (item.attempts === 0) {
        item.attempts = 1;
        item.notBefore = this.now() + this.config.retryDelayMs;
        this.queues[p].unshift(item); // одна повторная попытка через retryDelayMs
        this.log.warn(`очередь: ошибка отправки (${err?.message ?? err}), повтор через ${this.config.retryDelayMs} мс`);
      } else {
        this.drop(item, 'send_failed');
        this.log.error(`очередь: не удалось отправить после повтора: ${err?.message ?? err}`);
      }
      return false;
    } finally {
      this.inFlight = false;
    }
  }

  // Завершение работы: отправить high, пока позволяют лимиты, не дольше deadline.
  // sleep(ms) — внедряемое ожидание (в тестах — сдвиг фейковых часов).
  async flushHigh({ timeoutMs, sleep }) {
    const until = this.now() + timeoutMs;
    while (this.queues.high.length > 0 && this.now() < until && this.connected) {
      const sent = await this.pump();
      if (!sent) await sleep(50);
    }
    return this.queues.high.length;
  }
}
