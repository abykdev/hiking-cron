// cron/lib/http.js
async function fetchWithRetry(url, options = {}, { retries = 3, timeoutMs = 30000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) return res;

      // 429 / 5xx — retry
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const delay = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // 4xx (кроме 429) — не retry, сразу ошибка
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        if (attempt < retries) continue; // timeout — retry
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      if (attempt < retries) continue;
      throw e;
    }
  }
}