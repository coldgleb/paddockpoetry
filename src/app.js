import { fetchSeasonRaces, fetchRace } from './jolpica.js';
import { findSession, fetchExtras, fetchDriverSectors, FIRST_YEAR } from './openf1.js';
import {
  flagLaps, computePace, isIncluded, autoIncluded, formatLapTime, lapValue, METRICS, key,
} from './pace.js';
import { teamColor, onColor } from './teams.js';
import { renderChart } from './chart.js';
import { COMPOUNDS } from './tyres.js';

// Jolpica покрывает 2018+; резина, судейская и секторы — только с 2023.
const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];
const DEFAULT_DRIVERS = 5; // сразу показываем топ-5, остальных пилотов добавляет пользователь

const state = {
  race: null,
  flags: null,
  selected: [], // driverId (номер машины), порядок = порядок колонок
  overrides: new Map(), // "driverId:lap" → true/false, ручной клик
  range: null, // { from, to } — круги с X по Y
  manualSC: new Map(), // "driverId:lap" → 'SC'/'VSC'/false, пометка по пилоту
  manualTyres: [], // [{ driverId, from, to, compound }] — поверх данных OpenF1
  metric: 'lap', // что сравниваем: круг, сектор или сумма секторов
  source: 'jolpica', // откуда покруговка: 'jolpica' (быстро) | 'openf1' (секторы)
  sessionKey: null, // сессия OpenF1 для этой гонки, если нашлась
  loadingSectors: new Set(), // по кому секторы едут прямо сейчас
};

const $ = (id) => document.getElementById(id);
const els = {
  season: $('season'),
  race: $('race'),
  load: $('load'),
  source: $('source'),
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
  openf1Note: $('openf1-note'),
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
  const { race, flags, selected, overrides, range, metric } = state;
  if (!race) return;

  if (!selected.length) {
    els.table.innerHTML = '<p class="empty-state">Выбери хотя бы одного пилота выше.</p>';
    return;
  }

  const rows = computePace(race, flags, { selected, overrides, range, metric });
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
    // Кнопка в столбце кругов трогает всех выбранных сразу; поштучная правка —
    // значком в самой ячейке, ниже.
    const rowSC = selected.length && selected.every((id) => !!flags.scKind(id, lap));
    html +=
      `<tr><th class="lapno"><span class="lapcell">` +
      `<button class="lap" data-lap="${lap}" title="Переключить весь круг">${lap}</button>` +
      `<button class="sc-btn${rowSC ? ' on' : ''}" data-sc="${lap}" aria-pressed="${rowSC}" ` +
      `title="${rowSC ? 'Снять SC у всех выбранных' : 'Пометить SC у всех выбранных'}">SC</button>` +
      `</span></th>`;
    for (const id of selected) {
      const entry = race.laps.get(id)?.get(lap);
      const v = lapValue(entry, metric);
      const flag = flags.get(id)?.get(lap);
      const kind = flags.scKind(id, lap); // 'SC' | 'VSC' | null — состояние значка

      if (v == null) {
        // Четыре разные причины пустоты, и путать их нельзя.
        const why = state.loadingSectors.has(id)
          ? 'секторы загружаются'
          : entry
            ? `нет данных сектора (${METRICS[metric].label})`
            : isSectorMetric(metric) && state.source !== 'openf1'
              ? 'секторы есть только у OpenF1 — переключи источник'
              : 'круга нет в данных';
        html += `<td class="empty" data-driver="${id}" data-lap="${lap}" title="${why}">·</td>`;
        continue;
      }

      const on = isIncluded(id, lap, flags, overrides, range);
      const cls = ['cell', on ? 'on' : 'off'].join(' ');
      // Пит-круги показываем меткой, как на таймингах; при ручном включении —
      // настоящим временем, иначе непонятно, что именно пошло в темп.
      const marked = !on && (flag === 'PIT' || flag === 'OUT' || flag === 'SC' || flag === 'VSC');
      const label = marked ? `<span class="flag f-${flag}">${flag}</span>` : formatLapTime(v);

      // Резина: полоса слева на каждом круге стинта, буква — только на первом,
      // номер круга на комплекте — на каждом. Полоса читается как сплошной
      // блок стинта, буква даёт опознание без опоры на цвет.
      const t = tyreAt(id, lap);
      const c = t && COMPOUNDS[t.compound];
      const prev = tyreAt(id, lap - 1);
      const first = c && prev?.compound !== t.compound;
      const tyreAttr = c
        ? ` style="--comp:${c.color}"` + (first ? ` data-comp="${c.letter}"` : '')
        : '';
      const age = t?.age != null ? `<span class="age">${t.age}</span>` : '';

      const hint =
        `${formatLapTime(v)}` +
        `${c ? ` · ${c.name}, ${t.age}-й круг на комплекте` : ''}` +
        `${flag ? ' · ' + flag : ''}`;
      html +=
        `<td class="${cls}${c ? ' has-tyre' : ''}" data-driver="${id}" data-lap="${lap}" ` +
        `title="${hint}"${tyreAttr}>${age}${label}` +
        `<button class="cell-sc${kind ? ' on' : ''}" data-cellsc="${id}:${lap}" ` +
        `title="${kind ? `Снять ${kind} у этого пилота` : 'Пометить SC только этому пилоту'}">` +
        `${kind || 'SC'}</button></td>`;
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

// На графике только зачётные круги — те же точки, что дали темп. Разрывы
// (пит, SC, ручные выключения) рисуются пунктиром.
function renderChartPanel() {
  const { race, flags, selected, overrides, range, metric } = state;
  if (!race) return;
  const rows = computePace(race, flags, { selected, overrides, range, metric });
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
  els.drivers.innerHTML = state.race.drivers
    .map((d) => {
      const c = teamColor(d.team);
      const active = state.selected.includes(d.id);
      const busy = state.loadingSectors.has(d.id); // секторы едут прямо сейчас
      const style = active
        ? `background:${c};border-color:${c};color:${onColor(c)}`
        : `--team:${c}`;
      const hint = `${d.name} · ${d.team}${busy ? ' · загружаю секторы' : ''}`;
      return (
        `<button class="chip${active ? ' active' : ''}${busy ? ' busy' : ''}" style="${style}" ` +
        `data-driver="${d.id}"${busy ? ' aria-busy="true"' : ''} title="${hint}">${d.code}</button>`
      );
    })
    .join('');
}

function renderMeta() {
  const r = state.race;
  els.meta.hidden = !r;
  if (!r) return;
  const src = state.source === 'openf1' ? 'секторы OpenF1' : 'круги Jolpica';
  els.meta.innerHTML =
    `<strong>${r.raceName}</strong><span>${r.season}</span><span>${r.date}</span>` +
    `<span>${r.lapCount} кругов</span><span>${r.laps.size} пилотов</span><span>${src}</span>`;
}

// --- резина ----------------------------------------------------------------

// Ручные отрезки главнее данных OpenF1 и перекрывают друг друга снизу вверх:
// последний добавленный выигрывает, так что ошибку можно переписать новой
// записью, не удаляя старую. Возраст комплекта у ручного отрезка считаем от
// его начала — откуда бы нам знать реальный пробег.
function tyreAt(driverId, lap) {
  for (let i = state.manualTyres.length - 1; i >= 0; i--) {
    const m = state.manualTyres[i];
    if (m.driverId === driverId && lap >= m.from && lap <= m.to) {
      return { compound: m.compound, age: lap - m.from + 1 };
    }
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

function refreshFlags() {
  state.flags = flagLaps(state.race, { manualSC: state.manualSC });
}

// Пометка SC у одного пилота на одном круге. Судейская даёт номер круга по
// лидеру, а круговые в этот момент на круг позади — поэтому правка поштучная.
// PIT и OUT пометка не перекрывает: приоритет задан порядком в flagLaps.
function toggleCellSC(driverId, lap) {
  const k = key(driverId, lap);
  const kind = state.flags.scKind(driverId, lap);
  const auto = state.race?.sc?.get(lap) || null;
  // Если ручное значение совпало с тем, что и так следует из данных, override
  // не держим — иначе он «залипнет» после смены источника или сброса.
  const next = kind ? false : 'SC';
  if ((next || null) === auto) state.manualSC.delete(k);
  else state.manualSC.set(k, next);
  refreshFlags();
  render();
}

// Кнопка в столбце кругов: применить ко всем выбранным разом.
function toggleRowSC(lap) {
  const anyOff = state.selected.some((id) => !state.flags.scKind(id, lap));
  for (const id of state.selected) {
    const k = key(id, lap);
    const auto = state.race?.sc?.get(lap) || null;
    const next = anyOff ? 'SC' : false;
    if ((next || null) === auto) state.manualSC.delete(k);
    else state.manualSC.set(k, next);
  }
  refreshFlags();
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
  const i = state.selected.indexOf(driverId);
  if (i >= 0) state.selected.splice(i, 1);
  else state.selected.push(driverId);
  // Колонки держим в порядке финиша, иначе добавленный пилот прыгает в конец.
  const order = state.race.drivers.map((d) => d.id);
  state.selected.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // Круги у нового пилота уже есть — Jolpica отдала всю гонку сразу. Догрузить
  // может понадобиться только секторы, и только если их сейчас показывают.
  ensureSectors();
}

// --- секторы по требованию -------------------------------------------------

const isSectorMetric = (metric) => !!METRICS[metric]?.parts;

// Ленивая загрузка нужна только секторам: целые круги Jolpica отдаёт всей
// гонкой за пару секунд, дробить нечего. Секторы же тянутся по одному пилоту
// и только когда их правда показывают — при метрике «весь круг» они не нужны,
// даже если источник переключён на OpenF1.
let sectorQueue = Promise.resolve();

function ensureSectors() {
  if (!isSectorMetric(state.metric)) return;
  if (state.source !== 'openf1' || !state.sessionKey || !state.race) return;
  const race = state.race;
  for (const id of state.selected) {
    if (race.sectorsFor.has(id) || state.loadingSectors.has(id)) continue;
    state.loadingSectors.add(id);
    sectorQueue = sectorQueue.then(async () => {
      if (state.race !== race || !state.selected.includes(id)) {
        state.loadingSectors.delete(id); // гонку сменили или пилота убрали
        return;
      }
      try {
        const byLap = await fetchDriverSectors(state.sessionKey, id);
        // Секторы доливаем в те же объекты кругов, что пришли от Jolpica:
        // так у нас полный список кругов и секторы там, где OpenF1 их знает.
        const laps = race.laps.get(id);
        if (laps) {
          for (const [lap, s] of byLap) Object.assign(laps.get(lap) || {}, s);
        }
        race.sectorsFor.add(id);
      } finally {
        state.loadingSectors.delete(id);
        if (state.race === race) {
          renderDriverChips();
          render();
          setStatus(state.loadingSectors.size ? 'Загружаю секторы…' : '');
        }
      }
    });
  }
  if (state.loadingSectors.size) {
    renderDriverChips();
    setStatus('Загружаю секторы…');
  }
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
      .map((r) => `<option value="${r.round}">${r.round}. ${r.name}</option>`)
      .join('');
    els.race.disabled = false;
    // Последняя прошедшая гонка — самый частый интерес.
    els.race.value = races[races.length - 1].round;
  } catch (e) {
    els.race.innerHTML = '<option>—</option>';
    setStatus(e.message, true);
  }
}

function syncLapInputs() {
  const max = state.race?.lapCount || 1;
  els.lapFrom.max = els.lapTo.max = els.tyreFrom.max = els.tyreTo.max = max;
  els.lapFrom.value = state.range?.from ?? 1;
  els.lapTo.value = state.range?.to ?? max;
  els.tyreFrom.value = 1;
  els.tyreTo.value = max;
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
  els.tyrePanel.hidden = true;
  els.openf1Note.hidden = true;
  state.loadingSectors.clear();
  try {
    const year = Number(els.season.value);
    const race = await fetchRace(year, Number(els.race.value), setStatus);
    state.race = race;
    state.sessionKey = null;
    state.manualSC = new Map();
    state.manualTyres = [];
    state.overrides = new Map();
    state.rangeTouched = false;
    state.range = { from: 1, to: race.lapCount };
    state.selected = race.drivers.slice(0, DEFAULT_DRIVERS).map((d) => d.id);
    refreshFlags();
    syncLapInputs();
    renderMeta();
    renderDriverChips();
    renderTyrePanel();
    els.legend.hidden = false;
    els.range.hidden = false;
    els.chartPanel.hidden = false;
    render();

    // Резина и судейская — из OpenF1, один быстрый запрос на каждое. Таблица
    // уже на экране, так что их отсутствие ничего не задерживает.
    const sessionKey = await findSession(year, race.date);
    if (state.race !== race) return;
    state.sessionKey = sessionKey;
    if (sessionKey) {
      const { sc, tyres } = await fetchExtras(sessionKey);
      if (state.race !== race) return;
      race.sc = sc;
      race.tyres = tyres;
      refreshFlags();
      renderTyrePanel();
      render();
    }
    els.openf1Note.hidden = !!sessionKey;
    ensureSectors();
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

els.lapFrom.addEventListener('input', applyRange);
els.lapTo.addEventListener('input', applyRange);
els.lapReset.addEventListener('click', resetRange);

els.metric.innerHTML = Object.entries(METRICS)
  .map(([k, m]) => `<option value="${k}">${m.label}</option>`)
  .join('');
els.metric.addEventListener('change', () => {
  state.metric = els.metric.value;
  // Секторы есть только у OpenF1, так что выбор сектора сам переключает
  // источник — иначе он молча не сработал бы.
  if (isSectorMetric(state.metric) && state.source !== 'openf1') {
    state.source = 'openf1';
    els.source.value = 'openf1';
    setStatus('Секторы есть только у OpenF1 — переключил источник.');
  }
  renderMeta();
  ensureSectors();
  render();
});

els.source.addEventListener('change', () => {
  state.source = els.source.value;
  if (state.source === 'jolpica' && isSectorMetric(state.metric)) {
    // Обратный переход на Jolpica несовместим с секторной метрикой.
    state.metric = 'lap';
    els.metric.value = 'lap';
    setStatus('Jolpica отдаёт только целые круги — метрика вернулась к кругу.');
  } else {
    setStatus('');
  }
  renderMeta();
  ensureSectors();
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
  // Значок SC внутри ячейки проверяем первым — он лежит поверх самой ячейки.
  const cellSC = e.target.closest('.cell-sc');
  if (cellSC) {
    const [id, lap] = cellSC.dataset.cellsc.split(':');
    return toggleCellSC(Number(id), Number(lap));
  }

  const scBtn = e.target.closest('.sc-btn');
  if (scBtn) return toggleRowSC(+scBtn.dataset.sc);

  const lapBtn = e.target.closest('.lap');
  if (lapBtn) return toggleRow(+lapBtn.dataset.lap), render();

  const drop = e.target.closest('.drop');
  if (drop) return toggleDriver(driverOf(drop)), renderDriverChips(), render();

  const cell = e.target.closest('.cell');
  if (cell) return toggleLap(driverOf(cell), +cell.dataset.lap), render();
});

loadSeason();
