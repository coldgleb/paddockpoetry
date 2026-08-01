import { fetchSeasonRaces, fetchRace } from './openf1.js';
import {
  flagLaps, computePace, isIncluded, autoIncluded, formatLapTime, lapValue, METRICS, key,
} from './pace.js';
import { teamColor, onColor } from './teams.js';
import { renderChart } from './chart.js';
import { COMPOUNDS } from './tyres.js';

// OpenF1 начинается с 2023 года — раньше данных просто нет.
const SEASONS = [2026, 2025, 2024, 2023];
const DEFAULT_DRIVERS = 5; // сразу показываем топ-5, остальных пилотов добавляет пользователь

const state = {
  race: null,
  flags: null,
  selected: [], // driverId (номер машины), порядок = порядок колонок
  overrides: new Map(), // "driverId:lap" → true/false, ручной клик
  paceThreshold: 1.02,
  range: null, // { from, to } — круги с X по Y
  manualSC: new Map(), // круг → 'SC'/'VSC'/false, ручная пометка
  manualTyres: [], // [{ driverId, from, to, compound }] — поверх данных OpenF1
  metric: 'lap', // что сравниваем: круг, сектор или сумма секторов
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
  metric: $('metric'),
  tyrePanel: $('tyre-panel'),
  tyreDriver: $('tyre-driver'),
  tyreFrom: $('tyre-from'),
  tyreTo: $('tyre-to'),
  tyreCompound: $('tyre-compound'),
  tyreAdd: $('tyre-add'),
  tyreList: $('tyre-list'),
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
  const { race, flags, selected, overrides, paceThreshold, range, metric } = state;
  if (!race) return;

  if (!selected.length) {
    els.table.innerHTML = '<p class="empty-state">Выбери хотя бы одного пилота выше.</p>';
    return;
  }

  const rows = computePace(race, flags, { selected, overrides, paceThreshold, range, metric });
  const byId = new Map(race.drivers.map((d) => [d.id, d]));
  const color = (id) => teamColor(byId.get(id)?.team);

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

  // В заголовке пишем метрику: иначе непонятно, круг это или сектор.
  html += `<tr class="r-pace"><th class="corner">Темп<em>${METRICS[metric].label}</em></th>${selected
    .map((id) => `<td>${formatLapTime(rows.get(id).pace)}</td>`)
    .join('')}</tr>`;

  html += `<tr class="r-diff"><th class="corner">Отставание</th>${selected
    .map((id) => {
      const r = rows.get(id);
      if (r.best) return '<td class="best"><span class="tag-best">BEST</span></td>';
      return `<td>${fmt(r.diff)}</td>`;
    })
    .join('')}</tr>`;

  html += '</thead><tbody>';

  // Показываем только выбранные круги — остальных в таблице нет.
  const from = range?.from ?? 1;
  const to = range?.to ?? race.lapCount;
  for (let lap = from; lap <= to; lap++) {
    const sc = isSC(lap);
    html +=
      `<tr><th class="lapno"><span class="lapcell">` +
      `<button class="lap" data-lap="${lap}" title="Переключить весь круг">${lap}</button>` +
      `<button class="sc-btn${sc ? ' on' : ''}" data-sc="${lap}" aria-pressed="${sc}" ` +
      `title="${sc ? 'Снять машину безопасности с круга' : 'Пометить круг машиной безопасности'}">SC</button>` +
      `</span></th>`;
    for (const id of selected) {
      const entry = race.laps.get(id)?.get(lap);
      const v = lapValue(entry, metric);
      if (v == null) {
        // Три разных причины пустоты, и путать их нельзя: пилот ещё грузится,
        // OpenF1 не отдал круг вовсе, или у круга нет нужного сектора.
        const why = race.pending?.has(id)
          ? 'загружается'
          : entry
            ? `нет сектора (${METRICS[metric].label})`
            : 'OpenF1 не отдал этот круг';
        html += `<td class="empty" title="${why}">·</td>`;
        continue;
      }
      const flag = flags.get(id)?.get(lap);
      const on = isIncluded(id, lap, flags, overrides, range);
      const outlier = rows.get(id).dropped.has(lap);
      const cls = ['cell', on ? (outlier ? 'outlier' : 'on') : 'off'].join(' ');
      // Пит-круги показываем меткой, как на таймингах; при ручном включении —
      // настоящим временем, иначе непонятно, что именно пошло в темп.
      const marked = !on && (flag === 'PIT' || flag === 'OUT' || flag === 'SC' || flag === 'VSC');
      const label = marked ? `<span class="flag f-${flag}">${flag}</span>` : formatLapTime(v);

      // Резина: полоса слева на каждом круге стинта, буква — только на первом.
      // Полоса читается как сплошной блок стинта, буква даёт опознание без
      // опоры на цвет (софт и хард различаются красным и белым).
      const comp = compoundAt(id, lap);
      const c = comp && COMPOUNDS[comp];
      const first = c && compoundAt(id, lap - 1) !== comp;
      const tyre = c
        ? ` style="--comp:${c.color}"` +
          (first ? ` data-comp="${c.letter}"` : '')
        : '';

      const hint = `${formatLapTime(v)}${c ? ' · ' + c.name : ''}` +
        `${flag ? ' · ' + flag : ''}${outlier ? ' · выброс' : ''}`;
      html += `<td class="${cls}${c ? ' has-tyre' : ''}" data-driver="${id}" data-lap="${lap}" title="${hint}"${tyre}>${label}</td>`;
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

// На графике только зачётные круги — те же точки, что дали темп. Круги,
// не прошедшие порог, из графика убраны, разрыв рисуется пунктиром.
function renderChartPanel() {
  const { race, flags, selected, overrides, paceThreshold, range, metric } = state;
  if (!race) return;
  const rows = computePace(race, flags, { selected, overrides, paceThreshold, range, metric });
  const byId = new Map(race.drivers.map((d) => [d.id, d]));
  const win = range || { from: 1, to: race.lapCount };

  renderChart(
    els.chart,
    selected.map((id) => ({
      id,
      code: byId.get(id)?.code || id,
      color: teamColor(byId.get(id)?.team),
      points: rows.get(id).points, // только зачётные круги — те же, что дали темп
    })),
    win,
  );
}

function renderDriverChips() {
  const pending = state.race.pending || new Set();
  els.drivers.innerHTML = state.race.drivers
    .map((d) => {
      const c = teamColor(d.team);
      const active = state.selected.includes(d.id);
      const wait = pending.has(d.id); // покруговка ещё едет
      const style = active
        ? `background:${c};border-color:${c};color:${onColor(c)}`
        : `--team:${c}`;
      const hint = `${d.name} · ${d.team}${wait ? ' · покруговка ещё загружается' : ''}`;
      return `<button class="chip${active ? ' active' : ''}${wait ? ' pending' : ''}" style="${style}" data-driver="${d.id}" title="${hint}">${d.code}</button>`;
    })
    .join('');
}

function renderMeta() {
  const r = state.race;
  els.meta.hidden = !r;
  if (!r) return;
  els.meta.innerHTML =
    `<strong>${r.raceName}</strong><span>${r.season}</span><span>${r.date}</span>` +
    `<span>${r.lapCount} кругов</span><span>${r.laps.size} пилотов</span>`;
}

// --- резина ----------------------------------------------------------------

// Ручные отрезки главнее данных OpenF1 и перекрывают друг друга снизу вверх:
// последний добавленный выигрывает, так что ошибку можно переписать новой
// записью, не удаляя старую.
function compoundAt(driverId, lap) {
  for (let i = state.manualTyres.length - 1; i >= 0; i--) {
    const m = state.manualTyres[i];
    if (m.driverId === driverId && lap >= m.from && lap <= m.to) return m.compound;
  }
  return state.race?.tyres?.get(driverId)?.get(lap) || null;
}

function renderTyrePanel() {
  const race = state.race;
  els.tyrePanel.hidden = !race;
  if (!race) return;

  if (!els.tyreDriver.options.length || els.tyreDriver.dataset.key !== String(race.sessionKey)) {
    els.tyreDriver.dataset.key = String(race.sessionKey);
    els.tyreDriver.innerHTML = race.drivers
      .map((d) => `<option value="${d.id}">${d.code} · ${d.team}</option>`)
      .join('');
    els.tyreCompound.innerHTML = Object.entries(COMPOUNDS)
      .filter(([k]) => k !== 'UNKNOWN')
      .map(([k, c]) => `<option value="${k}">${c.name}</option>`)
      .join('');
    els.tyreFrom.max = els.tyreTo.max = race.lapCount;
  }

  const byId = new Map(race.drivers.map((d) => [d.id, d]));
  els.tyreList.innerHTML = state.manualTyres
    .map((m, i) => {
      const c = COMPOUNDS[m.compound];
      return (
        `<span class="tyre-chip" style="--comp:${c.color}">` +
        `${byId.get(m.driverId)?.code || m.driverId} · круги ${m.from}–${m.to} · ${c.name}` +
        `<button data-remove="${i}" title="Убрать">×</button></span>`
      );
    })
    .join('');
}

function addManualTyre() {
  const race = state.race;
  if (!race) return;
  const clamp = (v) => Math.min(Math.max(parseInt(v, 10) || 1, 1), race.lapCount);
  const a = clamp(els.tyreFrom.value);
  const b = clamp(els.tyreTo.value);
  state.manualTyres.push({
    driverId: Number(els.tyreDriver.value),
    from: Math.min(a, b), // перевёрнутый ввод читаем как тот же отрезок
    to: Math.max(a, b),
    compound: els.tyreCompound.value,
  });
  renderTyrePanel();
  renderTable();
}

// --- переключение кругов ---------------------------------------------------

const included = (id, lap) =>
  isIncluded(id, lap, state.flags, state.overrides, state.range);

// Круг под машиной безопасности. Ручную пометку проверяем первой: если на
// этом круге все пилоты в боксах, флага не будет ни у кого, а пометка стоит.
function isSC(lap) {
  if (state.manualSC.has(lap)) return !!state.manualSC.get(lap);
  return state.race?.sc?.has(lap) || false;
}

// SC — состояние трассы, а не пилота, поэтому ставится на весь круг сразу.
// PIT и OUT он не перекрывает: приоритет задан порядком проверок в flagLaps.
function toggleSC(lap) {
  state.manualSC.set(lap, isSC(lap) ? false : 'SC');
  state.flags = flagLaps(state.race, { manualSC: state.manualSC });
  render();
}

function toggleLap(driverId, lap) {
  const k = key(driverId, lap);
  const next = !included(driverId, lap);
  // Если ручное значение совпало с автоматическим — убираем override,
  // иначе после сброса диапазона остались бы «залипшие» круги.
  if (next === autoIncluded(driverId, lap, state.flags, state.range)) state.overrides.delete(k);
  else state.overrides.set(k, next);
}

function toggleRow(lap) {
  const present = state.selected.filter((id) => state.race.laps.get(id)?.has(lap));
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
  state.rangeTouched = true; // дальше сами не расширяем
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
  state.selectionTouched = true; // дальше сами топ-5 не подставляем
  const i = state.selected.indexOf(driverId);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(driverId);
  // Колонки держим в порядке финиша, иначе добавленный пилот прыгает в конец.
  const order = state.race.drivers.map((d) => d.id);
  state.selected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

// --- загрузка --------------------------------------------------------------

async function loadSeason() {
  const year = els.season.value;
  els.race.disabled = true;
  els.race.innerHTML = '<option>загружаю…</option>';
  try {
    const races = await fetchSeasonRaces(year);
    if (!races.length) throw new Error('В этом сезоне ещё нет прошедших гонок');
    els.race.innerHTML = races
      .map((r) => `<option value="${r.sessionKey}">${r.round}. ${r.name}</option>`)
      .join('');
    els.race.disabled = false;
    // Последняя прошедшая гонка — самый частый интерес.
    els.race.value = races[races.length - 1].sessionKey;
  } catch (e) {
    els.race.innerHTML = '<option>—</option>';
    setStatus(e.message, true);
  }
}

// Поля кругов и границы диапазона зависят от lapCount, а он растёт по мере
// дозагрузки пилотов — держим их в одном месте.
function syncLapInputs() {
  const max = state.race?.lapCount || 1;
  els.lapFrom.max = els.lapTo.max = els.tyreFrom.max = els.tyreTo.max = max;
  els.lapFrom.value = state.range?.from ?? 1;
  els.lapTo.value = state.range?.to ?? max;
  els.tyreFrom.value = 1;
  els.tyreTo.value = max;
}

// Приехала очередная порция пилотов: дополняем то, что уже на экране.
function onRaceUpdate(race) {
  if (state.race !== race) return; // пользователь успел переключить гонку
  state.flags = flagLaps(race, { manualSC: state.manualSC });
  // Диапазон расширяем только если его не трогали руками.
  if (!state.rangeTouched) {
    state.range = { from: 1, to: race.lapCount };
    syncLapInputs();
  }
  // Доводим выбор до топ-5, пока пользователь сам не вмешался.
  if (!state.selectionTouched) {
    state.selected = race.drivers
      .filter((d) => race.laps.has(d.id))
      .slice(0, DEFAULT_DRIVERS)
      .map((d) => d.id);
  }
  renderMeta();
  renderDriverChips();
  renderTyrePanel();
  render();
}

async function load() {
  state.selectionTouched = false;
  els.load.disabled = true;
  els.table.innerHTML = '';
  els.chart.innerHTML = '';
  els.drivers.innerHTML = '';
  els.legend.hidden = true;
  els.meta.hidden = true;
  els.range.hidden = true;
  els.chartPanel.hidden = true;
  els.tyrePanel.hidden = true;
  try {
    // Ждём только первых пилотов, остальные приезжают в onUpdate.
    const race = await fetchRace(Number(els.race.value), setStatus, onRaceUpdate);
    state.race = race;
    state.manualSC = new Map();
    state.manualTyres = [];
    state.flags = flagLaps(race);
    state.overrides = new Map();
    state.rangeTouched = false;
    state.range = { from: 1, to: race.lapCount };
    state.selected = race.drivers
      .filter((d) => race.laps.has(d.id))
      .slice(0, DEFAULT_DRIVERS)
      .map((d) => d.id);
    syncLapInputs();
    renderMeta();
    renderDriverChips();
    renderTyrePanel();
    els.legend.hidden = false;
    els.range.hidden = false;
    els.chartPanel.hidden = false;
    render();
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

els.metric.innerHTML = Object.entries(METRICS)
  .map(([k, m]) => `<option value="${k}">${m.label}</option>`)
  .join('');
els.metric.addEventListener('change', () => {
  state.metric = els.metric.value;
  render();
});

els.tyreAdd.addEventListener('click', addManualTyre);
els.tyreList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  state.manualTyres.splice(+btn.dataset.remove, 1);
  renderTyrePanel();
  renderTable();
});

// Ширина графика зависит от вёрстки — при ресайзе перерисовываем только его.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderChartPanel, 120);
});

// data-атрибуты всегда строки, а пилоты теперь опознаются номером машины.
// Без приведения к числу Map.get промахивался и колонка приходила пустой.
const driverOf = (el) => Number(el.dataset.driver);

els.drivers.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  toggleDriver(driverOf(chip));
  renderDriverChips();
  render();
});

// ponytail: полный ререндер таблицы на каждый клик; ~70×20 ячеек — незаметно.
// Начнёт тормозить — обновлять точечно только шапку с темпом и отставанием.
els.table.addEventListener('click', (e) => {
  const scBtn = e.target.closest('.sc-btn');
  if (scBtn) return toggleSC(+scBtn.dataset.sc);

  const lapBtn = e.target.closest('.lap');
  if (lapBtn) return toggleRow(+lapBtn.dataset.lap), render();

  const drop = e.target.closest('.drop');
  if (drop) return toggleDriver(driverOf(drop)), renderDriverChips(), render();

  const cell = e.target.closest('.cell');
  if (cell) return toggleLap(driverOf(cell), +cell.dataset.lap), render();
});

loadSeason();
