// Вкладка «Квалификация · сокомандники»: за выбранный сезон и команду —
// таблица гэпа между напарниками по каждому этапу. Данные из f1api.dev
// (f1api.js), расчёт — в qualifying.js; здесь только DOM и события.

import { fetchSeasonQualifying, fetchSeasonTeams } from './f1api.js';
import { buildComparison } from './qualifying.js';
import { formatLapTime } from './pace.js';
import { teamColorById, onColor } from './teams.js';

const SEASONS = [2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018];

// Единицы гэпа. permille = проценты × 10 (тысячные доли отношения): мелкие
// разрывы читаются крупнее. sec — абсолютная разница времён в секундах.
const GAP_UNITS = {
  pct: { label: 'проценты' },
  permille: { label: 'промилле' },
  sec: { label: 'секунды' },
};

const $ = (id) => document.getElementById(id);
const els = {
  season: $('q-season'),
  team: $('q-team'),
  load: $('q-load'),
  gapUnit: $('q-gap-unit'),
  status: $('q-status'),
  table: $('q-table'),
};

const state = {
  year: null, // сезон, для которого загружены квалификации
  rounds: null, // из fetchSeasonQualifying
  teams: [], // список команд сезона ({ id, name })
  team: null, // constructorId выбранной команды
  pairKey: null, // ключ активной пары-вкладки; null → пара, начинавшая сезон
  gapUnit: 'pct',
  loading: false, // идёт загрузка этапов
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

// --- форматирование гэпа ---------------------------------------------------

// Величина гэпа без знака — направление показывает подсветка лучшего времени.
function fmtGap(row) {
  if (row.gap == null) return '—';
  if (state.gapUnit === 'sec') return `${Math.abs(row.ta - row.tb).toFixed(3)}`;
  if (state.gapUnit === 'permille') return `${(Math.abs(row.gap) * 10).toFixed(2)}‰`;
  return `${Math.abs(row.gap).toFixed(3)}%`;
}

// -1 — быстрее якорь, 1 — напарник, 0 — нет данных/поровну.
const faster = (row) =>
  row.ta == null || row.tb == null || row.ta === row.tb ? 0 : row.ta < row.tb ? -1 : 1;

// Средний гэп пары для правой панели, без знака и в выбранных единицах.
function fmtPairGap(pair) {
  if (state.gapUnit === 'sec') return pair.avgSec == null ? '—' : Math.abs(pair.avgSec).toFixed(3);
  if (pair.avgPct == null) return '—';
  if (state.gapUnit === 'permille') return `${(Math.abs(pair.avgPct) * 10).toFixed(2)}‰`;
  return `${Math.abs(pair.avgPct).toFixed(3)}%`;
}

// --- отрисовка -------------------------------------------------------------

function render() {
  const team = state.teams.find((t) => t.id === state.team);
  if (!state.rounds) {
    els.table.innerHTML = state.team
      ? '<p class="empty-state">Нажми «Загрузить», чтобы построить таблицу.</p>'
      : '';
    return;
  }

  const { pairs } = buildComparison(state.rounds, state.team);
  if (!pairs.length) {
    els.table.innerHTML = state.loading
      ? '<p class="empty-state">Загружаю квалификации…</p>'
      : `<p class="empty-state">У команды «${team?.name || ''}» в этом сезоне ` +
        'некого сравнить: не набралось второго пилота с квалификацией.</p>';
    return;
  }

  // Активная пара держится по ключу: список при дозагрузке может пополниться, а
  // выбор должен оставаться на месте. По умолчанию — первая (начинавшая сезон).
  const sel = pairs.find((p) => p.key === state.pairKey) || pairs[0];
  state.pairKey = sel.key;
  const c = teamColorById(state.team);

  // Вкладки пар — только когда пар больше одной (замены, резервисты).
  const tabs = pairs.length > 1
    ? `<div class="q-tabs">${pairs
        .map((p) => {
          const on = p.key === sel.key;
          return `<button class="q-tab${on ? ' active' : ''}" data-pair="${p.key}">${p.left.code} — ${p.right.code}</button>`;
        })
        .join('')}</div>`
    : '';

  let body = '';
  for (const r of sel.rows) {
    const f = faster(r);
    const bestA = f < 0 ? ' q-best' : '';
    const bestB = f > 0 ? ' q-best' : '';
    body +=
      `<tr class="q-row${r.sprint ? ' q-sprint' : ''}" data-round="${r.round}">` +
      `<th class="q-track">${r.label}</th>` +
      `<td class="q-time${bestA}">${formatLapTime(r.ta)}</td>` +
      `<td class="q-time${bestB}">${formatLapTime(r.tb)}</td>` +
      `<td class="q-seg">${r.session || '—'}</td>` +
      `<td class="q-gap">${fmtGap(r)}</td></tr>`;
  }

  const table =
    `<table class="quali"><thead><tr>` +
    `<th class="corner">Этап</th>` +
    `<th>${sel.left.code}</th><th>${sel.right.code}</th>` +
    `<th>Сегмент</th><th>Гэп</th>` +
    `</tr></thead><tbody>${body}</tbody></table>`;

  const head =
    `<div class="quali-head">` +
    `<span class="q-team-name" style="background:${c};color:${onColor(c)}">${(team?.name || '').toUpperCase()}</span>` +
    `</div>`;

  els.table.innerHTML =
    head + tabs + renderH2H(sel) + `<div class="table-wrap">${table}</div>`;
}

// Head-to-head активной пары — над таблицей: очный счёт с полоской перевеса,
// средний гэп и число общих квалификаций.
function renderH2H(p) {
  const c = teamColorById(state.team);
  const total = p.winsLeft + p.winsRight;
  const wa = total ? Math.round((p.winsLeft / total) * 100) : 50;
  const lead = p.avgPct == null || p.avgPct === 0 ? '' : p.avgPct < 0 ? p.left.code : p.right.code;
  const aWin = p.winsLeft > p.winsRight ? ' win' : '';
  const bWin = p.winsRight > p.winsLeft ? ' win' : '';
  return (
    `<div class="q-h2h" style="--team:${c}">` +
    `<div class="q-h2h-score">` +
    `<span class="q-h2h-side${aWin}">${p.left.code}<b>${p.winsLeft}</b></span>` +
    `<span class="q-h2h-vs">очные</span>` +
    `<span class="q-h2h-side${bWin}"><b>${p.winsRight}</b>${p.right.code}</span>` +
    `</div>` +
    `<div class="q-h2h-bar"><i style="width:${wa}%"></i></div>` +
    `<div class="q-h2h-meta">ср. гэп ${fmtPairGap(p)}${lead ? ` · <span class="q-pair-lead">быстрее ${lead}</span>` : ''} · общих квалификаций: ${p.shared}</div>` +
    `</div>`
  );
}

// --- команды и загрузка ----------------------------------------------------

function fillTeamSelect() {
  els.team.innerHTML = state.teams.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  els.team.disabled = !state.teams.length;
  // Сохраняем выбор пользователя, если команда есть и в новом сезоне.
  if (!state.teams.some((t) => t.id === state.team)) state.team = state.teams[0]?.id || null;
  els.team.value = state.team || '';
}

// Команды подгружаем сразу при смене сезона — одним лёгким запросом, чтобы их
// можно было выбрать до полной загрузки квалификаций.
async function loadTeams(year) {
  state.rounds = null; // данные прошлого сезона больше не годятся
  els.table.innerHTML = '';
  els.team.disabled = true;
  try {
    setStatus('Загружаю команды сезона…');
    const teams = await fetchSeasonTeams(year, setStatus);
    state.teams = teams;
    fillTeamSelect();
    setStatus('');
    render();
  } catch (e) {
    setStatus(`${e.message}. Выбери сезон ещё раз.`, true);
  }
}

async function load() {
  if (!state.team) return;
  els.load.disabled = true;
  const year = Number(els.season.value);
  state.year = year;
  state.rounds = []; // растёт по мере прихода этапов
  state.pairKey = null; // активная пара выберется сама (начинавшая сезон)
  state.loading = true;
  try {
    setStatus('Загружаю квалификации сезона…');
    render(); // каркас с «Загружаю…», дальше наполняется ряд за рядом
    // Этапы приходят пачками, но в порядке календаря — дописываем и
    // перерисовываем; таблица и head-to-head пересчитываются на каждом.
    const onRound = (r) => {
      state.rounds.push(r);
      render();
    };
    const rounds = await fetchSeasonQualifying(year, setStatus, onRound);
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

// Команды нужны сразу, поэтому тянем их при старте (см. низ модуля). Открытие
// вкладки лишь досыпает их, если стартовый запрос не удался.
export function onReveal() {
  if (!state.teams.length) loadTeams(Number(els.season.value));
}

// --- события ---------------------------------------------------------------

els.season.innerHTML = SEASONS.map((y) => `<option>${y}</option>`).join('');
els.gapUnit.innerHTML = Object.entries(GAP_UNITS)
  .map(([k, u]) => `<option value="${k}">${u.label}</option>`)
  .join('');

els.season.addEventListener('change', () => loadTeams(Number(els.season.value)));
els.load.addEventListener('click', load);

// Смена команды не требует перезагрузки — данные всего сезона уже на руках.
els.team.addEventListener('change', () => {
  state.team = els.team.value;
  state.pairKey = null; // у новой команды свои пары
  render();
});

els.gapUnit.addEventListener('change', () => {
  state.gapUnit = els.gapUnit.value;
  render();
});

// Вкладки пар над таблицей — переключают активного напарника.
els.table.addEventListener('click', (e) => {
  const tab = e.target.closest('.q-tab');
  if (!tab) return;
  state.pairKey = tab.dataset.pair;
  render();
});

// Команды — сразу при старте, чтобы список был готов ещё до открытия вкладки.
loadTeams(Number(els.season.value));
