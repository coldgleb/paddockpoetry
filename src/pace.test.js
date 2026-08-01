// Self-check: node src/pace.test.js
import assert from 'node:assert/strict';
import { parseLapTime, median, flagLaps, computePace, isIncluded, key } from './pace.js';

// Референс-таблица пользователя, круги 1..21. Времена круга 1 и пит-кругов
// проставлены правдоподобно: Jolpica всегда отдаёт время, даже на заезде в боксы.
const REF = {
  NOR: [93.412, 82.251, 82.422, 82.773, 83.287, 83.226, 83.357, 83.392, 83.501, 83.319,
        83.401, 83.618, 102.400, 87.200, 82.070, 82.193, 81.944, 81.981, 82.354, 82.243, 82.375],
  PIA: [93.988, 82.673, 82.940, 83.054, 83.242, 83.298, 83.569, 85.507, 84.548, 84.401,
        84.097, 84.117, 83.999, 103.100, 102.741, 82.541, 82.229, 82.269, 82.262, 82.449, 82.858],
  LEC: [93.700, 82.883, 82.650, 82.914, 83.063, 83.835, 83.102, 83.402, 83.561, 83.800,
        84.178, 84.300, 83.510, 83.996, 84.039, 103.900, 87.500, 82.198, 81.985, 81.753, 81.589],
  HAM: [93.100, 81.710, 82.070, 82.579, 82.302, 82.890, 82.937, 83.351, 83.462, 83.576,
        102.200, 86.900, 81.433, 82.075, 81.911, 82.151, 82.001, 82.165, 82.464, 82.618, 82.728],
};
const PITS = { NOR: [13], PIA: [14], LEC: [16], HAM: [11] };

function makeRace(laps, pitLaps) {
  const times = new Map();
  let lapCount = 0;
  for (const [id, arr] of Object.entries(laps)) {
    const byLap = new Map();
    arr.forEach((t, i) => t != null && byLap.set(i + 1, t));
    times.set(id, byLap);
    lapCount = Math.max(lapCount, arr.length);
  }
  const pits = new Map(Object.entries(pitLaps).map(([id, ls]) => [id, new Set(ls)]));
  return { lapCount, times, pits };
}

const race = makeRace(REF, PITS);
const flags = flagLaps(race);
const ALL = ['NOR', 'PIA', 'LEC', 'HAM'];
const run = (opts = {}) =>
  computePace(race, flags, { selected: ALL, overrides: new Map(), paceThreshold: 1.07, ...opts });

// --- парсинг времени -------------------------------------------------------
assert.equal(parseLapTime('1:22.251'), 82.251);
assert.equal(parseLapTime('1:42.741'), 102.741);
assert.equal(parseLapTime('58.4'), 58.4);
assert.equal(parseLapTime('2:00'), 120);
assert.equal(parseLapTime(''), null);
assert.equal(parseLapTime('PIT'), null);
assert.equal(parseLapTime(undefined), null);
assert.equal(median([]), null);
assert.equal(median([3, 1, 2]), 2);
assert.equal(median([4, 1, 3, 2]), 2.5);

// --- флаги: PIT на круге заезда, OUT на следующем --------------------------
assert.equal(flags.get('NOR').get(1), 'LAP1');
assert.equal(flags.get('NOR').get(13), 'PIT');
assert.equal(flags.get('NOR').get(14), 'OUT');
assert.equal(flags.get('NOR').get(15), undefined, 'круг после OUT уже чистый');
assert.equal(flags.get('HAM').get(11), 'PIT');
assert.equal(flags.get('HAM').get(12), 'OUT');
assert.equal(flags.get('LEC').get(16), 'PIT');
assert.equal(flags.get('LEC').get(17), 'OUT');
// Медленный круг одного пилота — не SC: медиана круга по всем осталась нормальной.
assert.equal(flags.get('PIA').get(15), 'OUT');
assert.equal(flags.get('NOR').get(12), undefined);

// --- SC определяется по медиане круга у всех сразу -------------------------
const scRace = makeRace(
  {
    A: [95, 90, 90, 90, 140, 141, 90, 90, 90, 90],
    B: [95, 91, 90, 91, 142, 140, 91, 90, 91, 90],
    C: [96, 90, 91, 90, 141, 142, 90, 91, 90, 91],
  },
  { A: [], B: [], C: [] },
);
const scFlags = flagLaps(scRace);
assert.equal(scFlags.get('A').get(5), 'SC');
assert.equal(scFlags.get('B').get(6), 'SC');
assert.equal(scFlags.get('C').get(7), undefined, 'обычный круг не помечается SC');
assert.equal(scFlags.get('A').get(1), 'LAP1', 'старт важнее SC');

// --- темп по умолчанию: круг 1, PIT и OUT не участвуют ---------------------
const base = run();
assert.equal(base.get('NOR').usedLaps, 18, '21 круг минус старт, PIT и OUT');
assert.equal(base.get('PIA').usedLaps, 18);
assert.ok(Math.abs(base.get('NOR').pace - 82.7615) < 0.001);
assert.ok(Math.abs(base.get('HAM').pace - 82.46794) < 0.001);
assert.equal(base.get('NOR').dropped.size, 0, 'у NOR ровный темп, выбросов нет');

// --- diff считается от лучшего, лучший получает 0 --------------------------
assert.equal(base.get('HAM').best, true);
assert.equal(base.get('HAM').diff, 0);
assert.equal(base.get('NOR').best, false);
assert.ok(Math.abs(base.get('NOR').diff - (base.get('NOR').pace - base.get('HAM').pace)) < 1e-9);
for (const id of ['NOR', 'PIA', 'LEC']) assert.ok(base.get(id).diff > 0, `${id} медленнее лучшего`);

// --- ручной клик перекрывает флаг, порог ловит выброс ----------------------
const on = new Map([[key('PIA', 15), true]]); // вручную вернули круг 102.741
assert.equal(isIncluded('PIA', 15, flags, new Map()), false, 'по умолчанию OUT выключен');
assert.equal(isIncluded('PIA', 15, flags, on), true, 'ручное включение сильнее флага');

const strict = run({ overrides: on, paceThreshold: 1.07 });
assert.equal(strict.get('PIA').dropped.has(15), true, '102.741 отсекается порогом 107%');
assert.equal(strict.get('PIA').usedLaps, 18, 'выброс не попал в среднее');
assert.ok(Math.abs(strict.get('PIA').pace - base.get('PIA').pace) < 1e-9);

const loose = run({ overrides: on, paceThreshold: 1.5 });
assert.equal(loose.get('PIA').dropped.has(15), false, 'при пороге 150% круг остаётся');
assert.equal(loose.get('PIA').usedLaps, 19);
assert.ok(loose.get('PIA').pace > strict.get('PIA').pace, 'выброс тянет темп вверх');

// Ручное выключение чистого круга тоже работает.
const off = run({ overrides: new Map([[key('HAM', 13), false]]) });
assert.equal(off.get('HAM').usedLaps, 17);
assert.ok(off.get('HAM').pace > base.get('HAM').pace, 'убрали лучший круг — темп просел');

// --- вырожденные случаи: без деления на ноль -------------------------------
const nothing = new Map();
for (let lap = 1; lap <= race.lapCount; lap++) nothing.set(key('NOR', lap), false);
const empty = run({ selected: ['NOR'], overrides: nothing });
assert.equal(empty.get('NOR').pace, null);
assert.equal(empty.get('NOR').diff, null);
assert.equal(empty.get('NOR').best, false);
assert.equal(run({ selected: [] }).size, 0);
assert.equal(run({ selected: ['GHOST'] }).get('GHOST').pace, null, 'пилот без кругов не ломает расчёт');

console.log('pace.js: все проверки прошли');
