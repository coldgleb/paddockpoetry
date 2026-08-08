// Вкладка «Зачёт квалификаций»: сезон целиком, очки за места в квалификациях
// по гоночной системе (спринт-квалификации — по спринтовой). Данные из
// f1api.dev (f1api.js, тот же кэш, что и у вкладки сокомандников), расчёт — в
// qualifying.js; здесь только DOM и события.

import { fetchSeasonQualifying } from './f1api.js';
import { buildStandings } from './qualifying.js';
import { teamColorById } from './teams.js';

const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

const $ = (id) => document.getElementById(id);
const els = {
  season: $('p-season'),
  load: $('p-load'),
  status: $('p-status'),
  table: $('p-table'),
};

const state = { rounds: null, loading: false };

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

function render() {
  if (!state.rounds) {
    els.table.innerHTML = '<p class="empty-state">Нажми «Загрузить», чтобы посчитать зачёт.</p>';
    return;
  }
  const { stages, drivers } = buildStandings(state.rounds);
  if (!drivers.length) {
    els.table.innerHTML = state.loading
      ? '<p class="empty-state">Загружаю квалификации…</p>'
      : '<p class="empty-state">В этом сезоне ещё нет квалификаций.</p>';
    return;
  }

  const head =
    `<thead><tr><th class="corner">Пилот</th>` +
    stages.map((s) => `<th class="${s.sprint ? 'p-spr' : ''}">${s.label}</th>`).join('') +
    `<th class="p-total">Очки</th></tr></thead>`;

  let body = '';
  drivers.forEach((d, i) => {
    const cells = stages
      .map((s) => {
        const c = d.cells.get(s.key);
        if (!c) return '<td class="p-cell">·</td>';
        return `<td class="p-cell${c.pts ? '' : ' p-zero'}" title="${s.label}: P${c.pos}">${c.pts || 0}</td>`;
      })
      .join('');
    body +=
      `<tr><th class="q-track p-driver" style="--team:${teamColorById(d.constructorId)}">` +
      `<span class="p-pos">${i + 1}</span>${d.code}</th>` +
      `${cells}<td class="p-total">${d.points}</td></tr>`;
  });

  els.table.innerHTML =
    `<div class="table-wrap"><table class="quali points">${head}<tbody>${body}</tbody></table></div>`;
}

async function load() {
  els.load.disabled = true;
  const year = Number(els.season.value);
  state.rounds = [];
  state.loading = true;
  try {
    setStatus('Загружаю квалификации сезона…');
    render();
    // Этапы приходят пачками в порядке календаря — зачёт растёт на глазах.
    const rounds = await fetchSeasonQualifying(year, setStatus, (r) => {
      state.rounds.push(r);
      render();
    });
    state.rounds = rounds; // кэш-хит: onRound не звали — отрисуем всё разом
    if (!rounds.length) throw new Error('В этом сезоне ещё нет квалификаций');
    setStatus('');
  } catch (e) {
    setStatus(`${e.message}. Нажми «Загрузить», чтобы попробовать снова.`, true);
  } finally {
    state.loading = false;
    els.load.disabled = false;
    render();
  }
}

els.season.innerHTML = SEASONS.map((y) => `<option>${y}</option>`).join('');
els.load.addEventListener('click', load);
// Смена сезона обнуляет таблицу: старый зачёт к новому году отношения не имеет.
els.season.addEventListener('change', () => {
  state.rounds = null;
  setStatus('');
  render();
});

render();
