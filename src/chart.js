// График темпа по кругам. Рисуется из тех же точек, что пошли в расчёт, —
// в SVG вручную, без библиотек.
import { formatLapTime } from './pace.js';

const M = { top: 16, right: 54, bottom: 30, left: 66 };
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

  // --- линии: разрыв там, где круг выпал из расчёта ---
  let paths = '';
  const labels = [];
  for (const s of drawn) {
    let d = '';
    let prevLap = null;
    for (const [lap, v] of s.points) {
      d += `${prevLap !== null && lap === prevLap + 1 ? 'L' : 'M'}${x(lap).toFixed(1)} ${y(v).toFixed(1)}`;
      prevLap = lap;
    }
    paths += `<path class="line" d="${d}" stroke="${s.color}" />`;
    const [lLap, lVal] = s.points[s.points.length - 1];
    labels.push({ x: x(lLap) + 8, y: y(lVal), code: s.code, color: s.color });
  }

  // Подписи у концов линий: принадлежность читается и без цвета. Ближние
  // концы расталкиваем по вертикали, иначе коды наезжают друг на друга.
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) {
    labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  }
  const shift = Math.max(0, labels.at(-1).y - (M.top + ih));
  for (const l of labels) {
    paths += `<text class="lbl" x="${l.x.toFixed(1)}" y="${(l.y - shift).toFixed(1)}" fill="${l.color}">${esc(l.code)}</text>`;
  }

  host.innerHTML =
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
