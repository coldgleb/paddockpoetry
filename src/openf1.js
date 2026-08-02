// OpenF1 — дополнение к Jolpica: секторы, составы резины и судейская.
// Целые круги отсюда не берём: замерено, что OpenF1 теряет записи (в
// Венгрии-2026 нет 40-го круга у четырёх пилотов) и отдаёт их в 10–20 раз
// медленнее. Покрытие — с 2023 года.
import { expandStints } from './tyres.js';

const BASE = 'https://api.openf1.org/v1';
// Отдельные запросы иногда застревают на десятки секунд, а повтор проходит
// быстро. Поэтому короткий таймаут и повторы, а не долгое ожидание.
const TIMEOUT = 15000;
const RETRIES = 3;
export const FIRST_YEAR = 2023;

const sessionCache = new Map(); // `${year}:${date}` → session_key | null
const extrasCache = new Map(); // session_key → { sc, tyres }
const sectorCache = new Map(); // `${session_key}:${номер}` → Map<lap, секторы>

async function getJSON(url) {
  let last;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`OpenF1 ответил ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('OpenF1 вернул не список');
      return data;
    } catch (e) {
      last = e;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last;
}

// --- машина безопасности ---------------------------------------------------

// Сообщения судейской в отрезки кругов. DEPLOYED открывает, ENDING и
// «IN THIS LAP» закрывают. Штрафы «SAFETY CAR INFRINGEMENT» приходят
// категорией Other и сюда не попадают.
//
// Виртуальную записывают двумя способами — «VIRTUAL SAFETY CAR DEPLOYED» и
// сокращением «VSC DEPLOYED». Обе формы встречаются в реальных данных, и по
// одному слову VIRTUAL половина отрезков молча уезжала в обычные SC.
// «SAFETY CAR THROUGH THE PIT LANE» не открывает и не закрывает отрезок.
export function parseSafetyCar(messages) {
  const sc = new Map();
  const open = { SC: null, VSC: null };

  const sorted = [...messages]
    .filter((m) => m.category === 'SafetyCar' && m.lap_number != null)
    .sort((a, b) => a.lap_number - b.lap_number);

  for (const m of sorted) {
    const text = (m.message || '').toUpperCase();
    const kind = /\bVSC\b|VIRTUAL/.test(text) ? 'VSC' : 'SC';
    const lap = parseInt(m.lap_number, 10);
    if (!Number.isFinite(lap)) continue;

    if (text.includes('DEPLOYED')) {
      if (open[kind] == null) open[kind] = lap;
    } else if (text.includes('ENDING') || text.includes('IN THIS LAP')) {
      const from = open[kind] ?? lap;
      for (let l = from; l <= lap; l++) sc.set(l, kind);
      open[kind] = null;
    }
  }
  // Отрезок без закрывающего сообщения до конца гонки тянуть нельзя —
  // помечаем только круг объявления.
  for (const [kind, from] of Object.entries(open)) {
    if (from != null && !sc.has(from)) sc.set(from, kind);
  }
  return sc;
}

// --- поиск сессии ----------------------------------------------------------

// Гонки сводим по дате. Сверено на 2023, 2025 и 2026: 69 гонок, ни одного
// промаха, включая Лас-Вегас, который стартует за полночь по UTC.
export async function findSession(year, date) {
  if (Number(year) < FIRST_YEAR || !date) return null;
  const key = `${year}:${date}`;
  if (sessionCache.has(key)) return sessionCache.get(key);

  let found = null;
  try {
    const sessions = await getJSON(`${BASE}/sessions?year=${year}&session_name=Race`);
    const sameDay = sessions
      .filter((s) => s.date_start?.slice(0, 10) === date)
      .sort((a, b) => a.date_start.localeCompare(b.date_start));
    found = sameDay.length ? sameDay[sameDay.length - 1].session_key : null;
  } catch {
    found = null; // OpenF1 недоступен — гонка всё равно покажется, без резины
  }
  sessionCache.set(key, found);
  return found;
}

// --- резина и судейская ----------------------------------------------------

// Запросы не постраничные и не по пилотам, поэтому быстрые.
export async function fetchExtras(sessionKey) {
  if (!sessionKey) return { sc: new Map(), tyres: new Map(), colors: new Map() };
  if (extrasCache.has(sessionKey)) return extrasCache.get(sessionKey);

  const [stints, control, drivers] = await Promise.all([
    getJSON(`${BASE}/stints?session_key=${sessionKey}`).catch(() => []),
    getJSON(`${BASE}/race_control?session_key=${sessionKey}`).catch(() => []),
    getJSON(`${BASE}/drivers?session_key=${sessionKey}`).catch(() => []),
  ]);

  // Официальные цвета команд. Приходят шестью hex-цифрами без решётки —
  // проверено на 82 записях за 2023–2026: пропусков и другого формата нет.
  const colors = new Map();
  for (const d of drivers) {
    if (/^[0-9A-F]{6}$/i.test(d.team_colour || '')) colors.set(d.driver_number, `#${d.team_colour}`);
  }

  const extras = { sc: parseSafetyCar(control), tyres: expandStints(stints), colors };
  extrasCache.set(sessionKey, extras);
  return extras;
}

// --- секторы одного пилота -------------------------------------------------

// Тянем по одному пилоту и только по запросу: это и есть медленная часть.
export async function fetchDriverSectors(sessionKey, driverNumber) {
  const key = `${sessionKey}:${driverNumber}`;
  if (sectorCache.has(key)) return sectorCache.get(key);

  const rows = await getJSON(
    `${BASE}/laps?session_key=${sessionKey}&driver_number=${driverNumber}`,
  ).catch(() => []);

  const byLap = new Map();
  for (const l of rows) {
    const lap = parseInt(l.lap_number, 10);
    if (!Number.isFinite(lap)) continue;
    byLap.set(lap, {
      s1: l.duration_sector_1 ?? null,
      s2: l.duration_sector_2 ?? null,
      s3: l.duration_sector_3 ?? null,
    });
  }
  sectorCache.set(key, byLap);
  return byLap;
}
