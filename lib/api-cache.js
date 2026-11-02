const { query } = require('./db');
const log = require('./logger');

/**
 * Возвращает закешированный результат вызова внешнего API
 * или выполняет fetcher и кеширует результат.
 *
 * @param {string} key - Уникальный ключ вызова (например, 'elevation:55.7:37.6')
 * @param {string} provider - Имя провайдера ('opentopodata', 'open-meteo', 'openrouter')
 * @param {() => Promise<any>} fetcher - Функция, которая делает реальный запрос
 * @returns {Promise<any>} - Результат из кеша или свежий
 */
async function getOrFetch(key, provider, fetcher) {
  const { rows } = await query(
    'SELECT result FROM external_api_calls WHERE key = $1',
    [key]
  );

  if (rows[0]) {
    log.debug('cache hit', { key, provider });
    return rows[0].result;
  }

  log.debug('cache miss, calling API', { key, provider });

  const result = await fetcher();

  await query(
    `INSERT INTO external_api_calls (key, provider, result)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [key, provider, result]
  );

  return result;
}

function elevationKey(lat, lon, precision = 3) {
  return `elevation:${lat.toFixed(precision)}:${lon.toFixed(precision)}`;
}

module.exports = { getOrFetch, elevationKey };