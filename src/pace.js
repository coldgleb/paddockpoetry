// Чистая логика расчёта темпа. Без DOM и без сети — чтобы гонять под node.

// "1:22.251" → 82.251, "58.4" → 58.4, мусор → null.
export function parseLapTime(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (parseInt(m[1], 10) || 0) * 60 + parseFloat(m[2]);
}

export function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Помечает круги, которые не идут в темп по умолчанию.
// Флаг: null | 'LAP1' | 'PIT' | 'OUT' | 'SC'
export function flagLaps(race, { scThreshold = 1.15 } = {}) {
  // Медиана каждого круга по всем пилотам — общая для всех медленная,
  // значит на трассе SC/VSC, а не проблемы конкретного пилота.
  // ponytail: SC определяется эвристикой по медиане круга; Jolpica не отдаёт
  // статус трассы. Нужна точность — OpenF1 /race_control (только с 2023).
  const lapMedians = new Map();
  for (let lap = 1; lap <= race.lapCount; lap++) {
    const times = [];
    for (const t of race.times.values()) {
      const v = t.get(lap);
      if (v != null) times.push(v);
    }
    if (times.length) lapMedians.set(lap, median(times));
  }
  const baseline = median([...lapMedians.values()]);
  const scLaps = new Set();
  if (baseline != null) {
    for (const [lap, m] of lapMedians) {
      if (m > baseline * scThreshold) scLaps.add(lap);
    }
  }

  const flags = new Map();
  for (const [driverId, times] of race.times) {
    const pits = race.pits.get(driverId) || new Set();
    const byLap = new Map();
    for (const lap of times.keys()) {
      let flag = null;
      if (lap === 1) flag = 'LAP1';
      else if (pits.has(lap)) flag = 'PIT';
      else if (pits.has(lap - 1)) flag = 'OUT';
      else if (scLaps.has(lap)) flag = 'SC';
      if (flag) byLap.set(lap, flag);
    }
    flags.set(driverId, byLap);
  }
  return flags;
}

export const key = (driverId, lap) => `${driverId}:${lap}`;

// Диапазон кругов «с X по Y»; null — без ограничения.
export const inRange = (lap, range) => !range || (lap >= range.from && lap <= range.to);

// Что попадает в темп по умолчанию: круг без флага и внутри диапазона.
// Ручной клик по кругу перекрывает и то, и другое.
export const autoIncluded = (driverId, lap, flags, range) =>
  !flags.get(driverId)?.get(lap) && inRange(lap, range);

// Диапазон — жёсткий фильтр, сильнее ручного клика: круги вне него в таблице
// не показываются, и оставить их в расчёте было бы нечем отменить.
export function isIncluded(driverId, lap, flags, overrides, range) {
  if (!inRange(lap, range)) return false;
  const k = key(driverId, lap);
  if (overrides.has(k)) return overrides.get(k);
  return !flags.get(driverId)?.get(lap);
}

// Секунды → «1:23.456». Округляем до миллисекунд до деления, иначе 119.9995
// превратилось бы в «1:60.000».
export function formatLapTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const ms = Math.round(sec * 1000);
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

// Темп = среднее выбранных кругов, но круги медленнее личной медианы
// более чем в paceThreshold раз выбрасываются (SC-заезды, ошибки, трафик).
export function computePace(race, flags, { selected, overrides, paceThreshold = 1.07, range = null }) {
  const rows = new Map();

  for (const driverId of selected) {
    const times = race.times.get(driverId);
    const used = [];
    if (times) {
      for (const [lap, v] of times) {
        if (isIncluded(driverId, lap, flags, overrides, range)) used.push([lap, v]);
      }
    }
    const med = median(used.map(([, v]) => v));
    const dropped = new Set();
    // points — ровно те круги, что легли в темп. График рисуется из них,
    // поэтому он не может разойтись с числом в шапке.
    const points = [];
    for (const [lap, v] of used) {
      if (med != null && v > med * paceThreshold) dropped.add(lap);
      else points.push([lap, v]);
    }
    const pace = points.length
      ? points.reduce((a, [, v]) => a + v, 0) / points.length
      : null;
    rows.set(driverId, { pace, diff: null, best: false, usedLaps: points.length, dropped, points });
  }

  const paces = [...rows.values()].map((r) => r.pace).filter((p) => p != null);
  const bestPace = paces.length ? Math.min(...paces) : null;
  for (const r of rows.values()) {
    if (r.pace == null || bestPace == null) continue;
    r.diff = r.pace - bestPace;
    r.best = r.pace === bestPace;
  }
  return rows;
}
