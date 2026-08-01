// Чистая логика расчёта темпа. Без DOM и без сети — чтобы гонять под node.

// "1:22.251" → 82.251, "58.4" → 58.4, мусор → null.
export function parseLapTime(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (parseInt(m[1], 10) || 0) * 60 + parseFloat(m[2]);
}

// Что именно сравниваем. Сумма трёх секторов совпадает с временем круга бит
// в бит (проверено на 1408 кругах), но режим 'lap' всё равно берёт готовое
// время: оно есть и там, где отдельный сектор потерялся.
export const METRICS = {
  lap: { label: 'весь круг', parts: null },
  s1: { label: 'сектор 1', parts: ['s1'] },
  s2: { label: 'сектор 2', parts: ['s2'] },
  s3: { label: 'сектор 3', parts: ['s3'] },
  s12: { label: 'S1 + S2', parts: ['s1', 's2'] },
  s23: { label: 'S2 + S3', parts: ['s2', 's3'] },
  s13: { label: 'S1 + S3', parts: ['s1', 's3'] },
};

// Значение круга по выбранной метрике. Круг без нужного сектора возвращает
// null и в расчёт не идёт — занулять его было бы враньём.
export function lapValue(entry, metric = 'lap') {
  if (!entry) return null;
  const parts = METRICS[metric]?.parts;
  if (!parts) return entry.t ?? null;
  let sum = 0;
  for (const p of parts) {
    const v = entry[p];
    if (v == null) return null;
    sum += v;
  }
  return sum;
}

export function median(values) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Помечает круги, которые не идут в темп по умолчанию.
// Флаг: null | 'LAP1' | 'PIT' | 'OUT' | 'SC' | 'VSC'
//
// SC/VSC приходят готовыми из судейской (race.sc) — раньше это была эвристика
// по медиане круга, теперь настоящие данные.
// manualSC — Map<круг, 'SC' | false>: ручная пометка. Порядок проверок ниже
// даёт нужный приоритет: PIT и OUT сильнее SC, то есть ручная пометка
// перекрывает время круга, но не пит-метки.
export function flagLaps(race, { manualSC = null } = {}) {
  const track = new Map(race.sc || []);
  if (manualSC) {
    for (const [lap, on] of manualSC) {
      if (on) track.set(lap, typeof on === 'string' ? on : 'SC');
      else track.delete(lap);
    }
  }

  const flags = new Map();
  for (const [driverId, byLapEntry] of race.laps) {
    const pits = race.pits.get(driverId) || new Set();
    const byLap = new Map();
    for (const lap of byLapEntry.keys()) {
      let flag = null;
      if (lap === 1) flag = 'LAP1';
      else if (pits.has(lap)) flag = 'PIT';
      else if (pits.has(lap - 1)) flag = 'OUT';
      else if (track.has(lap)) flag = track.get(lap);
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
// превратилось бы в «1:60.000». Меньше минуты печатаем без минут: сектор
// в виде «0:29.832» читается плохо.
export function formatLapTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const ms = Math.round(sec * 1000);
  if (ms < 60000) return (ms / 1000).toFixed(3);
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

// Темп = среднее выбранных кругов, но круги медленнее личной медианы
// более чем в paceThreshold раз выбрасываются (SC-заезды, ошибки, трафик).
export function computePace(
  race,
  flags,
  { selected, overrides, paceThreshold = 1.02, range = null, metric = 'lap' },
) {
  const rows = new Map();

  for (const driverId of selected) {
    const byLap = race.laps.get(driverId);
    const used = [];
    if (byLap) {
      for (const [lap, entry] of byLap) {
        if (!isIncluded(driverId, lap, flags, overrides, range)) continue;
        const v = lapValue(entry, metric);
        if (v != null) used.push([lap, v]); // круг без нужного сектора пропускаем
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
