import { fetchSeasonRaces, fetchRace } from './jolpica.js';
import { flagLaps, computePace, isIncluded, key } from './pace.js';

const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
const DEFAULT_DRIVERS = 5; // сразу показываем топ-5, остальных пилотов добавляет пользователь

const state = {
  race: null,
  flags: null,
  selected: [], // driverId, порядок = порядок колонок
  overrides: new Map(), // "driverId:lap" → true/false, ручной клик
  paceThreshold: 1.07,
};

const $ = (id) => document.getElementById(id);
const els = {
  season: $('season'),
  race: $('race'),
  load: $('load'),
  threshold: $('threshold'),
  thresholdValue: $('threshold-value'),
  status: $('status'),
  drivers: $('drivers'),
  table: $('table'),
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

// --- расчёт и рендер -------------------------------------------------------

function render() {
  const { race, flags, selected, overrides, paceThreshold } = state;
  if (!race) return;

  const rows = computePace(race, flags, { selected, overrides, paceThreshold });

  if (!selected.length) {
    els.table.innerHTML = '<p class="hint">Выбери хотя бы одного пилота.</p>';
    return;
  }

  const head = (label, cell) =>
    `<tr class="meta"><th>${label}</th>${selected.map(cell).join('')}</tr>`;
  const byId = new Map(race.drivers.map((d) => [d.driverId, d]));
  const fmt = (v) => (v == null ? '—' : v.toFixed(3));

  let html = '<table><thead>';
  html += head(
    'Driver',
    (id) => `<th><button class="drop" data-driver="${id}" title="Убрать пилота">${byId.get(id)?.code || id}</button></th>`,
  );
  html += head('Team', (id) => `<td class="team">${byId.get(id)?.team || ''}</td>`);
  html += head('Pace', (id) => `<td class="pace">${fmt(rows.get(id).pace)}</td>`);
  html += head('Diff', (id) => {
    const r = rows.get(id);
    return `<td class="diff${r.best ? ' best' : ''}">${r.best ? 'BEST' : fmt(r.diff)}</td>`;
  });
  html += '</thead><tbody>';

  for (let lap = 1; lap <= race.lapCount; lap++) {
    html += `<tr><th><button class="lap" data-lap="${lap}" title="Переключить весь круг">${lap}</button></th>`;
    for (const id of selected) {
      const t = race.times.get(id)?.get(lap);
      if (t == null) {
        html += '<td class="empty">-</td>';
        continue;
      }
      const flag = flags.get(id)?.get(lap);
      const on = isIncluded(id, lap, flags, overrides);
      const outlier = rows.get(id).dropped.has(lap);
      const cls = ['cell', on ? 'on' : 'off', outlier ? 'outlier' : ''].filter(Boolean).join(' ');
      // Пит-круги показываем меткой, как в референсной таблице; при ручном
      // включении — настоящим временем, иначе непонятно, что пошло в темп.
      const label = !on && (flag === 'PIT' || flag === 'OUT' || flag === 'SC') ? flag : t.toFixed(3);
      html += `<td class="${cls}" data-driver="${id}" data-lap="${lap}" title="${t.toFixed(3)}${flag ? ' · ' + flag : ''}">${label}</td>`;
    }
    html += '</tr>';
  }
  els.table.innerHTML = html + '</tbody></table>';
}

function renderDriverChips() {
  els.drivers.innerHTML = state.race.drivers
    .map(
      (d) =>
        `<button class="chip${state.selected.includes(d.driverId) ? ' active' : ''}" data-driver="${d.driverId}" title="${d.name} · ${d.team}">${d.code}</button>`,
    )
    .join('');
}

// --- переключение кругов ---------------------------------------------------

function toggleLap(driverId, lap) {
  const k = key(driverId, lap);
  const next = !isIncluded(driverId, lap, state.flags, state.overrides);
  // Если ручное значение совпало с автоматическим — убираем override.
  if (next === !state.flags.get(driverId)?.get(lap)) state.overrides.delete(k);
  else state.overrides.set(k, next);
}

function toggleRow(lap) {
  const present = state.selected.filter((id) => state.race.times.get(id)?.has(lap));
  const anyOn = present.some((id) => isIncluded(id, lap, state.flags, state.overrides));
  for (const id of present) {
    if (isIncluded(id, lap, state.flags, state.overrides) === anyOn) toggleLap(id, lap);
  }
}

function toggleDriver(driverId) {
  const i = state.selected.indexOf(driverId);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(driverId);
}

// --- загрузка --------------------------------------------------------------

async function loadSeason() {
  const year = els.season.value;
  els.race.disabled = true;
  els.race.innerHTML = '<option>загружаю…</option>';
  try {
    const races = await fetchSeasonRaces(year);
    els.race.innerHTML = races
      .map((r) => `<option value="${r.round}">${r.round}. ${r.raceName}</option>`)
      .join('');
    els.race.disabled = false;
    // Последняя прошедшая гонка — самый частый интерес.
    const past = races.filter((r) => r.date <= new Date().toISOString().slice(0, 10));
    if (past.length) els.race.value = past[past.length - 1].round;
  } catch (e) {
    els.race.innerHTML = '<option>—</option>';
    setStatus(e.message, true);
  }
}

async function load() {
  els.load.disabled = true;
  els.table.innerHTML = '';
  els.drivers.innerHTML = '';
  try {
    const race = await fetchRace(els.season.value, els.race.value, setStatus);
    state.race = race;
    state.flags = flagLaps(race);
    state.overrides = new Map();
    state.selected = race.drivers
      .filter((d) => race.times.has(d.driverId))
      .slice(0, DEFAULT_DRIVERS)
      .map((d) => d.driverId);
    renderDriverChips();
    render();
    setStatus('');
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    els.load.disabled = false;
  }
}

// --- события ---------------------------------------------------------------

els.season.innerHTML = SEASONS.map((y) => `<option>${y}</option>`).join('');
els.season.addEventListener('change', loadSeason);
els.load.addEventListener('click', load);

els.threshold.addEventListener('input', () => {
  state.paceThreshold = els.threshold.value / 100;
  els.thresholdValue.textContent = `${els.threshold.value}%`;
  render();
});

els.drivers.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  toggleDriver(chip.dataset.driver);
  renderDriverChips();
  render();
});

// ponytail: полный ререндер таблицы на каждый клик; ~70×20 ячеек — незаметно.
// Начнёт тормозить — обновлять точечно только шапку Pace/Diff.
els.table.addEventListener('click', (e) => {
  const lapBtn = e.target.closest('.lap');
  if (lapBtn) return toggleRow(+lapBtn.dataset.lap), render();

  const drop = e.target.closest('.drop');
  if (drop) return toggleDriver(drop.dataset.driver), renderDriverChips(), render();

  const cell = e.target.closest('.cell');
  if (cell) return toggleLap(cell.dataset.driver, +cell.dataset.lap), render();
});

loadSeason();
