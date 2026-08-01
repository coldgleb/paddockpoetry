// Self-check: node src/pace.test.js
import assert from 'node:assert/strict';
import {
  parseLapTime, median, flagLaps, computePace, isIncluded, formatLapTime, key,
} from './pace.js';
import { teamColor, onColor } from './teams.js';
import { expandStints, COMPOUNDS } from './tyres.js';

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

// --- ручная пометка SC -----------------------------------------------------
// Круг 7 чистый у всех; помечаем вручную — должен выпасть из темпа.
const scOn = flagLaps(race, { manualSC: new Map([[7, true]]) });
assert.equal(scOn.get('NOR').get(7), 'SC');
assert.equal(scOn.get('HAM').get(7), 'SC');
assert.equal(
  computePace(race, scOn, { selected: ALL, overrides: new Map(), paceThreshold: 1.07 })
    .get('NOR').usedLaps,
  base.get('NOR').usedLaps - 1,
);
// Главное: ручной SC перекрывает время круга, но не пит-метки.
const scOnPits = flagLaps(race, { manualSC: new Map([[13, true], [14, true], [11, true], [12, true]]) });
assert.equal(scOnPits.get('NOR').get(13), 'PIT', 'PIT сильнее ручного SC');
assert.equal(scOnPits.get('NOR').get(14), 'OUT', 'OUT сильнее ручного SC');
assert.equal(scOnPits.get('HAM').get(11), 'PIT', 'PIT сильнее ручного SC');
assert.equal(scOnPits.get('HAM').get(12), 'OUT', 'OUT сильнее ручного SC');
// А у пилотов без пит-стопа на этих кругах SC встаёт.
assert.equal(scOnPits.get('LEC').get(13), 'SC');
assert.equal(scOnPits.get('NOR').get(11), 'SC');
// Старт по-прежнему главнее всего.
assert.equal(flagLaps(race, { manualSC: new Map([[1, true]]) }).get('NOR').get(1), 'LAP1');
// false снимает SC там, где автоопределение ошиблось.
const scAuto = flagLaps(scRace);
assert.equal(scAuto.get('A').get(5), 'SC');
assert.equal(flagLaps(scRace, { manualSC: new Map([[5, false]]) }).get('A').get(5), undefined);
// Пустая карта ничего не меняет.
assert.deepEqual(flagLaps(race, { manualSC: new Map() }).get('NOR'), flags.get('NOR'));

// --- формат времени круга --------------------------------------------------
assert.equal(formatLapTime(83.456), '1:23.456');
assert.equal(formatLapTime(102.741), '1:42.741');
assert.equal(formatLapTime(60), '1:00.000');
assert.equal(formatLapTime(59.9), '0:59.900');
assert.equal(formatLapTime(9.5), '0:09.500');
// Округление до миллисекунд идёт ДО деления на минуты, иначе тут вышло бы «1:60.000».
assert.equal(formatLapTime(119.9995), '2:00.000');
assert.equal(formatLapTime(null), '—');
assert.equal(formatLapTime(NaN), '—');
// Разбор и печать должны быть обратны друг другу.
for (const s of ['1:23.456', '1:42.741', '0:59.900']) {
  assert.equal(formatLapTime(parseLapTime(s)), s);
}

// --- диапазон кругов «с X по Y» --------------------------------------------
const inRange = (r) => run({ range: r });
const r5to12 = inRange({ from: 5, to: 12 });
// Круги 5..12 у NOR: чистые все, кроме — PIT у него на 13, так что 8 штук.
assert.equal(r5to12.get('NOR').usedLaps, 8);
assert.equal(isIncluded('NOR', 4, flags, new Map(), { from: 5, to: 12 }), false);
assert.equal(isIncluded('NOR', 5, flags, new Map(), { from: 5, to: 12 }), true);
assert.equal(isIncluded('NOR', 13, flags, new Map(), { from: 5, to: 20 }), false, 'PIT сильнее диапазона');
// Диапазон, накрывающий пит-стоп, всё равно его исключает.
assert.equal(inRange({ from: 12, to: 15 }).get('HAM').usedLaps, 3, 'из 12..15 у HAM выпадает OUT на 12');
// Диапазон сильнее ручного клика: вне него круга в таблице нет, и включённым
// его оставить нельзя — иначе он тянул бы темп, а выключить его было бы негде.
assert.equal(
  isIncluded('NOR', 2, flags, new Map([[key('NOR', 2), true]]), { from: 5, to: 12 }),
  false, 'диапазон сильнее ручного включения',
);
// Внутри диапазона ручной клик по-прежнему главнее флага.
assert.equal(
  isIncluded('NOR', 13, flags, new Map([[key('NOR', 13), true]]), { from: 5, to: 20 }),
  true, 'внутри диапазона ручное включение снимает PIT',
);
// Сужение диапазона не должно оставлять «залипших» кругов в расчёте.
const манульно = new Map([[key('NOR', 2), true], [key('NOR', 30), true]]);
assert.equal(run({ overrides: манульно, range: { from: 5, to: 12 } }).get('NOR').usedLaps, 8);
// Диапазон без единого круга не должен ронять расчёт.
const пусто = inRange({ from: 1, to: 1 }); // круг 1 у всех помечен LAP1
assert.equal(пусто.get('NOR').pace, null);
assert.equal(пусто.get('NOR').diff, null);
// Без диапазона поведение прежнее.
assert.equal(inRange(null).get('NOR').usedLaps, base.get('NOR').usedLaps);

// points — ровно то, что легло в темп: график не может разойтись с числом.
for (const [id, r] of base) {
  assert.equal(r.points.length, r.usedLaps, `${id}: points и usedLaps разошлись`);
  if (r.pace != null) {
    const avg = r.points.reduce((a, [, v]) => a + v, 0) / r.points.length;
    assert.ok(Math.abs(avg - r.pace) < 1e-9, `${id}: среднее по points != pace`);
  }
  for (const [lap] of r.points) assert.equal(r.dropped.has(lap), false, 'выброс попал в points');
}

// --- составы резины --------------------------------------------------------
// Реальные стинты NOR из Венгрии-2026: границы включительные, а один стинт
// приходит с compound: null — OpenF1 так делает, и это не должно ломать разбор.
const tyres = expandStints([
  { driver_number: 1, lap_start: 1, lap_end: 17, compound: 'MEDIUM' },
  { driver_number: 1, lap_start: 18, lap_end: 39, compound: 'HARD' },
  { driver_number: 1, lap_start: 40, lap_end: 56, compound: null },
  { driver_number: 1, lap_start: 57, lap_end: 70, compound: 'SOFT' },
  { driver_number: 4, lap_start: 1, lap_end: 20, compound: '' },
  { driver_number: 4, lap_start: 21, lap_end: 30, compound: 'ЧТО-ТО НОВОЕ' },
]);
const nor = tyres.get(1);
assert.equal(nor.get(1), 'MEDIUM');
assert.equal(nor.get(17), 'MEDIUM', 'верхняя граница стинта включительная');
assert.equal(nor.get(18), 'HARD', 'следующий стинт начинается сразу за ней');
assert.equal(nor.get(39), 'HARD');
assert.equal(nor.get(40), undefined, 'стинт без состава пропускается, а не падает');
assert.equal(nor.get(57), 'SOFT');
assert.equal(nor.get(70), 'SOFT');
assert.equal(nor.get(71), undefined);
assert.equal(nor.size, 17 + 22 + 14, 'развёрнуты только круги с известным составом');
// Пустая строка и незнакомый состав игнорируются целиком.
assert.equal(tyres.has(4), false);
assert.deepEqual(expandStints([]), new Map());
// У каждого состава есть цвет и буква — иначе полоса в таблице будет пустой.
for (const [name, c] of Object.entries(COMPOUNDS)) {
  assert.match(c.color, /^#[0-9A-F]{6}$/i, `${name}: нужен hex`);
  assert.equal(c.letter.length, 1, `${name}: буква одна`);
}
assert.equal(new Set(Object.values(COMPOUNDS).map((c) => c.letter)).size, 5, 'буквы не должны совпадать');

// --- цвета команд ----------------------------------------------------------
// Список constructorId собран из /{сезон}/constructors за 2018–2026. Если в
// новом сезоне появится команда, которой тут нет, цвет молча станет серым —
// а серым помечены выключенные круги. Пусть лучше падает тест.
const CONSTRUCTORS = [
  'alpine', 'aston_martin', 'audi', 'cadillac', 'ferrari', 'haas', 'mclaren',
  'mercedes', 'rb', 'red_bull', 'williams', 'sauber', 'alfa', 'alphatauri',
  'racing_point', 'renault', 'force_india', 'toro_rosso',
];
const fallback = teamColor('какой-то-новый-состав-2030');
for (const id of CONSTRUCTORS) {
  assert.match(teamColor(id), /^#[0-9A-F]{6}$/i, `${id}: цвет должен быть hex`);
  assert.notEqual(teamColor(id), fallback, `${id} остался без своего цвета`);
}
// Цвета должны быть различимы: одинаковый цвет у двух команд сольёт колонки.
const used = CONSTRUCTORS.map(teamColor);
assert.equal(new Set(used).size, used.length, 'два состава получили один цвет');
// Текст поверх плашки выбирается по яркости, иначе чип нечитаем.
assert.equal(onColor('#E9EEF4'), '#10131a', 'на светлой плашке — тёмный текст');
assert.equal(onColor('#3671C6'), '#ffffff', 'на тёмной плашке — светлый текст');

console.log('pace.js + teams.js: все проверки прошли');
