// Покруговки из Jolpica API (преемник Ergast) — основной источник.
// Замерено на Венгрии-2026: вся гонка за 4.8 с против 40–99 с у OpenF1, и
// 1429 таймингов против 1423 — OpenF1 теряет круги (у ANT/LEC/HAM/PIA нет
// 40-го), Jolpica не теряет. Секторов Jolpica не отдаёт, за ними — в openf1.js.
import { parseLapTime } from './pace.js';

const BASE = 'https://api.jolpi.ca/ergast/f1';
const PAGE = 100; // Jolpica режет limit до 100, больше не просить
const BURST = 2; // параллельных запросов — на трёх прилетает 429
const RETRIES = 5;

const cache = new Map(); // `${year}:${round}` → гонка
const seasonCache = new Map(); // год → список гонок

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Кому рассказывать про ожидание. Ставится на время загрузки: 429 приходит
// молча, и без этого страница просто «висит» до пятнадцати секунд.
let notify = null;

async function getJSON(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    // Обрыв сети — тоже повод повторить, а не падать с первого раза.
    if (attempt >= RETRIES) throw new Error('Jolpica недоступна: ' + e.message);
    await sleep(500 * 2 ** attempt);
    return getJSON(url, attempt + 1);
  }
  // Лимит запросов Jolpica отдаётся без Retry-After и без счётчиков, так что
  // ждём сами, удваивая паузу. Порог — около шести запросов подряд, поэтому
  // после загрузки гонки (полтора десятка страниц) следующий запрос вполне
  // может в него попасть.
  if (res.status === 429 && attempt < RETRIES) {
    const wait = 500 * 2 ** attempt;
    notify?.(`Jolpica ограничивает частоту запросов — жду ${Math.round(wait / 1000) || 1} с…`);
    await sleep(wait);
    return getJSON(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Jolpica ответил ${res.status}`);
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

export async function fetchSeasonRaces(year, onProgress) {
  if (seasonCache.has(year)) return seasonCache.get(year);
  notify = onProgress;
  try {
    const mr = await getJSON(`${BASE}/${year}/races/?limit=${PAGE}`);
    const today = new Date().toISOString().slice(0, 10);
    const races = (mr.RaceTable?.Races || [])
      .filter((r) => r.date <= today) // будущие этапы без покруговки
      .map((r) => ({
        round: parseInt(r.round, 10),
        name: r.raceName,
        date: r.date,
      }));
    seasonCache.set(year, races); // лишний раз в лимит не упираемся
    return races;
  } finally {
    notify = null;
  }
}

export async function fetchRace(year, round, onProgress) {
  const cacheKey = `${year}:${round}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const say = (m) => onProgress && onProgress(m);
  notify = say; // про ожидание из-за лимита тоже рассказываем

  say('Загружаю состав и пит-стопы…');
  // Пилотов опознаём номером машины: это единственный ключ, общий с OpenF1,
  // откуда потом приезжают резина, судейская и секторы.
  const drivers = [];
  const byDriverId = new Map(); // driverId Jolpica → номер машины
  const pits = new Map();

  const [meta] = await Promise.all([
    paged(`${year}/${round}/results`, (race) => {
      for (const r of race.Results || []) {
        const id = parseInt(r.number, 10);
        if (!Number.isFinite(id)) continue;
        byDriverId.set(r.Driver.driverId, id);
        drivers.push({
          id,
          code: r.Driver.code || r.Driver.familyName.slice(0, 3).toUpperCase(),
          name: `${r.Driver.givenName} ${r.Driver.familyName}`,
          team: r.Constructor?.name || '',
          position: parseInt(r.position, 10) || 999,
          status: r.status || '',
        });
      }
    }),
    paged(`${year}/${round}/pitstops`, (race) => {
      for (const p of race.PitStops || []) {
        // Номера машин ещё могут быть не разобраны — складываем по driverId
        // и переведём ниже, когда состав точно готов.
        if (!pits.has(p.driverId)) pits.set(p.driverId, new Set());
        pits.get(p.driverId).add(parseInt(p.lap, 10));
      }
    }),
  ]);

  say('Загружаю покруговку…');
  const laps = new Map();
  let lapCount = 0;
  await paged(
    `${year}/${round}/laps`,
    (race) => {
      for (const l of race.Laps || []) {
        const lap = parseInt(l.number, 10);
        if (!Number.isFinite(lap)) continue;
        if (lap > lapCount) lapCount = lap;
        for (const t of l.Timings || []) {
          const sec = parseLapTime(t.time);
          const id = byDriverId.get(t.driverId);
          if (sec == null || id == null) continue;
          if (!laps.has(id)) laps.set(id, new Map());
          // Секторы дольются позже из OpenF1 прямо в этот же объект.
          laps.get(id).set(lap, { t: sec, s1: null, s2: null, s3: null });
        }
      }
    },
    (pct) => say(`Загружаю покруговку… ${pct}%`),
  );

  if (!laps.size) throw new Error('Для этой гонки покруговка недоступна');

  // Пит-стопы переводим на номера машин.
  const pitsByCar = new Map();
  for (const [driverId, set] of pits) {
    const id = byDriverId.get(driverId);
    if (id != null) pitsByCar.set(id, set);
  }

  // Круги приходят страницами вразнобой — порядок важен для рендера.
  for (const [id, byLap] of laps) {
    laps.set(id, new Map([...byLap].sort((a, b) => a[0] - b[0])));
  }
  drivers.sort((a, b) => a.position - b.position);

  const info = meta?.RaceTable?.Races?.[0];
  const race = {
    source: 'jolpica',
    season: Number(year),
    round: Number(round),
    date: info?.date || '',
    raceName: info?.raceName || `Этап ${round}`,
    drivers: drivers.filter((d) => laps.has(d.id)),
    lapCount,
    laps,
    pits: pitsByCar,
    sc: new Map(), // приедет из судейской OpenF1
    tyres: new Map(), // приедет из стинтов OpenF1
    sectorsFor: new Set(), // у кого секторы уже долиты
  };
  cache.set(cacheKey, race);
  notify = null;
  say('');
  return race;
}
