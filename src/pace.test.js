// Self-check: node src/pace.test.js
import assert from 'node:assert/strict';
import {
  parseLapTime, median, flagLaps, computePace, isIncluded, formatLapTime, lapValue, METRICS, key,
} from './pace.js';
import { teamColor, onColor } from './teams.js';
import { expandStints, COMPOUNDS } from './tyres.js';
import { parseSafetyCar } from './openf1.js';

// Референс-таблица пользователя, круги 1..21. Времена круга 1 и пит-кругов
// проставлены правдоподобно: OpenF1 отдаёт время и на заезде в боксы.
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

// Секторы делим 35/35/30 — точные доли неважны, важно что сумма трёх даёт
// ровно время круга, как в настоящих данных OpenF1.
function makeRace(laps, pitLaps, sc = new Map()) {
  const byDriver = new Map();
  let lapCount = 0;
  for (const [id, arr] of Object.entries(laps)) {
    const byLap = new Map();
    arr.forEach((t, i) => {
      if (t == null) return;
      const s1 = +(t * 0.35).toFixed(3);
      const s2 = +(t * 0.35).toFixed(3);
      byLap.set(i + 1, { t, s1, s2, s3: +(t - s1 - s2).toFixed(3) });
    });
    byDriver.set(id, byLap);
    lapCount = Math.max(lapCount, arr.length);
  }
  const pits = new Map(Object.entries(pitLaps).map(([id, ls]) => [id, new Set(ls)]));
  return {
    lapCount,
    laps: byDriver,
    pits,
    sc,
    drivers: Object.keys(laps).map((id) => ({ id })), // flagLaps идёт по составу
  };
}

const race = makeRace(REF, PITS);
const flags = flagLaps(race);
const ALL = ['NOR', 'PIA', 'LEC', 'HAM'];
const run = (opts = {}) =>
  computePace(race, flags, { selected: ALL, overrides: new Map(), ...opts });

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
assert.equal(flags.get('PIA').get(15), 'OUT');
assert.equal(flags.get('NOR').get(12), undefined);

// --- разбор судейской в отрезки SC/VSC -------------------------------------
// Реальные сообщения Британии-2025: два VSC и два выезда машины безопасности,
// плюс четыре сообщения о штрафе за нарушение под SC — эти идут категорией
// Other и в отрезки попасть не должны.
const britain = parseSafetyCar([
  { category: 'Other', lap_number: 1, message: 'FORMATION LAP WILL BE STARTED BEHIND THE SAFETY CAR' },
  { category: 'SafetyCar', lap_number: 2, message: 'VIRTUAL SAFETY CAR DEPLOYED' },
  { category: 'SafetyCar', lap_number: 4, message: 'VIRTUAL SAFETY CAR ENDING' },
  { category: 'SafetyCar', lap_number: 5, message: 'VIRTUAL SAFETY CAR DEPLOYED' },
  { category: 'SafetyCar', lap_number: 7, message: 'VIRTUAL SAFETY CAR ENDING' },
  { category: 'SafetyCar', lap_number: 14, message: 'SAFETY CAR DEPLOYED' },
  { category: 'SafetyCar', lap_number: 17, message: 'SAFETY CAR IN THIS LAP' },
  { category: 'SafetyCar', lap_number: 18, message: 'SAFETY CAR DEPLOYED' },
  { category: 'SafetyCar', lap_number: 21, message: 'SAFETY CAR IN THIS LAP' },
  { category: 'Other', lap_number: 22, message: 'INCIDENT INVOLVING CAR 81 (PIA) NOTED - SAFETY CAR INFRINGEMENT' },
  { category: 'Other', lap_number: 25, message: 'FIA STEWARDS: 10 SECOND TIME PENALTY FOR CAR 81 (PIA) - SAFETY CAR INFRINGEMENT' },
]);
assert.deepEqual([...britain.keys()].sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21]);
assert.equal(britain.get(3), 'VSC');
assert.equal(britain.get(16), 'SC');
assert.equal(britain.get(1), undefined, 'формационный круг — не отрезок SC');
assert.equal(britain.get(22), undefined, 'штрафы за нарушение под SC не считаются');
assert.equal(britain.get(13), undefined);
// Виртуальную пишут и сокращением — обе формы встречаются в живых данных,
// и по одному слову VIRTUAL половина отрезков уезжала в обычные SC.
const short = parseSafetyCar([
  { category: 'SafetyCar', lap_number: 56, message: 'VSC DEPLOYED' },
  { category: 'SafetyCar', lap_number: 57, message: 'VSC ENDING' },
]);
assert.deepEqual([...short], [[56, 'VSC'], [57, 'VSC']], 'VSC DEPLOYED — это виртуальная');
// «SAFETY CAR THROUGH THE PIT LANE» не открывает и не закрывает отрезок.
assert.equal(
  parseSafetyCar([{ category: 'SafetyCar', lap_number: 5, message: 'SAFETY CAR THROUGH THE PIT LANE' }]).size,
  0,
);
// Гонка без машины безопасности.
assert.equal(parseSafetyCar([]).size, 0);
// Объявление без закрывающего сообщения не тянется до конца гонки.
const dangling = parseSafetyCar([{ category: 'SafetyCar', lap_number: 30, message: 'SAFETY CAR DEPLOYED' }]);
assert.deepEqual([...dangling.keys()], [30]);

// --- SC берётся из данных, а не угадывается --------------------------------
const scRace = makeRace(
  { A: [95, 90, 90, 90, 140, 141, 90], B: [95, 91, 90, 91, 142, 140, 91] },
  { A: [], B: [] },
  new Map([[5, 'SC'], [6, 'SC'], [3, 'VSC']]),
);
const scFlags = flagLaps(scRace);
assert.equal(scFlags.get('A').get(5), 'SC');
assert.equal(scFlags.get('B').get(6), 'SC');
assert.equal(scFlags.get('A').get(3), 'VSC', 'виртуальная отличается от обычной');
assert.equal(scFlags.get('A').get(7), undefined, 'обычный круг не помечается');
assert.equal(scFlags.get('A').get(1), 'LAP1', 'старт важнее SC');
// Пит сильнее SC: круг 5 у A становится заездом в боксы.
const pitRace = makeRace({ A: [95, 90, 90, 90, 140, 141, 90] }, { A: [5] }, new Map([[5, 'SC'], [6, 'SC']]));
assert.equal(flagLaps(pitRace).get('A').get(5), 'PIT', 'PIT сильнее SC');
assert.equal(flagLaps(pitRace).get('A').get(6), 'OUT', 'OUT сильнее SC');

// --- пометка SC отдельно по каждому пилоту ---------------------------------
// Судейская даёт номер круга по лидеру, круговые в этот момент на круг позади,
// поэтому пометка обязана быть пилотозависимой.
const oneDriver = flagLaps(scRace, { manualSC: new Map([[key('A', 7), 'SC']]) });
assert.equal(oneDriver.get('A').get(7), 'SC', 'помечен только A');
assert.equal(oneDriver.get('B').get(7), undefined, 'у B тот же круг остался чистым');
// Снятие тоже поштучное.
const offOne = flagLaps(scRace, { manualSC: new Map([[key('A', 5), false]]) });
assert.equal(offOne.get('A').get(5), undefined, 'у A пометка снята');
assert.equal(offOne.get('B').get(5), 'SC', 'у B осталась');
// Вид пометки сохраняется: VSC не должен превращаться в SC при переключении.
assert.equal(flagLaps(scRace, { manualSC: new Map([[key('A', 3), 'VSC']]) }).get('A').get(3), 'VSC');

// Снять и вернуть пометку — тот же вид, что был. Повторяем ровно ту логику,
// которой пользуется интерфейс: снятое пишем как false, возвращаем из данных.
{
  const manual = new Map();
  const set = (id, lap, value) => {
    const auto = scRace.sc.get(lap) || null;
    if ((value || null) === auto) manual.delete(key(id, lap));
    else manual.set(key(id, lap), value);
  };
  const kindOf = (id, lap) => flagLaps(scRace, { manualSC: manual }).scKind(id, lap);
  const restore = (lap) => scRace.sc.get(lap) || 'SC';

  assert.equal(kindOf('A', 3), 'VSC', 'исходно круг 3 виртуальный');
  set('A', 3, false); // сняли
  assert.equal(kindOf('A', 3), null, 'пометка снялась');
  set('A', 3, restore(3)); // вернули
  assert.equal(kindOf('A', 3), 'VSC', 'вернулась именно VSC, а не SC');
  assert.equal(manual.size, 0, 'совпало с данными — override не держим');

  // А там, где в данных ничего нет, своя пометка остаётся обычной SC.
  set('A', 7, restore(7));
  assert.equal(kindOf('A', 7), 'SC');
}
// scKind даёт интерфейсу тот же порядок проверок, что и флаги.
assert.equal(scFlags.scKind('A', 5), 'SC');
assert.equal(scFlags.scKind('A', 7), null);
assert.equal(oneDriver.scKind('A', 7), 'SC');
assert.equal(oneDriver.scKind('B', 7), null);

// Пометка на круге, которого у пилота нет в данных, не теряется — иначе
// кнопка в интерфейсе горит, а в таблице ничего не меняется.
const holey = makeRace({ A: [90, 90, 90] }, { A: [] });
holey.lapCount = 6; // круги 4–6 у пилота отсутствуют
assert.equal(flagLaps(holey, { manualSC: new Map([[key('A', 5), 'SC']]) }).get('A').get(5), 'SC');

// --- темп по умолчанию: круг 1, PIT и OUT не участвуют ---------------------
const base = run();
assert.equal(base.get('NOR').usedLaps, 18, '21 круг минус старт, PIT и OUT');
assert.equal(base.get('PIA').usedLaps, 18);
assert.ok(Math.abs(base.get('NOR').pace - 82.7615) < 0.001);
assert.ok(Math.abs(base.get('HAM').pace - 82.46794) < 0.001);
// Порога выброса больше нет — поля dropped не должно остаться нигде.
assert.equal(base.get('NOR').dropped, undefined, 'порог убран вместе с полем');

// --- diff считается от лучшего, лучший получает 0 --------------------------
assert.equal(base.get('HAM').best, true);
assert.equal(base.get('HAM').diff, 0);
assert.equal(base.get('NOR').best, false);
assert.ok(Math.abs(base.get('NOR').diff - (base.get('NOR').pace - base.get('HAM').pace)) < 1e-9);
for (const id of ['NOR', 'PIA', 'LEC']) assert.ok(base.get(id).diff > 0, `${id} медленнее лучшего`);

// --- ручной клик перекрывает флаг ------------------------------------------
const on = new Map([[key('PIA', 15), true]]); // вручную вернули круг 102.741
assert.equal(isIncluded('PIA', 15, flags, new Map()), false, 'по умолчанию OUT выключен');
assert.equal(isIncluded('PIA', 15, flags, on), true, 'ручное включение сильнее флага');

// Порога больше нет: включённый вручную медленный круг честно идёт в среднее.
const withSlow = run({ overrides: on });
assert.equal(withSlow.get('PIA').usedLaps, 19, 'круг добавился к 18 обычным');
assert.ok(withSlow.get('PIA').pace > base.get('PIA').pace, '102.741 тянет темп вверх');

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
const scOn = flagLaps(race, { manualSC: new Map(ALL.map((id) => [key(id, 7), 'SC'])) });
assert.equal(scOn.get('NOR').get(7), 'SC');
assert.equal(scOn.get('HAM').get(7), 'SC');
assert.equal(
  computePace(race, scOn, { selected: ALL, overrides: new Map() }).get('NOR').usedLaps,
  base.get('NOR').usedLaps - 1,
);
// Главное: ручной SC перекрывает время круга, но не пит-метки.
const pitLaps = [11, 12, 13, 14];
const scOnPits = flagLaps(race, {
  manualSC: new Map(ALL.flatMap((id) => pitLaps.map((l) => [key(id, l), 'SC']))),
});
assert.equal(scOnPits.get('NOR').get(13), 'PIT', 'PIT сильнее ручного SC');
assert.equal(scOnPits.get('NOR').get(14), 'OUT', 'OUT сильнее ручного SC');
assert.equal(scOnPits.get('HAM').get(11), 'PIT', 'PIT сильнее ручного SC');
assert.equal(scOnPits.get('HAM').get(12), 'OUT', 'OUT сильнее ручного SC');
// А у пилотов без пит-стопа на этих кругах SC встаёт.
assert.equal(scOnPits.get('LEC').get(13), 'SC');
assert.equal(scOnPits.get('NOR').get(11), 'SC');
// Старт по-прежнему главнее всего.
assert.equal(flagLaps(race, { manualSC: new Map([[key('NOR', 1), 'SC']]) }).get('NOR').get(1), 'LAP1');
// false снимает SC там, где автоопределение ошиблось.
const scAuto = flagLaps(scRace);
assert.equal(scAuto.get('A').get(5), 'SC');
assert.equal(flagLaps(scRace, { manualSC: new Map([[key('A', 5), false]]) }).get('A').get(5), undefined);
// Пустая карта ничего не меняет.
assert.deepEqual(flagLaps(race, { manualSC: new Map() }).get('NOR'), flags.get('NOR'));

// --- метрика сравнения: сектор, сумма секторов, круг ------------------------
const e = { t: 90, s1: 31.5, s2: 31.5, s3: 27 };
assert.equal(lapValue(e, 'lap'), 90);
assert.equal(lapValue(e, 's1'), 31.5);
assert.equal(lapValue(e, 's2'), 31.5);
assert.equal(lapValue(e, 's3'), 27);
assert.equal(lapValue(e, 's12'), 63);
assert.equal(lapValue(e, 's23'), 58.5);
assert.equal(lapValue(e, 's13'), 58.5);
assert.equal(lapValue(e, 'lap'), lapValue(e, 's1') + lapValue(e, 's2') + lapValue(e, 's3'),
  'сумма трёх секторов совпадает с кругом');
// Потерянный сектор: круг целиком ещё считается, а суммы с ним — нет.
const gap = { t: 90, s1: 31.5, s2: null, s3: 27 };
assert.equal(lapValue(gap, 'lap'), 90, 'время круга есть даже без сектора');
assert.equal(lapValue(gap, 's1'), 31.5);
assert.equal(lapValue(gap, 's2'), null);
assert.equal(lapValue(gap, 's12'), null, 'сумма с потерянным сектором не считается');
assert.equal(lapValue(gap, 's13'), 58.5, 'а без него — считается');
assert.equal(lapValue(null, 'lap'), null);
assert.equal(lapValue(e, 'нет-такой-метрики'), 90, 'неизвестная метрика падает на круг');
// Темп по сектору отличается от темпа по кругу и примерно втрое меньше.
const byS1 = run({ metric: 's1' });
assert.ok(byS1.get('NOR').pace < base.get('NOR').pace / 2);
assert.ok(Math.abs(byS1.get('NOR').pace - base.get('NOR').pace * 0.35) < 0.01);
assert.equal(byS1.get('NOR').usedLaps, base.get('NOR').usedLaps, 'состав кругов тот же');
// Круг без сектора выпадает из расчёта, а не обнуляется.
const holed = makeRace({ A: [90, 90, 90, 90] }, { A: [] });
holed.laps.get('A').get(3).s2 = null;
const holedRows = computePace(holed, flagLaps(holed), {
  selected: ['A'], overrides: new Map(), metric: 's12',
});
assert.equal(holedRows.get('A').usedLaps, 2, 'круг 1 — старт, круг 3 — без сектора');

// --- формат времени круга --------------------------------------------------
assert.equal(formatLapTime(83.456), '1:23.456');
assert.equal(formatLapTime(102.741), '1:42.741');
assert.equal(formatLapTime(60), '1:00.000');
// Меньше минуты — без минут: сектор в виде «0:29.832» читается плохо.
assert.equal(formatLapTime(29.832), '29.832');
assert.equal(formatLapTime(59.9), '59.900');
assert.equal(formatLapTime(9.5), '9.500');
// Округление до миллисекунд идёт ДО деления на минуты, иначе тут вышло бы «1:60.000».
assert.equal(formatLapTime(119.9995), '2:00.000');
assert.equal(formatLapTime(null), '—');
assert.equal(formatLapTime(NaN), '—');
// Разбор и печать обратны друг другу — с поправкой на то, что короче минуты
// печатается без ведущего «0:».
for (const s of ['1:23.456', '1:42.741', '59.900']) {
  assert.equal(formatLapTime(parseLapTime(s)), s);
}
assert.equal(parseLapTime('0:59.900'), 59.9, 'разбор всё ещё понимает ведущие минуты');

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
  for (const [lap] of r.points) {
    assert.equal(isIncluded(id, lap, base === r ? flags : flags, new Map()), true,
      `${id}: в points попал невключённый круг ${lap}`);
  }
}

// --- составы резины --------------------------------------------------------
// Реальные стинты NOR из Венгрии-2026: границы включительные, а один стинт
// приходит с compound: null — OpenF1 так делает, и это не должно ломать разбор.
// tyre_age_at_start взят настоящий: у NOR последний комплект б/у (age=3).
const tyres = expandStints([
  { driver_number: 1, lap_start: 1, lap_end: 17, compound: 'MEDIUM', tyre_age_at_start: 0 },
  { driver_number: 1, lap_start: 18, lap_end: 39, compound: 'HARD', tyre_age_at_start: 0 },
  { driver_number: 1, lap_start: 40, lap_end: 56, compound: null, tyre_age_at_start: 1 },
  { driver_number: 1, lap_start: 57, lap_end: 70, compound: 'SOFT', tyre_age_at_start: 3 },
  { driver_number: 4, lap_start: 1, lap_end: 20, compound: '' },
  { driver_number: 4, lap_start: 21, lap_end: 30, compound: 'ЧТО-ТО НОВОЕ' },
]);
const nor = tyres.get(1);
const comp = (lap) => nor.get(lap)?.compound;
assert.equal(comp(1), 'MEDIUM');
assert.equal(comp(17), 'MEDIUM', 'верхняя граница стинта включительная');
assert.equal(comp(18), 'HARD', 'следующий стинт начинается сразу за ней');
assert.equal(comp(39), 'HARD');
assert.equal(comp(57), 'SOFT');
assert.equal(comp(70), 'SOFT');
assert.equal(nor.get(71), undefined);
// Стинт, у которого OpenF1 потерял состав, показывается как «неизвестен»,
// а не выпадает молча: пустая ячейка читалась бы как поломка вёрстки.
assert.equal(comp(40), 'UNKNOWN');
assert.equal(comp(56), 'UNKNOWN');
assert.equal(nor.size, 70, 'развёрнуты все круги гонки');

// Номер круга на комплекте: считается от tyre_age_at_start, а не от единицы —
// комплект бывает б/у после квалификации.
assert.equal(nor.get(1).age, 1, 'новый комплект — первый круг');
assert.equal(nor.get(17).age, 17);
assert.equal(nor.get(18).age, 1, 'новый стинт — счёт заново');
assert.equal(nor.get(40).age, 2, 'комплект с пробегом 1 круг стартует со второго');
assert.equal(nor.get(57).age, 4, 'б/у комплект NOR: age=3, значит первый гоночный круг четвёртый');
assert.equal(nor.get(70).age, 17);
// Отсутствующий tyre_age_at_start читается как новый комплект.
assert.equal(tyres.get(4).get(1).age, 1);

// Пустая строка и незнакомый состав тоже становятся «неизвестен».
assert.equal(tyres.get(4).get(1).compound, 'UNKNOWN');
assert.equal(tyres.get(4).get(25).compound, 'UNKNOWN');
assert.deepEqual(expandStints([]), new Map());
// Битые границы отбрасываются — на них цикл развёртки зациклился бы.
assert.deepEqual(expandStints([{ driver_number: 9, lap_start: null, lap_end: 5, compound: 'SOFT' }]), new Map());
// У каждого состава есть цвет и буква — иначе полоса в таблице будет пустой.
for (const [name, c] of Object.entries(COMPOUNDS)) {
  assert.match(c.color, /^#[0-9A-F]{6}$/i, `${name}: нужен hex`);
  assert.equal(c.letter.length, 1, `${name}: буква одна`);
}
const letters = Object.values(COMPOUNDS).map((c) => c.letter);
assert.equal(new Set(letters).size, letters.length, 'буквы не должны совпадать');

// --- порядок колонок -------------------------------------------------------
// Повторяем сортировку из applyOrder: по месту в гонке, по темпу, вручную.
{
  const finish = ['NOR', 'PIA', 'LEC', 'HAM']; // race.drivers уже финишный
  const pos = new Map(finish.map((id, i) => [id, i]));
  const rows = run();
  const byPace = (list) =>
    [...list].sort((a, b) => {
      const pa = rows.get(a)?.pace;
      const pb = rows.get(b)?.pace;
      if (pa == null || pb == null) {
        if (pa == null && pb == null) return pos.get(a) - pos.get(b);
        return pa == null ? 1 : -1;
      }
      return pa - pb;
    });

  // По темпу быстрейший впереди, и это не совпадает с финишным порядком.
  const paced = byPace(finish);
  assert.equal(paced[0], 'HAM', 'у HAM лучший темп');
  assert.notDeepEqual(paced, finish, 'порядок по темпу отличается от финишного');
  for (let i = 1; i < paced.length; i++) {
    assert.ok(rows.get(paced[i - 1]).pace <= rows.get(paced[i]).pace, 'темп по возрастанию');
  }

  // Пилот без темпа уезжает в конец, а не в начало из-за сравнения с null.
  const nothing = new Map();
  for (let lap = 1; lap <= race.lapCount; lap++) nothing.set(key('LEC', lap), false);
  const withGap = computePace(race, flags, { selected: finish, overrides: nothing });
  const order = [...finish].sort((a, b) => {
    const pa = withGap.get(a)?.pace;
    const pb = withGap.get(b)?.pace;
    if (pa == null || pb == null) {
      if (pa == null && pb == null) return pos.get(a) - pos.get(b);
      return pa == null ? 1 : -1;
    }
    return pa - pb;
  });
  assert.equal(withGap.get('LEC').pace, null);
  assert.equal(order[order.length - 1], 'LEC', 'без темпа — в конец');

  // Ручной порядок: вынули и вставили на место цели. Индекс цели берём ДО
  // удаления — иначе при переносе вправо колонка встаёт на одну позицию левее,
  // чем бросили, потому что всё справа сдвинулось.
  const move = (list, fromId, toId) => {
    const out = [...list];
    if (fromId === toId) return out;
    const from = out.indexOf(fromId);
    const to = out.indexOf(toId);
    if (from < 0 || to < 0) return out;
    out.splice(from, 1);
    out.splice(to, 0, fromId);
    return out;
  };
  assert.deepEqual(move(finish, 'HAM', 'NOR'), ['HAM', 'NOR', 'PIA', 'LEC'], 'перенос в начало');
  assert.deepEqual(move(finish, 'NOR', 'LEC'), ['PIA', 'LEC', 'NOR', 'HAM'], 'перенос вправо');
  assert.deepEqual(move(finish, 'NOR', 'NOR'), finish, 'перенос на себя ничего не меняет');
}

// --- цвета команд ----------------------------------------------------------
// Запасной справочник: основные цвета берутся из team_colour OpenF1, а сюда
// приложение уходит на сезонах 2018–2022 и когда OpenF1 не ответил. Если
// состав останется без цвета, он молча станет серым — а серым помечены
// выключенные круги. Пусть лучше падает тест.
const CONSTRUCTORS = [
  'McLaren', 'Ferrari', 'Red Bull Racing', 'Mercedes', 'Aston Martin', 'Alpine',
  'Williams', 'Racing Bulls', 'Audi', 'Cadillac', 'Haas F1 Team',
  'Kick Sauber', 'Alfa Romeo', 'RB', 'AlphaTauri',
];
const fallback = teamColor('какой-то-новый-состав-2030');
for (const id of CONSTRUCTORS) {
  assert.match(teamColor(id), /^#[0-9A-F]{6}$/i, `${id}: цвет должен быть hex`);
  assert.notEqual(teamColor(id), fallback, `${id} остался без своего цвета`);
}
// Цвета должны быть различимы внутри одного сезона: одинаковый цвет у двух
// команд сольёт колонки. Между сезонами совпадения допустимы — переименование
// той же команды (RB → Racing Bulls) обязано сохранять цвет.
const GRID_2026 = [
  'McLaren', 'Ferrari', 'Red Bull Racing', 'Mercedes', 'Aston Martin', 'Alpine',
  'Williams', 'Racing Bulls', 'Audi', 'Cadillac', 'Haas F1 Team',
];
const used2026 = GRID_2026.map(teamColor);
assert.equal(new Set(used2026).size, used2026.length, 'в сезоне 2026 два состава получили один цвет');
assert.equal(teamColor('RB'), teamColor('Racing Bulls'), 'переименование не должно менять цвет');
// Текст поверх плашки выбирается по яркости, иначе чип нечитаем.
assert.equal(onColor('#E9EEF4'), '#10131a', 'на светлой плашке — тёмный текст');
assert.equal(onColor('#3671C6'), '#ffffff', 'на тёмной плашке — светлый текст');

console.log('pace.js + teams.js: все проверки прошли');
