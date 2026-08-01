// Единственный источник данных — OpenF1. Покрытие с 2023 года.
// Заменил Jolpica: секторы всё равно есть только здесь, а пит-стопы,
// восстановленные из is_pit_out_lap, сошлись с Jolpica до последнего заезда.
import { expandStints } from './tyres.js';

const BASE = 'https://api.openf1.org/v1';
// Отдельные запросы к OpenF1 иногда застревают на десятки секунд, а повтор
// проходит быстро. Поэтому короткий таймаут и повторы, а не долгое ожидание.
const TIMEOUT = 15000;
const RETRIES = 3;
const BURST = 4; // пилотов за раз

const cache = new Map(); // sessionKey → гонка

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

// --- список гонок сезона ---------------------------------------------------

export async function fetchSeasonRaces(year) {
  const [sessions, meetings] = await Promise.all([
    getJSON(`${BASE}/sessions?year=${year}&session_name=Race`),
    getJSON(`${BASE}/meetings?year=${year}`),
  ]);
  const names = new Map(meetings.map((m) => [m.meeting_key, m.meeting_name]));
  const now = Date.now();
  return sessions
    // Будущие этапы отдавать нельзя: покруговки у них ещё нет.
    .filter((s) => Date.parse(s.date_start) < now)
    .sort((a, b) => a.date_start.localeCompare(b.date_start))
    .map((s, i) => ({
      round: i + 1,
      sessionKey: s.session_key,
      name: names.get(s.meeting_key) || s.circuit_short_name || `Этап ${i + 1}`,
      date: s.date_start.slice(0, 10),
    }));
}

// --- машина безопасности ---------------------------------------------------

// Сообщения судейской в отрезки кругов. DEPLOYED открывает, ENDING и
// «IN THIS LAP» закрывают. Штрафы «SAFETY CAR INFRINGEMENT» приходят
// категорией Other и сюда не попадают.
export function parseSafetyCar(messages) {
  const sc = new Map();
  const open = { SC: null, VSC: null };

  const sorted = [...messages]
    .filter((m) => m.category === 'SafetyCar' && m.lap_number != null)
    .sort((a, b) => a.lap_number - b.lap_number);

  for (const m of sorted) {
    const text = (m.message || '').toUpperCase();
    const kind = text.includes('VIRTUAL') ? 'VSC' : 'SC';
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
  // Отрезок без закрывающего сообщения — до конца гонки его тянуть нельзя,
  // помечаем только круг объявления.
  for (const [kind, from] of Object.entries(open)) {
    if (from != null && !sc.has(from)) sc.set(from, kind);
  }
  return sc;
}

// --- гонка -----------------------------------------------------------------

export async function fetchRace(sessionKey, onProgress) {
  if (cache.has(sessionKey)) return cache.get(sessionKey);
  const say = (m) => onProgress && onProgress(m);

  say('Загружаю состав…');
  const [sessions, drivers, results] = await Promise.all([
    getJSON(`${BASE}/sessions?session_key=${sessionKey}`),
    getJSON(`${BASE}/drivers?session_key=${sessionKey}`),
    getJSON(`${BASE}/session_result?session_key=${sessionKey}`).catch(() => []),
  ]);
  const session = sessions[0];
  if (!drivers.length) throw new Error('OpenF1 не отдал состав этой гонки');

  const byNumber = new Map(results.map((r) => [r.driver_number, r]));
  const roster = drivers.map((d) => {
    const r = byNumber.get(d.driver_number);
    return {
      id: d.driver_number,
      code: d.name_acronym || String(d.driver_number),
      name: d.full_name || d.broadcast_name || '',
      team: d.team_name || '',
      position: r?.position ?? 999,
      status: r?.dsq ? 'DSQ' : r?.dns ? 'DNS' : r?.dnf ? 'DNF' : 'Finished',
    };
  });
  roster.sort((a, b) => a.position - b.position);

  // Круги тянем по одному пилоту: ответ на всю сессию сразу API не отдаёт.
  const laps = new Map();
  const pits = new Map();
  let lapCount = 0;
  for (let i = 0; i < roster.length; i += BURST) {
    const chunk = roster.slice(i, i + BURST);
    const pages = await Promise.all(
      chunk.map((d) =>
        getJSON(`${BASE}/laps?session_key=${sessionKey}&driver_number=${d.id}`).catch(() => []),
      ),
    );
    chunk.forEach((d, k) => {
      const byLap = new Map();
      for (const l of pages[k]) {
        const lap = parseInt(l.lap_number, 10);
        if (!Number.isFinite(lap)) continue;
        if (lap > lapCount) lapCount = lap;
        // Круг заезда в боксы — тот, что перед выездом. Считаем отсюда, а не
        // из /pit: тот эндпоинт теряет заезды, проверено на Венгрии-2026.
        if (l.is_pit_out_lap && lap > 1) {
          if (!pits.has(d.id)) pits.set(d.id, new Set());
          pits.get(d.id).add(lap - 1);
        }
        if (l.lap_duration == null) continue;
        byLap.set(lap, {
          t: l.lap_duration,
          s1: l.duration_sector_1 ?? null,
          s2: l.duration_sector_2 ?? null,
          s3: l.duration_sector_3 ?? null,
        });
      }
      if (byLap.size) laps.set(d.id, byLap);
    });
    say(`Загружаю покруговку… ${Math.min(100, Math.round(((i + chunk.length) * 100) / roster.length))}%`);
  }

  if (!laps.size) throw new Error('Для этой гонки покруговка недоступна');

  say('Загружаю резину и судейскую…');
  const [stints, control, meetings] = await Promise.all([
    getJSON(`${BASE}/stints?session_key=${sessionKey}`).catch(() => []),
    getJSON(`${BASE}/race_control?session_key=${sessionKey}`).catch(() => []),
    // Человеческое название этапа лежит только в meetings, в сессии его нет.
    getJSON(`${BASE}/meetings?meeting_key=${session?.meeting_key}`).catch(() => []),
  ]);

  const race = {
    sessionKey,
    season: session?.year ?? new Date(session?.date_start || Date.now()).getFullYear(),
    date: session?.date_start?.slice(0, 10) || '',
    raceName: meetings[0]?.meeting_name || session?.location || 'Гонка',
    drivers: roster.filter((d) => laps.has(d.id)),
    lapCount,
    laps,
    pits,
    sc: parseSafetyCar(control),
    tyres: expandStints(stints),
  };
  cache.set(sessionKey, race);
  say('');
  return race;
}
