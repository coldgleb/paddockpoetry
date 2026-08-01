// График темпа по кругам. Рисуется из тех же точек, что пошли в расчёт, —
// в SVG вручную, без библиотек.
import { formatLapTime } from './pace.js';

const M = { top: 16, right: 18, bottom: 30, left: 66 };
const HEIGHT = 330;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

// Аккуратный шаг сетки: 1-2-5 на порядок, чтобы подписи были круглыми.
function niceStep(span, target) {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].find((m) => m * pow >= raw) * pow;
}

export function renderChart(host, series, { from, to }) {
  const width = Math.max(host.clientWidth || 900, 360);
  const drawn = series.filter((s) => s.points.length);

  if (!drawn.length) {
    host.innerHTML = '<p class="empty-state">Нет кругов в расчёте — нечего рисовать.</p>';
    return;
  }

  const values = drawn.flatMap((s) => s.points.map(([, v]) => v));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 0.4) { const c = (hi + lo) / 2; lo = c - 0.2; hi = c + 0.2; } // почти ровный темп
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const iw = width - M.left - M.right;
  const ih = HEIGHT - M.top - M.bottom;
  const spanX = Math.max(to - from, 1);
  const x = (lap) => M.left + ((lap - from) / spanX) * iw;
  // Быстрые круги выше: линия, ползущая вверх, читается как «поехал быстрее».
  const y = (v) => M.top + ((v - lo) / (hi - lo)) * ih;

  // --- сетка и оси ---
  const stepY = niceStep(hi - lo, 5);
  let grid = '';
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) {
    const py = y(v).toFixed(1);
    grid += `<line class="grid" x1="${M.left}" x2="${M.left + iw}" y1="${py}" y2="${py}" />`;
    grid += `<text class="tick ty" x="${M.left - 10}" y="${py}">${formatLapTime(v)}</text>`;
  }
  const stepX = Math.max(1, Math.round(niceStep(spanX, 8)));
  for (let lap = Math.ceil(from / stepX) * stepX; lap <= to; lap += stepX) {
    grid += `<text class="tick tx" x="${x(lap).toFixed(1)}" y="${M.top + ih + 20}">${lap}</text>`;
  }

  // --- линии ---
  // Рисуем только зачётные круги. Соседние соединяем цветом команды, а разрыв
  // на месте выброшенных — тонким серым пунктиром: видно, что там пропуск,
  // но пики пит-кругов больше не растягивают шкалу.
  let bridges = '';
  let lines = '';
  for (const s of drawn) {
    let solid = '';
    let prev = null;
    for (let i = 0; i < s.points.length; i++) {
      const [lap, v] = s.points[i];
      const px = x(lap).toFixed(1);
      const py = y(v).toFixed(1);
      if (prev) {
        const seg = `M${prev.px} ${prev.py}L${px} ${py}`;
        if (lap === prev.lap + 1) solid += seg;
        else bridges += seg;
      }
      // Круг без соседей рисуем точкой: отрезка у него нет, и без неё он
      // пропал бы с графика совсем.
      const left = i > 0 && s.points[i - 1][0] === lap - 1;
      const right = i < s.points.length - 1 && s.points[i + 1][0] === lap + 1;
      if (!left && !right) lines += `<circle class="dot" cx="${px}" cy="${py}" r="2" fill="${s.color}" />`;
      prev = { lap, px, py };
    }
    lines += `<path class="line" d="${solid}" stroke="${s.color}" />`;
  }
  // Пунктир кладём под цветные линии, чтобы он их не перечёркивал.
  const paths = `<path class="bridge" d="${bridges}" />` + lines;

  // Коды пилотов — легендой над графиком, а не подписями у концов линий:
  // в поле графика они наезжали на линии и читались как разрыв.
  const legend =
    '<div class="chart-legend">' +
    drawn
      .map((s) => `<span><i style="background:${s.color}"></i>${esc(s.code)}</span>`)
      .join('') +
    '</div>';

  host.innerHTML =
    legend +
    `<svg viewBox="0 0 ${width} ${HEIGHT}" width="${width}" height="${HEIGHT}" role="img" aria-label="Темп по кругам">` +
    `<text class="axis" x="${M.left + iw / 2}" y="${HEIGHT - 2}">круг</text>` +
    grid +
    `<line class="axis-line" x1="${M.left}" x2="${M.left + iw}" y1="${M.top + ih}" y2="${M.top + ih}" />` +
    paths +
    `<g class="cursor" hidden><line y1="${M.top}" y2="${M.top + ih}" /><g class="dots"></g></g>` +
    `<rect class="hit" x="${M.left}" y="${M.top}" width="${iw}" height="${ih}" />` +
    '</svg><div class="tip" hidden></div>';

  attachHover(host, drawn, { from, to, x, y, width, iw, ih });
}

// Наведение: вертикальная линия на ближайшем круге и подсказка со временами.
function attachHover(host, series, { from, to, x, y, width, iw, ih }) {
  const svg = host.querySelector('svg');
  const cursor = host.querySelector('.cursor');
  const line = cursor.querySelector('line');
  const dots = cursor.querySelector('.dots');
  const tip = host.querySelector('.tip');
  const byLap = series.map((s) => ({ s, at: new Map(s.points) }));

  const hide = () => { cursor.hidden = true; tip.hidden = true; };

  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    // viewBox масштабируется под ширину — переводим курсор в координаты SVG.
    const px = ((e.clientX - box.left) / box.width) * width;
    const lap = Math.round(from + ((px - M.left) / iw) * (to - from));
    if (lap < from || lap > to) return hide();

    const hits = byLap
      .filter(({ at }) => at.has(lap))
      .map(({ s, at }) => ({ s, v: at.get(lap) }))
      .sort((a, b) => a.v - b.v);
    if (!hits.length) return hide();

    const lx = x(lap).toFixed(1);
    line.setAttribute('x1', lx);
    line.setAttribute('x2', lx);
    dots.innerHTML = hits
      .map(({ s, v }) => `<circle cx="${lx}" cy="${y(v).toFixed(1)}" r="3.5" fill="${s.color}" />`)
      .join('');
    cursor.hidden = false;

    tip.innerHTML =
      `<b>Круг ${lap}</b>` +
      hits
        .map(
          ({ s, v }) =>
            `<span><i style="background:${s.color}"></i>${esc(s.code)}<em>${formatLapTime(v)}</em></span>`,
        )
        .join('');
    tip.hidden = false;
    // Держим подсказку в пределах графика.
    const right = px > M.left + iw / 2;
    tip.style.left = right ? '' : `${px + 16}px`;
    tip.style.right = right ? `${width - px + 16}px` : '';
    tip.style.top = `${M.top + 4}px`;
  });
}
