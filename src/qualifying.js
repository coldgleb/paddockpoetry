// Чистая логика сравнения сокомандников по квалификации. Без DOM и сети —
// чтобы гонять под node и не тащить сюда рендер. Данные приходят из
// fetchSeasonQualifying (f1api.js): массив раундов с results (и sprintResults на
// спринт-уикендах), где у каждого пилота Q1/Q2/Q3 уже в секундах (или null,
// если сессию не проехал).

// circuitId → короткий код этапа, как в бумажных сводках. Ключ — трасса, а не
// страна: две гонки в одной стране (Майами/Остин, Имола/Монца) иначе слились
// бы в один код.
// Ключи — circuitId из f1api.dev; для устойчивости оставлены и прежние
// (ergast-овские) идентификаторы тех же трасс — на случай других сезонов.
const TRACK_CODE = {
  albert_park: 'AUS', shanghai: 'CHN', suzuka: 'JAP', bahrain: 'BAH',
  jeddah: 'SAU', miami: 'MIA', imola: 'EMI', monaco: 'MON',
  montmelo: 'ESP', catalunya: 'ESP',
  gilles_villeneuve: 'CAN', villeneuve: 'CAN',
  red_bull_ring: 'AUT', silverstone: 'GBR', spa: 'BEL',
  hungaroring: 'HUN', zandvoort: 'NED', monza: 'ITA', baku: 'AZE',
  marina_bay: 'SIN',
  austin: 'USA', americas: 'USA',
  hermanos_rodriguez: 'MXC', rodriguez: 'MXC',
  interlagos: 'BRA', vegas: 'LVG',
  lusail: 'QAT', losail: 'QAT', yas_marina: 'ABU',
};

export function trackCode(circuitId, country = '') {
  return TRACK_CODE[circuitId] || country.slice(0, 3).toUpperCase() || '???';
}

const SESSIONS = ['Q3', 'Q2', 'Q1']; // от поздней к ранней

// Последняя сессия, где оба поставили время. Именно её и сравниваем: гэп между
// Q3 одного и Q2 другого — это сравнение разных условий трассы и топлива, а не
// пилотов. Возвращаем 'Q3'|'Q2'|'Q1' или null, если общей сессии нет.
export function commonSession(a, b) {
  for (const s of SESSIONS) {
    if (a?.[s] != null && b?.[s] != null) return s;
  }
  return null;
}

// Гэп первого относительно второго, в процентах. Отрицательный — первый
// быстрее (его время меньше). База — время второго пилота.
export const gapPercent = (ta, tb) =>
  ta == null || tb == null || tb === 0 ? null : ((ta - tb) / tb) * 100;

// Разрыв больше этого — уже не про пилотов: трафик, ошибка, поломка, красный
// флаг в чужом круге. Такой этап сам выпадает из счёта и среднего гэпа.
// Порог настраивается на странице; здесь — значение по умолчанию.
export const AUTO_OFF_PCT = 1.5;

// Ключ строки для ручного включения/отключения: пара + этап + спринт.
export const rowKey = (pairKey, round, sprint) => `${pairKey}|${round}|${sprint ? 'S' : 'Q'}`;

// Очки за место — как в гонке и как в спринте. Обе системы неизменны на всём
// диапазоне сезонов вкладки (2018+ для гонки; спринт-квалификация появилась
// только в 2023-м, когда спринт уже платил по 8 очков за победу).
export const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

export const pointsFor = (pos, sprint) =>
  (sprint ? SPRINT_POINTS : RACE_POINTS)[pos - 1] || 0;

// Лучший круг пилота за квалификацию — минимум из непустых Q1/Q2/Q3. Нужен
// там, где напарники не сошлись в одной сессии и полноценный гэп не посчитать.
const bestLap = (res) => {
  if (!res) return null;
  const ts = [res.Q1, res.Q2, res.Q3].filter((t) => t != null);
  return ts.length ? Math.min(...ts) : null;
};

// Зачёт квалификаций сезона: место в квале оплачивается как место в гонке, а
// место в спринт-квалификации — как место в спринте. Возвращает
// { stages, drivers }: stages — колонки в порядке календаря (спринт отдельной
// колонкой перед своей квалой), drivers — строки зачёта, отсортированные по
// очкам; у каждой строки cells (ключ этапа → { pos, pts }).
//
// Ничьи разбиваем «по-чемпионатному»: выше тот, у кого больше первых мест, при
// равенстве — вторых и так далее. Так Расселл с одним поулом и Албон с двумя
// вторыми не встают в произвольном порядке.
export function buildStandings(rounds) {
  const stages = [];
  const drivers = new Map();

  const add = (results, stage) => {
    results.forEach((r, i) => {
      const pos = r.pos ?? i + 1; // старый кэш без места — берём порядок ответа
      const pts = pointsFor(pos, stage.sprint);
      const d = drivers.get(r.driverId) || {
        id: r.driverId, code: r.code, constructorId: r.constructorId, team: r.team,
        points: 0, best: [], cells: new Map(),
      };
      d.constructorId = r.constructorId; // команда — по последнему этапу пилота
      d.team = r.team;
      d.points += pts;
      d.best[pos] = (d.best[pos] || 0) + 1;
      d.cells.set(stage.key, { pos, pts });
      drivers.set(r.driverId, d);
    });
  };

  for (const r of rounds) {
    const code = trackCode(r.circuitId, r.country);
    if (r.sprint && r.sprintResults?.length) {
      const stage = { key: `${r.round}S`, code, label: `${code} SPR`, round: r.round, sprint: true };
      stages.push(stage);
      add(r.sprintResults, stage);
    }
    const stage = { key: `${r.round}Q`, code, label: code, round: r.round, sprint: false };
    stages.push(stage);
    add(r.results, stage);
  }

  // Больше первых мест — выше; дальше вторых, третьих…
  const byBest = (a, b) => {
    const n = Math.max(a.best.length, b.best.length);
    for (let p = 1; p < n; p++) if ((b.best[p] || 0) !== (a.best[p] || 0)) return (b.best[p] || 0) - (a.best[p] || 0);
    return 0;
  };
  const rows = [...drivers.values()].sort((a, b) => b.points - a.points || byBest(a, b));

  return { stages, drivers: rows };
}

// Полный состав команды за сезон: все, кто хоть раз квалифицировался за неё.
// Первым идёт штатный лидер — он становится «якорем» сравнения.
//
// Лидер определяется так: сначала штатные пилоты (проехали хотя бы половину
// сезона) идут выше разовых подмен; среди штатных вперёд тот, кто чаще выигрывал
// внутрикомандную квалификацию (то есть быстрее). Одно пропущенное им лично
// первенства уже не отбирает: у Williams-2020 лидер — Расселл (16:0 в квале),
// хотя он пропустил Сахир (замещал в Mercedes), а Латифи проехал на этап больше.
export function teamRoster(rounds, constructorId) {
  const seen = new Map(); // driverId → { driverId, code, number, count, wins }
  for (const r of rounds) {
    let bestId = null;
    let bestT = Infinity;
    for (const res of r.results) {
      if (res.constructorId !== constructorId) continue;
      const cur = seen.get(res.driverId)
        || { driverId: res.driverId, code: res.code, number: res.number, count: 0, wins: 0 };
      cur.count += 1;
      seen.set(res.driverId, cur);
      const t = bestLap(res);
      if (t != null && t < bestT) { bestT = t; bestId = res.driverId; }
    }
    if (bestId) seen.get(bestId).wins += 1; // выиграл внутрикомандную квалу этапа
  }
  const total = rounds.length;
  const regular = (d) => (d.count * 2 >= total ? 1 : 0); // проехал хотя бы полсезона
  return [...seen.values()].sort(
    (a, b) => regular(b) - regular(a) || b.wins - a.wins || b.count - a.count || a.number - b.number,
  );
}

// Сравнение всей команды за сезон вокруг «якоря» — пилота с наибольшим числом
// квалификаций (обычно штатный лидер). В каждом этапе он сравнивается с тем,
// кто в этом этапе был вторым пилотом команды, кем бы тот ни был. Это снимает
// проблему замен: у Red Bull-2025 в колонке напарника Лоусон на первых этапах и
// Цунода дальше — вместо одного фиксированного кода с прочерками там, где его
// в машине не было.
//
// Спринт-квалификации (ряды SPR) приходят из f1api.dev (sprintResults) и
// считаются наравне с обычными: попадают и в средний гэп, и в head-to-head того
// напарника, что ехал этот уикенд.
//
// Возвращает { pairs: [...] } — по одной паре сокомандников на каждую комбинацию,
// что делила хотя бы одну квалификацию. В каждой паре left — старший по roster
// (лидер команды, если он в паре), right — второй; rows — этапы этой пары
// (обычная квала и спринт), winsLeft/winsRight — очный счёт, avgPct/avgSec —
// средний гэп, shared — число зачётных сравнений. Пары идут по календарю: та,
// что начинала сезон, — первой (активная вкладка). Так, помимо основной пары,
// видны и разовые: у Williams-2020 это RUS—LAT и LAT—AIT (Айткен на Сахире
// заменял ушедшего в Mercedes Расселла).
//
// overrides — ручные решения по строкам (rowKey → true/false), сильнее
// автоматики: аномальный этап можно вернуть в счёт, обычный — выкинуть.
// cutPct — порог автоотсева в процентах.
export function buildComparison(rounds, constructorId, overrides = new Map(), cutPct = AUTO_OFF_PCT) {
  const roster = teamRoster(rounds, constructorId);
  const rank = new Map(roster.map((d, i) => [d.driverId, i])); // меньше — старше (лидер)
  const byId = new Map(roster.map((d) => [d.driverId, d]));
  const pairs = new Map(); // "leftId|rightId" → накопитель пары

  // Пара двух пилотов; left — тот, кто выше в roster (лидер команды идёт слева).
  const pairFor = (aId, bId) => {
    const [l, r] = (rank.get(aId) ?? 99) <= (rank.get(bId) ?? 99) ? [aId, bId] : [bId, aId];
    const key = `${l}|${r}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        key, left: byId.get(l), right: byId.get(r),
        rows: [], winsLeft: 0, winsRight: 0, sumPct: 0, sumSec: 0, shared: 0,
      });
    }
    return pairs.get(key);
  };

  // Сравнение left и right в наборе результатов (обычная сессия или спринт).
  // Общая сессия — честный гэп; без неё показываем лучший круг того, у кого он
  // есть, но в расчёт (гэп, счёт) такой этап не берём.
  const compare = (results, left, right) => {
    const la = results.find((x) => x.driverId === left.driverId) || null;
    const rb = results.find((x) => x.driverId === right.driverId) || null;
    const s = la && rb ? commonSession(la, rb) : null;
    if (s) return { ta: la[s], tb: rb[s], gap: gapPercent(la[s], rb[s]), session: s };
    return { ta: bestLap(la), tb: bestLap(rb), gap: null, session: null };
  };

  const addRows = (results, code, round, sprint) => {
    const mates = results.filter((x) => x.constructorId === constructorId);
    for (let i = 0; i < mates.length; i++) {
      for (let j = i + 1; j < mates.length; j++) {
        const p = pairFor(mates[i].driverId, mates[j].driverId);
        const c = compare(results, p.left, p.right);
        const key = rowKey(p.key, round, sprint);
        const cmp = c.gap != null && Number.isFinite(c.gap);
        const auto = cmp && Math.abs(c.gap) <= cutPct;
        const on = cmp && (overrides.get(key) ?? auto);
        p.rows.push({
          round, code, label: sprint ? `${code} SPR` : code, sprint, ...c, key, cmp, auto, on,
        });
        if (on) {
          p.shared += 1;
          p.sumPct += c.gap;
          p.sumSec += c.ta - c.tb;
          if (c.ta < c.tb) p.winsLeft += 1;
          else if (c.tb < c.ta) p.winsRight += 1;
        }
      }
    }
  };

  for (const r of rounds) {
    const code = trackCode(r.circuitId, r.country);
    // Спринт-квалификация идёт раньше обычной по ходу уикенда — ставим её первой.
    if (r.sprint && r.sprintResults?.length) addRows(r.sprintResults, code, r.round, true);
    addRows(r.results, code, r.round, false);
  }

  // Map хранит пары в порядке первого появления (rounds идут по календарю), так
  // что вкладки уже хронологические. Оставляем те, где было что сравнить, —
  // именно по сравнимым этапам, а не по зачётным: пара с единственным этапом,
  // выключенным авто- или вручную, иначе исчезала бы вместе со своей вкладкой.
  const list = [...pairs.values()]
    .filter((p) => p.rows.some((r) => r.cmp))
    .map((p) => ({
      key: p.key,
      left: p.left,
      right: p.right,
      rows: p.rows,
      shared: p.shared,
      winsLeft: p.winsLeft,
      winsRight: p.winsRight,
      avgPct: p.shared ? p.sumPct / p.shared : null,
      avgSec: p.shared ? p.sumSec / p.shared : null,
    }));

  return { pairs: list };
}
