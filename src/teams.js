// Цвета команд по team_name из OpenF1 (названия собраны из API за 2023–2026).
// Оттенки взяты от ливрей и прогнаны через проверку на тёмном фоне: контраст
// >= 3:1, соседние пары различимы в том числе при дальтонизме.
//   rb — фирменный #6692FF неотличим от синего Williams (ΔE 13.3), уведён
//        в индиго.
// Audi и Cadillac заданы пользователем. Cadillac #79797C — серый, то есть
// близок к цвету выключенных кругов; различает колонки код пилота и подпись
// команды, цвет тут вторичен.
// ponytail: правится здесь одной строкой, больше цвета нигде не заданы.
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

// Чёрный или белый текст поверх цвета команды — по воспринимаемой яркости.
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.36 ? '#10131a' : '#ffffff';
}
