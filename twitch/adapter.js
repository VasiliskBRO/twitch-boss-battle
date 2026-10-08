// Интерфейс TwitchAdapter (описание; реализации — TwurpleAdapter и FakeAdapter):
//
//   connect(): Promise<void>         — подключиться (повторный вызов переподключает)
//   disconnect(): Promise<void>
//   onMessage(cb)                    — cb(raw) на каждое сообщение чата (формат raw — в inbound.js)
//   onStatus(cb)                     — cb({ connected, error? }) при подключении и обрыве
//   onRolesChange(cb)                — cb(roles) при изменении ролей бота (модератор, VIP)
//   send(text, { replyToMessageId }) — отправить сообщение; при отказе Твича бросает ошибку
//   isConnected: boolean
//   selfRoles(): { broadcaster, moderator, vip }
//   selfUserId: string               — id аккаунта бота (его сообщения игнорируются)
//
// Весь код Twurple живёт только в twurple_adapter.js, чтобы библиотеку можно было заменить.

export const TWITCH_ADAPTER_METHODS = ['connect', 'disconnect', 'onMessage', 'onStatus', 'onRolesChange', 'send', 'selfRoles'];

export function assertAdapter(adapter) {
  for (const m of TWITCH_ADAPTER_METHODS) {
    if (typeof adapter[m] !== 'function') throw new Error(`Адаптер не реализует ${m}()`);
  }
  return adapter;
}
