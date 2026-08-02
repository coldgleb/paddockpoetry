// Составы резины. Сами стинты грузит openf1.js — здесь только их разбор
// и оформление.
//
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

// Стинты → круг за кругом: Map<номер машины, Map<круг, { compound, age }>>.
// Границы у OpenF1 включительные, а стинт заканчивается кругом заезда в боксы —
// тем самым, что помечен PIT.
//
// age — номер круга на этом комплекте. Отсчёт идёт от tyre_age_at_start, а не
// от единицы: комплект бывает б/у после квалификации. В Венгрии-2026 таких
// стинтов 8 из 67, у NOR последний старт с age=3, то есть его первый гоночный
// круг на этом комплекте — четвёртый.
export function expandStints(stints) {
  const byDriver = new Map();
  for (const s of stints) {
    const from = parseInt(s.lap_start, 10);
    const to = parseInt(s.lap_end, 10);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const compound = COMPOUNDS[s.compound] ? s.compound : 'UNKNOWN';
    const worn = parseInt(s.tyre_age_at_start, 10) || 0;
    if (!byDriver.has(s.driver_number)) byDriver.set(s.driver_number, new Map());
    const laps = byDriver.get(s.driver_number);
    for (let lap = from; lap <= to; lap++) {
      laps.set(lap, { compound, age: worn + (lap - from) + 1 });
    }
  }
  return byDriver;
}

