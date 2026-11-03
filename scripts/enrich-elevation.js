const fs = require('fs/promises');
const path = require('path');
const { query, close } = require('../lib/db');
const log = require('../lib/logger');
const { getOrFetch, elevationKey } = require('../lib/api-cache');

// @turf/simplify и парсер polyline
const simplify = require('@turf/simplify').default;
const { feature } = require('@turf/helpers');
const polyline = require('@mapbox/polyline');

const FILES_ROOT = process.env.FILES_ROOT;
const OPENTOPO_URL = 'https://api.opentopodata.org/v1/srtm30m'; // или srtm30m
const BATCH_SIZE = 100;
const DELAY_MS = 1100; // 1 запрос в секунду + запас
const apiState = { callsCount: 0, limitReached: false, maxCalls: 1000 };

async function fetchElevation(lat, lon) {
    const key = elevationKey(lat, lon, 3); // ~100 м
    return getOrFetch(key, 'opentopodata', async () => {
        const url = `https://api.opentopodata.org/v1/srtm90m?locations=${lat},${lon}`;
        const res = await fetchWithRetry(url);
        const data = await res.json();
        return data.results[0]?.elevation ?? null;
    });
}

async function fetchElevationsBatch(points) {
    // 1. Ключи для всех точек
    const keys = points.map(([lat, lon]) => elevationKey(lat, lon, 3));

    // 2. Что уже в кеше
    const { rows } = await query(
        'SELECT key, result FROM external_api_calls WHERE key = ANY($1)',
        [keys]
    );
    const cache = new Map(rows.map((r) => [r.key, r.result]));

    // 3. Недостающие — запрашиваем
    const missing = [];
    for (let i = 0; i < points.length; i++) {
        if (!cache.has(keys[i])) {
            missing.push({ index: i, lat: points[i][0], lon: points[i][1], key: keys[i] });
        }
    }

    if (missing.length > 0) {
        // Батч из 100 точек максимум
        outerLoop: for (let i = 0; i < missing.length; i += 100) {
            if (apiState.callsCount >= apiState.maxCalls) {
                log.warn('OpenTopoData call limit reached', {
                    callsMade: apiState.callsCount,
                    limit: apiState.maxCalls,
                });
                apiState.limitReached = true;
                break outerLoop;
            }
            const batch = missing.slice(i, i + 100);
            apiState.callsCount++;
            const locations = batch.map((m) => `${m.lat},${m.lon}`).join('|');
            const url = `https://api.opentopodata.org/v1/srtm90m?locations=${locations}`;
            const res = await fetchWithRetry(url);
            const data = await res.json();

            // Сохраняем в кеш
            const inserts = batch.map((m, j) => ({
                key: m.key,
                result: data.results[j]?.elevation ?? null,
            }));

            for (const ins of inserts) {
                await query(
                    `INSERT INTO external_api_calls (key, provider, result)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO NOTHING`,
                    [ins.key, 'opentopodata', ins.result]
                );
            }

            // Соблюдаем лимит
            if (i + 100 < missing.length) await sleep(1100);

            for (const ins of inserts) {
                cache.set(ins.key, ins.result);
            }
        }
    }

    // 4. Собираем результат
    return points.map((_, i) => cache.get(keys[i]) ?? null);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Загружает GeoJSON-файл по stored_path.
 */
async function loadGeojsonFile(storedPath) {
    const fullPath = path.join(FILES_ROOT, storedPath);
    const raw = await fs.readFile(fullPath, 'utf-8');
    return JSON.parse(raw);
}

/**
 * Извлекает LineString из GeoJSON (Feature, FeatureCollection или сам LineString).
 */
function extractLineString(geojson) {
    if (geojson.type === 'LineString') return geojson;

    if (geojson.type === 'Feature' && geojson.geometry?.type === 'LineString') {
        return geojson.geometry;
    }

    if (geojson.type === 'FeatureCollection') {
        const feature = geojson.features.find((f) => f.geometry?.type === 'LineString');
        if (feature) return feature.geometry;
    }

    throw new Error('No LineString found in GeoJSON');
}

/**
 * Прореживает линию и возвращает массив [lat, lon].
 */
function simplifyRoute(lineString) {
    const simplified = simplify(feature(lineString), {
        tolerance: 0.0001, // ~10 метров; подбери под свои треки
        highQuality: true,
    });

    const coords = simplified.geometry.coordinates;
    // GeoJSON: [lon, lat], а для polyline и OpenTopoData — [lat, lon]
    return coords.map(([lon, lat]) => [lat, lon]);
}

/**
 * Кодирует координаты в Google Polyline.
 */
function encodePreviewPolyline(points) {
    return polyline.encode(points);
}

/**
 * Запрашивает высоты у Open Topo Data для батча точек.
 * Возвращает массив elevation (число или null) в том же порядке.
 */
async function fetchElevations(batch) {
    // Формат locations: lat,lon|lat,lon|...
    const locations = batch.map(([lat, lon]) => `${lat},${lon}`).join('|');

    const url = new URL(OPENTOPO_URL);
    url.searchParams.set('locations', locations);

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenTopoData failed (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    if (data.status !== 'OK') {
        throw new Error(`OpenTopoData status ${data.status}: ${data.error}`);
    }

    return data.results.map((r) => r.elevation);
}

/**
 * Считает статистику высот по массиву.
 */
function computeElevationStats(elevations) {
    const valid = elevations.filter((e) => typeof e === 'number' && !Number.isNaN(e));

    if (valid.length === 0) {
        return {
            elevation_gain_m: null,
            elevation_max_m: null,
            elevation_min_m: null,
        };
    }

    let gain = 0;
    for (let i = 1; i < valid.length; i++) {
        const diff = valid[i] - valid[i - 1];
        if (diff > 0) gain += diff; // только положительный набор
    }

    return {
        elevation_gain_m: Math.round(gain),
        elevation_max_m: Math.round(Math.max(...valid)),
        elevation_min_m: Math.round(Math.min(...valid)),
    };
}

async function main() {
    if (!FILES_ROOT) throw new Error('FILES_ROOT is not set');


    const PAGE_SIZE = 10;
    let lastId = 0;
    let totalProcessed = 0;

    while (!apiState.limitReached) {
        // 1. Берём маршруты, у которых нет elevation_gain_m или высот
        const { rows: routes } = await query(`
    SELECT id, geojson_file_id, preview_polyline
    FROM routes
    WHERE (elevation_gain_m IS NULL
       OR elevation_max_m IS NULL
       OR elevation_min_m IS NULL)
       AND id > $1
    ORDER BY id
    LIMIT $2
  `, [lastId, PAGE_SIZE]);

        log.info('routes to enrich', { count: routes.length });
        if (routes.length === 0) break;
        if (routes.length === 0) {
            log.info('nothing to do');
            return;
        }

        for (const route of routes) {
            if (apiState.limitReached) {
                log.warn('stopping route processing: API limit reached', {
                    callsMade: apiState.callsCount,
                    lastRouteId: route.id,
                });
                break;
            }
            lastId = route.id;
            totalProcessed++;

            try {
                let previewPolyline;
                let simplifiedPoints;

                if (route.preview_polyline) {
                    // 1a. Polyline уже есть — декодируем в [lat, lon]
                    previewPolyline = route.preview_polyline;
                    try {
                        simplifiedPoints = polyline.decode(previewPolyline);
                    } catch (e) {
                        log.warn('invalid preview_polyline, will regenerate', {
                            routeId: route.id,
                            err: e.message,
                        });
                        await query('UPDATE routes SET preview_polyline = NULL WHERE id = $1', [route.id]);
                        continue; // следующий запуск пересчитает
                    }

                    log.info('using existing preview_polyline', {
                        routeId: route.id,
                        points: simplifiedPoints.length,
                    });
                } else {
                    // 1b. Polyline нет — читаем GeoJSON, упрощаем, кодируем
                    const { rows: fileRows } = await query(
                        'SELECT stored_path FROM files WHERE id = $1',
                        [route.geojson_file_id]
                    );

                    if (!fileRows[0]) {
                        log.warn('geojson file not found in files table', {
                            routeId: route.id,
                            geojsonFileId: route.geojson_file_id,
                        });
                        continue;
                    }

                    const geojson = await loadGeojsonFile(fileRows[0].stored_path);
                    const lineString = extractLineString(geojson);

                    simplifiedPoints = simplifyRoute(lineString);
                    previewPolyline = encodePreviewPolyline(simplifiedPoints);

                    log.info('simplified route', {
                        routeId: route.id,
                        originalPoints: lineString.coordinates.length,
                        simplifiedPoints: simplifiedPoints.length,
                    });

                    // Сохраняем preview_polyline сразу
                    await query(
                        'UPDATE routes SET preview_polyline = $1 WHERE id = $2',
                        [previewPolyline, route.id]
                    );
                }

                // 2. Запрашиваем высоты батчами (по simplifiedPoints)
                const allElevations = await fetchElevationsBatch(simplifiedPoints);

                log.info('elevations fetched', {
                    routeId: route.id,
                    points: simplifiedPoints.length,
                    withElevation: allElevations.filter((e) => e !== null).length,
                });

                // 3. Считаем статистику и обновляем
                const stats = computeElevationStats(allElevations);

                await query(
                    `UPDATE routes
       SET elevation_gain_m = $1,
           elevation_max_m = $2,
           elevation_min_m = $3
       WHERE id = $4`,
                    [stats.elevation_gain_m, stats.elevation_max_m, stats.elevation_min_m, route.id]
                );

                log.info('route enriched', { routeId: route.id, ...stats });
            } catch (e) {
                log.error('failed to enrich route', {
                    routeId: route.id,
                    err: e.message,
                    stack: e.stack,
                });
            }
        }
    }
}

main()
    .catch((err) => {
        log.error('fatal', { err: err.message, stack: err.stack });
        process.exitCode = 1;
    })
    .finally(() => close());