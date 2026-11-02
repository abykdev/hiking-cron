/**
 * Простой JSON-логгер для cron-скриптов.
 * Формат: {"time":"...","level":"info","msg":"...", ...meta}
 *
 * Плюсы:
 * - systemd journal нормально собирает JSON
 * - `journalctl -o json` можно парсить
 * - не тянет pino/winston ради 3 скриптов
 */

function write(level, msg, meta = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };

  // console.log → stdout, console.error → stderr.
  // systemd разделит их в journal.
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  info:  (msg, meta) => write('info', msg, meta),
  warn:  (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),  // можно отключить через env
};