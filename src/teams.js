// ЗАПАСНОЙ справочник цветов. Основной источник — официальный team_colour из
// состава OpenF1 (см. driverColor в app.js); сюда попадают только сезоны
// 2018–2022, которых у OpenF1 нет, и случай, когда он не ответил.
//
// Оттенки взяты от ливрей и прогнаны через проверку на тёмном фоне: контраст
// >= 3:1, соседние пары различимы в том числе при дальтонизме.
// ponytail: правится здесь одной строкой, других зашитых цветов нет.
const COLORS = {
  McLaren: '#FF8000',
  Ferrari: '#E8002D',
  'Red Bull Racing': '#3671C6',
  Mercedes: '#27F4D2',
  'Aston Martin': '#229971',
  Alpine: '#FF87BC',
  Williams: '#64C4FF',
  'Racing Bulls': '#8B7FE8',
  Audi: '#EB4526',
  Cadillac: '#79797C',
  'Haas F1 Team': '#E9EEF4',
  // Прежние названия тех же составов: 2023–2025.
  'Kick Sauber': '#52E252',
  'Alfa Romeo': '#D42A45',
  RB: '#8B7FE8',
  AlphaTauri: '#4C7FBF',
};

const FALLBACK = '#9AA4B8';

export const teamColor = (teamName) => COLORS[teamName] || FALLBACK;

// То же по стабильному constructorId Jolpica — им пользуется вкладка
// квалификации, где имя команды приходит из разных эндпоинтов в разной форме
// («Alpine» против «Alpine F1 Team»), а id постоянен.
const COLORS_BY_ID = {
  mclaren: '#FF8000', ferrari: '#E8002D', red_bull: '#3671C6', mercedes: '#27F4D2',
  aston_martin: '#229971', alpine: '#FF87BC', williams: '#64C4FF',
  rb: '#8B7FE8', racing_bulls: '#8B7FE8', sauber: '#52E252', kick_sauber: '#52E252',
  haas: '#E9EEF4', audi: '#EB4526', cadillac: '#79797C', alphatauri: '#4C7FBF',
  alfa: '#D42A45',
};

export const teamColorById = (id) => COLORS_BY_ID[id] || FALLBACK;

// Чёрный или белый текст поверх цвета команды — по воспринимаемой яркости.
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#10131a' : '#ffffff';
}
