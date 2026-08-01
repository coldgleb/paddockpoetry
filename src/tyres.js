// Типы резины из OpenF1: Jolpica составы не отдаёт вообще.
// Покрытие OpenF1 — с 2023 года. Для более ранних сезонов вернём null, и
// таблица просто отрисуется без резины: это не ошибка, а отсутствие данных.
const BASE = 'https://api.openf1.org/v1';
const FIRST_YEAR = 2023;

// Цвета Pirelli. Буква рядом с полосой обязательна: составы различаются
// в том числе белым и жёлтым, и на цвет одному полагаться нельзя.
export const COMPOUNDS = {
  SOFT: { color: '#DA291C', letter: 'S', name: 'софт' },
  MEDIUM: { color: '#FFD12E', letter: 'M', name: 'медиум' },
  HARD: { color: '#F0F0EC', letter: 'H', name: 'хард' },
  INTERMEDIATE: { color: '#43B02A', letter: 'I', name: 'интермедиат' },
  WET: { color: '#0067AD', letter: 'W', name: 'дождевая' },
  // OpenF1 иногда теряет состав стинта целиком. Показываем это явно: пустая
  // ячейка выглядит как поломка вёрстки, а «?» честно говорит «данных нет».
  UNKNOWN: { color: '#7C8494', letter: '?', name: 'состав неизвестен' },
};

// Стинты → круг за кругом. Границы у OpenF1 включительные, а стинт
// заканчивается кругом заезда в боксы — тем самым, что помечен PIT.
export function expandStints(stints) {
  const byDriver = new Map();
  for (const s of stints) {
    const from = parseInt(s.lap_start, 10);
    const to = parseInt(s.lap_end, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const compound = COMPOUNDS[s.compound] ? s.compound : 'UNKNOWN';
    if (!byDriver.has(s.driver_number)) byDriver.set(s.driver_number, new Map());
    const laps = byDriver.get(s.driver_number);
    for (let lap = from; lap <= to; lap++) laps.set(lap, compound);
  }
  return byDriver;
}

const cache = new Map(); // `${year}:${date}` → Map | null

// raceDate — дата гонки от Jolpica в UTC ('2026-07-26'). Сверено на сезонах
// 2023, 2025 и 2026: совпадает с date_start сессии у OpenF1 без единого
// промаха, включая Лас-Вегас, который стартует за полночь по UTC.
export async function fetchTyres(year, raceDate) {
  const key = `${year}:${raceDate}`;
  if (cache.has(key)) return cache.get(key);
  if (Number(year) < FIRST_YEAR) {
    cache.set(key, null);
    return null;
  }

  try {
    const sessions = await getJSON(`${BASE}/sessions?year=${year}&session_name=Race`);
    const sameDay = sessions.filter((s) => s.date_start?.slice(0, 10) === raceDate);
    if (!sameDay.length) throw new Error('сессия не найдена');
    // Если на дату пришлось несколько сессий — берём последнюю по времени.
    sameDay.sort((a, b) => a.date_start.localeCompare(b.date_start));
    const session = sameDay[sameDay.length - 1];

    const result = expandStints(await getJSON(`${BASE}/stints?session_key=${session.session_key}`));
    cache.set(key, result);
    return result;
  } catch {
    // Резина — необязательное украшение: её отсутствие не должно ронять гонку.
    cache.set(key, null);
    return null;
  }
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenF1 ответил ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('OpenF1 вернул не список');
  return data;
}
