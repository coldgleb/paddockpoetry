// node src/qualifying.test.js — автоотсев аномальных этапов и ручное переключение.
import assert from 'node:assert/strict';
import { buildComparison, buildStandings, pointsFor, rowKey, AUTO_OFF_PCT } from './qualifying.js';

const drv = (driverId, number, Q3) => ({ driverId, code: driverId, number, constructorId: 'x', Q3 });
// Два этапа: обычный (гэп ~0.5%) и аномальный (гэп ~3% — авто-выкид).
const rounds = [
  { round: 1, circuitId: 'monza', country: 'Italy', results: [drv('A', 1, 80), drv('B', 2, 80.4)] },
  { round: 2, circuitId: 'spa', country: 'Belgium', results: [drv('A', 1, 100), drv('B', 2, 103)] },
];

const pair = (overrides, cut) => buildComparison(rounds, 'x', overrides, cut).pairs[0];

const base = pair();
assert.equal(base.rows[0].on, true, 'обычный этап в счёте');
assert.equal(base.rows[1].on, false, `гэп больше ${AUTO_OFF_PCT}% — этап вне счёта`);
assert.equal(base.shared, 1);
assert.equal(base.winsLeft, 1);
assert.ok(Math.abs(base.avgPct) < 1, 'средний гэп без аномалии');

// Ручное возвращение аномального этапа.
const back = pair(new Map([[rowKey(base.key, 2, false), true]]));
assert.equal(back.shared, 2);
assert.ok(Math.abs(back.avgPct) > 1, 'аномалия вернулась в средний гэп');

// Ручное отключение нормального этапа.
const off = pair(new Map([[rowKey(base.key, 1, false), false]]));
assert.equal(off.shared, 0);
assert.equal(off.winsLeft, 0);
assert.equal(off.avgPct, null);

// Порог со страницы: строгий выкидывает оба этапа, щедрый — оставляет оба.
assert.equal(pair(undefined, 0.1).shared, 0);
assert.equal(pair(undefined, 5).shared, 2);

// --- зачёт квалификаций ----------------------------------------------------

assert.equal(pointsFor(1, false), 25);
assert.equal(pointsFor(10, false), 1);
assert.equal(pointsFor(11, false), 0);
assert.equal(pointsFor(1, true), 8);
assert.equal(pointsFor(9, true), 0);

const at = (driverId, pos) => ({ driverId, code: driverId, constructorId: 'x', team: 'X', pos });
// Спринт-уикенд: SPR даёт спринтовые очки, обычная квала — гоночные.
const season = [
  {
    round: 1, circuitId: 'shanghai', country: 'China', sprint: true,
    sprintResults: [at('A', 1), at('B', 2)],
    results: [at('B', 1), at('A', 2)],
  },
  { round: 2, circuitId: 'spa', country: 'Belgium', results: [at('A', 3), at('B', 11)] },
];

const st = buildStandings(season);
assert.deepEqual(st.stages.map((s) => s.label), ['CHN SPR', 'CHN', 'BEL']);
const [first, second] = st.drivers;
assert.equal(first.id, 'A'); // 8 (SPR P1) + 18 (P2) + 15 (P3) = 41
assert.equal(first.points, 41);
assert.equal(second.id, 'B'); // 7 (SPR P2) + 25 (P1) + 0 (P11) = 32
assert.equal(second.points, 32);
assert.equal(st.drivers.find((d) => d.id === 'A').cells.get('1S').pts, 8);
assert.equal(st.drivers.find((d) => d.id === 'B').cells.get('2Q').pts, 0, 'P11 — без очков');

console.log('qualifying: ok');
