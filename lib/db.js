const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,                     // cron-скриптам много не надо
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Логируем ошибки пула — иначе они «тихо» теряются
pool.on('error', (err) => {
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    msg: 'unexpected pg pool error',
    err: err.message,
  }));
});

/**
 * Выполняет SQL-запрос с параметрами.
 * @param {string} text - SQL
 * @param {any[]} [params] - параметры ($1, $2, ...)
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Возвращает клиента из пула (для транзакций).
 * НЕ ЗАБУДЬ release() в finally.
 */
async function getClient() {
  return pool.connect();
}

/**
 * Выполняет функцию в транзакции.
 * При ошибке — ROLLBACK, при успехе — COMMIT.
 *
 * @example
 * await transact(async (client) => {
 *   await client.query('INSERT ...');
 *   await client.query('UPDATE ...');
 * });
 */
async function transact(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Закрывает пул. Вызывать в конце скрипта.
 */
async function close() {
  await pool.end();
}

module.exports = { pool, query, getClient, transact, close };