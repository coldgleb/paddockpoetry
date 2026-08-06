// Квалификации из f1api.dev — источник для вкладки сравнения сокомандников.
// В отличие от Jolpica здесь есть и то, чего там не хватало: полные времена без
// дыр (Майами-2025 на месте) и отдельно спринт-квалификации (sq1/sq2/sq3).
// Лимита частоты нет — восемь запросов подряд отдаются без 429, поэтому этапы
// тянем пачками, а не по одному.
const BASE = 'https://f1api.dev/api';
// f1api.dev небыстрый на запрос (секунды) и не любит много параллельных
// соединений — на дюжине начинаются таймауты подключения. Восемь — золотая
// середина: сезон грузится ~15 с вместо минуты, а до порога таймаутов далеко.
const CHUNK = 8;
const RETRIES = 3;

const teamsCache = new Map(); // год → список команд
const qualiCache = new Map(); // год → раунды с квалификациями

// Постоянный кэш в localStorage: данные f1api переживают перезагрузку и заходы.
// Прошлые сезоны неизменны — храним бессрочно; текущий ещё пополняется гонками,
// поэтому его держим недолго. Полный сброс — по Ctrl+F5 (см. purgeOnHardReload).
const LS_PREFIX = 'pp-f1api:';
const CUR_YEAR = new Date().getFullYear();
const CUR_TTL = 6 * 3600 * 1000; // 6 часов на текущий сезон

const lsGet = (key, year) => {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw);
    if (year >= CUR_YEAR && Date.now() - t > CUR_TTL) return null; // текущий сезон устарел
    return data;
  } catch {
    return null;
  }
};

const lsSet = (key, data) => {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch {
    // Приватный режим или переполнение — переживём без постоянного кэша.
  }
};

// Жёсткая перезагрузка (Ctrl+F5) чистит весь кэш f1api. Отличаем её от обычного
// F5 так: наш сервер отдаёт файлы с ETag, поэтому при F5 документ приходит как
// 304 (encodedBodySize === 0), а при Ctrl+F5 — полным ответом из сети (> 0).
(function purgeOnHardReload() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav || nav.type !== 'reload' || nav.encodedBodySize === 0) return;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // Нет performance/localStorage (например, под node) — просто пропускаем.
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`f1api ответил ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt >= RETRIES) throw new Error('f1api.dev недоступна: ' + e.message);
    await sleep(400 * 2 ** attempt);
    return getJSON(url, attempt + 1);
  }
}

// Время круга f1api → секунды. Формат непостоянен между сезонами: 2025 отдаёт
// «1:29.179» (точка), а 2024 — «1:29:179» (двоеточие вместо точки). Разбираем
// по любым разделителям: последняя группа — доли секунды (по числу её цифр),
// перед ней — секунды, а если есть третья группа — минуты. «75.096» → 75.096.
function toSeconds(t) {
  if (typeof t !== 'string') return null;
  const parts = t.trim().split(/[:.]/);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const frac = parts.pop();
  const sec = Number(parts.pop());
  const min = parts.length ? Number(parts.pop()) : 0;
  return min * 60 + sec + Number(frac) / 10 ** frac.length;
}

// Строки результатов f1api → наш единый вид с Q1/Q2/Q3 в секундах. Спринт-
// квалификация приходит в полях sq1/sq2/sq3 — раскладываем их в те же Q1/Q2/Q3,
// чтобы вся дальнейшая логика (общая сессия, лучший круг) работала одинаково.
function mapResults(list, prefix) {
  return (list || []).map((q) => ({
    driverId: q.driverId,
    code: q.driver?.shortName || (q.driverId || '').slice(0, 3).toUpperCase(),
    number: q.driver?.number ?? 999,
    constructorId: q.teamId,
    team: q.team?.teamName || q.teamId || '',
    Q1: toSeconds(q[`${prefix}1`]),
    Q2: toSeconds(q[`${prefix}2`]),
    Q3: toSeconds(q[`${prefix}3`]),
  }));
}

// Команды сезона — для выбора во вкладке. teamId совпадает с constructorId в
// результатах и с ключами палитры (см. teamColorById в teams.js).
export async function fetchSeasonTeams(year) {
  if (teamsCache.has(year)) return teamsCache.get(year);
  const stored = lsGet(`teams:${year}`, year);
  if (stored) {
    teamsCache.set(year, stored);
    return stored;
  }
  const mr = await getJSON(`${BASE}/${year}/teams`);
  const teams = (mr.teams || [])
    .map((t) => ({ id: t.teamId, name: t.teamName }))
    .sort((a, b) => a.name.localeCompare(b.name));
  teamsCache.set(year, teams);
  lsSet(`teams:${year}`, teams);
  return teams;
}

// Квалификации всего сезона. На спринт-уикендах докладываем спринт-квалификацию
// в sprintResults. onRound вызывается по мере готовности этапов (пачками, но в
// порядке календаря) — таблица наполняется на глазах.
export async function fetchSeasonQualifying(year, onProgress, onRound) {
  if (qualiCache.has(year)) return qualiCache.get(year);
  const stored = lsGet(`quali:${year}`, year);
  if (stored) {
    qualiCache.set(year, stored);
    return stored;
  }

  const seasonMr = await getJSON(`${BASE}/${year}`);
  const today = new Date().toISOString().slice(0, 10);
  const rounds = (seasonMr.races || [])
    // Только этапы, что уже прошли, — у будущих квалификации ещё нет. У старых
    // сезонов (2020 и раньше) даты квалификации в f1api нет, поэтому берём дату
    // квалы, а если её нет — дату гонки.
    .filter((r) => {
      const date = r.schedule?.qualy?.date || r.schedule?.race?.date;
      return date && date <= today;
    })
    .map((r) => ({
      round: parseInt(r.round, 10),
      name: r.raceName,
      circuitId: r.circuit?.circuitId || '',
      country: r.circuit?.country || '',
      sprint: !!r.schedule?.sprintQualy?.date,
      results: null,
      sprintResults: null,
    }));

  for (let i = 0; i < rounds.length; i += CHUNK) {
    const chunk = rounds.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (r) => {
        try {
          const mr = await getJSON(`${BASE}/${year}/${r.round}/qualy`);
          r.results = mapResults(mr.races?.qualyResults, 'q');
        } catch {
          r.results = []; // этап не отдался — пропустим его, не роняя весь сезон
        }
        // Спринт-квалификация есть только с 2023-го; где её нет (или f1api
        // отдаёт 404) — просто без ряда SPR, но сезон грузится дальше.
        if (r.sprint) {
          try {
            const sm = await getJSON(`${BASE}/${year}/${r.round}/sprint/qualy`);
            r.sprintResults = mapResults(sm.races?.sprintQualyResults, 'sq');
          } catch {
            r.sprintResults = null;
          }
        }
      }),
    );
    // Отдаём в порядке календаря, чтобы ряды не прыгали.
    for (const r of chunk) if (r.results?.length) onRound?.(r);
    onProgress?.(
      `Загружаю квалификации… ${Math.round((Math.min(i + CHUNK, rounds.length) * 100) / rounds.length)}%`,
    );
  }

  const withQ = rounds.filter((r) => r.results?.length);
  // Пустой результат не кэшируем — иначе повторное «Загрузить» вернуло бы ту же
  // пустоту и не дало бы шанса перезапросить.
  if (withQ.length) {
    qualiCache.set(year, withQ);
    lsSet(`quali:${year}`, withQ);
  }
  return withQ;
}
