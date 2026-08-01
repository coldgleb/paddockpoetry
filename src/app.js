import { fetchSeasonRaces, fetchRace } from './jolpica.js';
import { flagLaps, computePace, isIncluded, autoIncluded, formatLapTime, key } from './pace.js';
import { teamColor, onColor } from './teams.js';
import { renderChart } from './chart.js';

const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
const DEFAULT_DRIVERS = 5; // сразу показываем топ-5, остальных пилотов добавляет пользователь

const state = {
  race: null,
  flags: null,
  selected: [], // driverId, порядок = порядок колонок
  overrides: new Map(), // "driverId:lap" → true/false, ручной клик
  paceThreshold: 1.07,
  range: null, // { from, to } — круги с X по Y
};

const $ = (id) => document.getElementById(id);
const els = {
  season: $('season'),
  race: $('race'),
  load: $('load'),
  threshold: $('threshold'),
  thresholdValue: $('threshold-value'),
  status: $('status'),
  meta: $('meta'),
  drivers: $('drivers'),
  legend: $('legend'),
  table: $('table'),
  chart: $('chart'),
  chartPanel: $('chart-panel'),
  range: $('range'),
  lapFrom: $('lap-from'),
  lapTo: $('lap-to'),
  lapReset: $('lap-reset'),
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

const fmt = (v) => (v == null ? '—' : v.toFixed(3));

// --- расчёт и рендер -------------------------------------------------------

function render() {
  renderTable();
  renderChartPanel();
}

function renderTable() {
  const { race, flags, selected, overrides, paceThreshold, range } = state;
  if (!race) return;

  if (!selected.length) {
    els.table.innerHTML = '<p class="empty-state">Выбери хотя бы одного пилота выше.</p>';
    return;
  }

  const rows = computePace(race, flags, { selected, overrides, paceThreshold, range });
  const byId = new Map(race.drivers.map((d) => [d.driverId, d]));
  const color = (id) => teamColor(byId.get(id)?.constructorId);

  // Ширину столбца кругов задаём через <col>; цвет команды туда не вешаем —
  // на колонки наследуются только background/border/width, но не переменные.
  let html = '<table><colgroup><col class="lapcol" /></colgroup><thead>';

  html += `<tr class="r-driver"><th class="corner">Пилот</th>${selected
    .map((id) => {
      const c = color(id);
      const d = byId.get(id);
      return `<th style="--team:${c}"><button class="drop" data-driver="${id}" title="${d?.name || id} · убрать колонку">${d?.code || id}</button></th>`;
    })
    .join('')}</tr>`;

  html += `<tr class="r-team"><th class="corner">Команда</th>${selected
    .map((id) => `<td>${byId.get(id)?.team || ''}</td>`)
    .join('')}</tr>`;

  html += `<tr class="r-pace"><th class="corner">Темп</th>${selected
    .map((id) => {
      const p = rows.get(id).pace;
      return `<td>${formatLapTime(p)}</td>`;
    })
    .join('')}</tr>`;

  html += `<tr class="r-diff"><th class="corner">Отставание</th>${selected
    .map((id) => {
      const r = rows.get(id);
      if (r.best) return '<td class="best"><span class="tag-best">BEST</span></td>';
      return `<td>${fmt(r.diff)}</td>`;
    })
    .join('')}</tr>`;

  html += '</thead><tbody>';

  for (let lap = 1; lap <= race.lapCount; lap++) {
    html += `<tr><th class="lapno"><button class="lap" data-lap="${lap}" title="Переключить весь круг">${lap}</button></th>`;
    for (const id of selected) {
      const t = race.times.get(id)?.get(lap);
      if (t == null) {
        html += '<td class="empty">·</td>';
        continue;
      }
      const flag = flags.get(id)?.get(lap);
      const on = isIncluded(id, lap, flags, overrides, range);
      const outlier = rows.get(id).dropped.has(lap);
      const cls = ['cell', on ? (outlier ? 'outlier' : 'on') : 'off'].join(' ');
      // Пит-круги показываем меткой, как на таймингах; при ручном включении —
      // настоящим временем, иначе непонятно, что именно пошло в темп.
      const marked = !on && (flag === 'PIT' || flag === 'OUT' || flag === 'SC');
      const label = marked ? `<span class="flag f-${flag}">${flag}</span>` : formatLapTime(t);
      const hint = `${formatLapTime(t)}${flag ? ' · ' + flag : ''}${outlier ? ' · выброс' : ''}`;
      html += `<td class="${cls}" data-driver="${id}" data-lap="${lap}" title="${hint}">${label}</td>`;
    }
    html += '</tr>';
  }
  els.table.innerHTML = html + '</tbody></table>';
  stickHeader();
}

// Каждая строка шапки липнет на сумме высот строк над ней. Меряем по факту:
// height у ячеек таблицы — не гарантия, и фиксированные смещения разъезжались.
// Высоты дробные, поэтому берём getBoundingClientRect, а не offsetHeight:
// округление копится от строки к строке и оставляет щели, сквозь которые
// просвечивают круги.
function stickHeader() {
  let top = 0;
  for (const tr of els.table.querySelectorAll('thead tr')) {
    for (const cell of tr.children) cell.style.top = `${top}px`;
    top += tr.getBoundingClientRect().height;
  }
}

// На графике — все круги пилота в выбранном окне, линия сплошная. Те, что
// не пошли в темп, помечаются полой точкой, а не разрывом линии.
function renderChartPanel() {
  const { race, flags, selected, overrides, paceThreshold, range } = state;
  if (!race) return;
  const rows = computePace(race, flags, { selected, overrides, paceThreshold, range });
  const byId = new Map(race.drivers.map((d) => [d.driverId, d]));
  const win = range || { from: 1, to: race.lapCount };

  renderChart(
    els.chart,
    selected.map((id) => {
      const counted = new Set(rows.get(id).points.map(([lap]) => lap));
      const points = [];
      const excluded = new Set();
      for (const [lap, v] of race.times.get(id) || []) {
        if (lap < win.from || lap > win.to) continue;
        points.push([lap, v]);
        if (!counted.has(lap)) excluded.add(lap);
      }
      return {
        id,
        code: byId.get(id)?.code || id,
        color: teamColor(byId.get(id)?.constructorId),
        points,
        excluded,
      };
    }),
    win,
  );
}

function renderDriverChips() {
  els.drivers.innerHTML = state.race.drivers
    .map((d) => {
      const c = teamColor(d.constructorId);
      const active = state.selected.includes(d.driverId);
      const style = active
        ? `background:${c};border-color:${c};color:${onColor(c)}`
        : `--team:${c}`;
      return `<button class="chip${active ? ' active' : ''}" style="${style}" data-driver="${d.driverId}" title="${d.name} · ${d.team}">${d.code}</button>`;
    })
    .join('');
}

function renderMeta() {
  const r = state.race;
  els.meta.hidden = !r;
  if (!r) return;
  els.meta.innerHTML =
    `<strong>${r.raceName}</strong><span>${r.season}, этап ${r.round}</span>` +
    `<span>${r.lapCount} кругов</span><span>${r.times.size} пилотов</span>`;
}

// --- переключение кругов ---------------------------------------------------

const included = (id, lap) =>
  isIncluded(id, lap, state.flags, state.overrides, state.range);

function toggleLap(driverId, lap) {
  const k = key(driverId, lap);
  const next = !included(driverId, lap);
  // Если ручное значение совпало с автоматическим — убираем override,
  // иначе после сброса диапазона остались бы «залипшие» круги.
  if (next === autoIncluded(driverId, lap, state.flags, state.range)) state.overrides.delete(k);
  else state.overrides.set(k, next);
}

function toggleRow(lap) {
  const present = state.selected.filter((id) => state.race.times.get(id)?.has(lap));
  const anyOn = present.some((id) => included(id, lap));
  for (const id of present) {
    if (included(id, lap) === anyOn) toggleLap(id, lap);
  }
}

// Диапазон кругов «с X по Y». Поля не переписываем на каждом нажатии —
// иначе набор «40» при верхней границе 21 дёргал бы ввод из-под пальцев.
// Границы просто сортируем: перевёрнутый ввод читается как тот же интервал.
function applyRange() {
  const max = state.race?.lapCount || 1;
  const clamp = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : dflt;
  };
  const a = clamp(els.lapFrom.value, 1);
  const b = clamp(els.lapTo.value, max);
  state.range = { from: Math.min(a, b), to: Math.max(a, b) };
  render();
}

function resetRange() {
  const max = state.race?.lapCount || 1;
  els.lapFrom.value = 1;
  els.lapTo.value = max;
  state.range = { from: 1, to: max };
  render();
}

function toggleDriver(driverId) {
  const i = state.selected.indexOf(driverId);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(driverId);
  // Колонки держим в порядке финиша, иначе добавленный пилот прыгает в конец.
  const order = state.race.drivers.map((d) => d.driverId);
  state.selected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
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
  els.chart.innerHTML = '';
  els.drivers.innerHTML = '';
  els.legend.hidden = true;
  els.meta.hidden = true;
  els.range.hidden = true;
  els.chartPanel.hidden = true;
  try {
    const race = await fetchRace(els.season.value, els.race.value, setStatus);
    state.race = race;
    state.flags = flagLaps(race);
    state.overrides = new Map();
    state.range = { from: 1, to: race.lapCount };
    state.selected = race.drivers
      .filter((d) => race.times.has(d.driverId))
      .slice(0, DEFAULT_DRIVERS)
      .map((d) => d.driverId);
    els.lapFrom.max = els.lapTo.max = race.lapCount;
    els.lapFrom.value = 1;
    els.lapTo.value = race.lapCount;
    renderMeta();
    renderDriverChips();
    els.legend.hidden = false;
    els.range.hidden = false;
    els.chartPanel.hidden = false;
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

els.lapFrom.addEventListener('input', applyRange);
els.lapTo.addEventListener('input', applyRange);
els.lapReset.addEventListener('click', resetRange);

// Ширина графика зависит от вёрстки — при ресайзе перерисовываем только его.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChartPanel, 120);
});

els.drivers.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  toggleDriver(chip.dataset.driver);
  renderDriverChips();
  render();
});

// ponytail: полный ререндер таблицы на каждый клик; ~70×20 ячеек — незаметно.
// Начнёт тормозить — обновлять точечно только шапку с темпом и отставанием.
els.table.addEventListener('click', (e) => {
  const lapBtn = e.target.closest('.lap');
  if (lapBtn) return toggleRow(+lapBtn.dataset.lap), render();

  const drop = e.target.closest('.drop');
  if (drop) return toggleDriver(drop.dataset.driver), renderDriverChips(), render();

  const cell = e.target.closest('.cell');
  if (cell) return toggleLap(cell.dataset.driver, +cell.dataset.lap), render();
});

loadSeason();
