// Бледнеет тот, кто проигрывает: одинаковый цвет у сокомандников иначе
// сливается в одну линию.
import assert from 'node:assert/strict';
import { fadeLosers, pale } from './chart.js';

const s = (code, color, pace) => ({ code, color, pace });

{
  const [fast, slow] = fadeLosers([s('A', '#FF8000', 90.1), s('B', '#FF8000', 90.4)]);
  assert.equal(fast.color, '#FF8000');
  assert.equal(slow.color, pale('#FF8000'));
}

// Одиночка цвет не теряет, даже если он самый медленный на графике.
{
  const [solo] = fadeLosers([s('C', '#E8002D', 99), s('D', '#27F4D2', 90)]);
  assert.equal(solo.color, '#E8002D');
}

// Без темпа (все круги выключены) — тоже проигравший.
{
  const [, none] = fadeLosers([s('E', '#3671C6', 90), s('F', '#3671C6', null)]);
  assert.equal(none.color, pale('#3671C6'));
}

assert.equal(pale('#ffffff'), '#8a8b8f'); // ровно полпути до #14171f

console.log('chart ok');
