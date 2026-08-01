// Данные покруговок из Jolpica API (преемник Ergast).
// Тот же источник и та же схема пагинации, что в соседнем проекте f1points.
import { parseLapTime } from './pace.js';

const BASE = 'https://api.jolpi.ca/ergast/f1';
const PAGE = 100; // Jolpica режет limit до 100, больше не просить
const BURST = 2; // параллельных запросов за раз — Jolpica отдаёт 429 уже на трёх
const RETRIES = 5;

const cache = new Map(); // `${year}:${round}` → гонка, чтобы не тянуть 12 страниц заново

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, attempt = 0) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  // Лимит запросов Jolpica отдаётся без Retry-After и без счётчиков, так что
  // ждём сами, удваивая паузу. Проверено: 429 прилетает на всплеске и проходит.
  if (res.status === 429 && attempt < RETRIES) {
    await sleep(500 * 2 ** attempt);
    return getJSON(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Jolpica API ответил ${res.status}`);
  return (await res.json()).MRData;
}

// Проходит все страницы эндпоинта и отдаёт каждую пачку в onPage.
async function paged(path, onPage, onProgress) {
  const first = await getJSON(`${BASE}/${path}/?limit=${PAGE}&offset=0`);
  const total = parseInt(first.total, 10) || 0;
  const take = (mr) => {
    const race = mr.RaceTable?.Races?.[0];
    if (race) onPage(race);
  };
  take(first);

  const offsets = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);

  for (let i = 0; i < offsets.length; i += BURST) {
    const chunk = offsets.slice(i, i + BURST);
    const pages = await Promise.all(
      chunk.map((o) => getJSON(`${BASE}/${path}/?limit=${PAGE}&offset=${o}`)),
    );
    pages.forEach(take);
    if (onProgress) {
      onProgress(Math.min(100, Math.round(((i + chunk.length) * PAGE * 100) / total)));
    }
  }
  return first;
}

export async function fetchSeasonRaces(year) {
  const mr = await getJSON(`${BASE}/${year}/races/?limit=${PAGE}`);
  return (mr.RaceTable?.Races || []).map((r) => ({
    round: parseInt(r.round, 10),
    raceName: r.raceName,
    date: r.date,
  }));
}

export async function fetchRace(year, round, onProgress) {
  const cacheKey = `${year}:${round}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const say = (msg) => onProgress && onProgress(msg);

  say('Загружаю состав и пит-стопы…');
  const drivers = [];
  const pits = new Map();
  const [resultsRace] = await Promise.all([
    paged(`${year}/${round}/results`, (race) => {
      for (const r of race.Results || []) {
        drivers.push({
          driverId: r.Driver.driverId,
          code: r.Driver.code || r.Driver.familyName.slice(0, 3).toUpperCase(),
          name: `${r.Driver.givenName} ${r.Driver.familyName}`,
          team: r.Constructor?.name || '',
          constructorId: r.Constructor?.constructorId || '',
          number: parseInt(r.number, 10), // стыковка с OpenF1 по номеру машины
          position: parseInt(r.position, 10) || 999,
          status: r.status || '',
        });
      }
    }),
    paged(`${year}/${round}/pitstops`, (race) => {
      for (const p of race.PitStops || []) {
        const lap = parseInt(p.lap, 10);
        if (!pits.has(p.driverId)) pits.set(p.driverId, new Set());
        pits.get(p.driverId).add(lap);
      }
    }),
  ]);

  say('Загружаю покруговку…');
  const times = new Map();
  let lapCount = 0;
  await paged(
    `${year}/${round}/laps`,
    (race) => {
      for (const l of race.Laps || []) {
        const lap = parseInt(l.number, 10);
        if (lap > lapCount) lapCount = lap;
        for (const t of l.Timings || []) {
          const sec = parseLapTime(t.time);
          if (sec == null) continue;
          if (!times.has(t.driverId)) times.set(t.driverId, new Map());
          times.get(t.driverId).set(lap, sec);
        }
      }
    },
    (pct) => say(`Загружаю покруговку… ${pct}%`),
  );

  if (!times.size) throw new Error('Для этой гонки покруговка недоступна');

  drivers.sort((a, b) => a.position - b.position);
  // Круги приходят страницами вразнобой — сортируем, порядок важен для рендера.
  for (const [id, byLap] of times) {
    times.set(id, new Map([...byLap].sort((a, b) => a[0] - b[0])));
  }

  const meta = resultsRace?.RaceTable?.Races?.[0];
  const race = {
    season: year,
    round,
    date: meta?.date || '', // по ней ищем сессию в OpenF1 для составов резины
    raceName: meta?.raceName || `Round ${round}`,
    drivers,
    lapCount,
    times,
    pits,
  };
  cache.set(cacheKey, race);
  say('');
  return race;
}
