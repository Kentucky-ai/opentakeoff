import ru from "./ru.js";

export const LANGUAGE_KEY = "opentakeoff.ui-language";
const listeners = new Set();
function readLanguage() {
  try { return localStorage.getItem(LANGUAGE_KEY) === "ru" ? "ru" : "en"; }
  catch { return "en"; }
}
let language = readLanguage();
export const getLanguage = () => language;
export function rfiStatusLabel(id, lang = language) {
  const names = lang === "ru"
    ? { open: "Открыт", answered: "Получен ответ", closed: "Закрыт", void: "Аннулирован" }
    : { open: "Open", answered: "Answered", closed: "Closed", void: "Void" };
  return names[id] || names.open;
}
export function measurementCount(count, lang = language) {
  if (lang !== "ru") return `${count} shapes`;
  const n = Math.abs(count), ten = n % 10, hundred = n % 100;
  const noun = ten === 1 && hundred !== 11 ? "измерение" : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? "измерения" : "измерений";
  return `${count} ${noun}`;
}
export const subscribeLanguage = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
export function setLanguage(next) {
  if (next !== "ru" && next !== "en") return;
  language = next;
  try { localStorage.setItem(LANGUAGE_KEY, next); } catch { /* Session-only choice when storage is unavailable. */ }
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key === LANGUAGE_KEY || event.key === null) {
    language = readLanguage();
    listeners.forEach((listener) => listener());
  }
});

// The code is the link to the drawing's finish schedule. Only its displayed
// description is localized; a user's saved tag and the PDF are never renamed.
const FINISH_NAMES = {
  CPT: "Ковровое покрытие", BRD: "Рулонное ковровое покрытие",
  LVT: "Виниловая плитка LVT", WD: "Деревянное покрытие",
  VCT: "Винил-композиционная плитка", SV: "Рулонное ПВХ-покрытие",
  CT: "Керамическая плитка", RB: "Эластичный плинтус", TR: "Переходный профиль",
};
export function finishLabel(tag, lang = language) {
  if (lang !== "ru" || typeof tag !== "string") return tag;
  const match = /^([A-Z]+)-(\d+)$/.exec(tag);
  return match && FINISH_NAMES[match[1]] ? `${FINISH_NAMES[match[1]]} ${match[2]} (${tag})` : tag;
}
export function scaleGroups(scales, lang = language) {
  const metric = scales.filter((entry) => /^1:\d+$/.test(entry.label));
  const imperial = scales.filter((entry) => !/^1:\d+$/.test(entry.label));
  return lang === "ru"
    ? [{ title: "Metric scales", scales: metric }, { title: "Imperial scales (feet and inches)", scales: imperial }]
    : [{ title: "Standard", scales }];
}
export function toolFaceLabel(id) {
  return ({ select: "Выбор", area: "Площадь", rect: "Прямоугольник", linear: "Длина",
    surface: "Площадь стен", count: "Количество", symbol: "Обозначения",
    deduct: "Вычет по контуру", "deduct-rect": "Вычет рамкой", approve: "Проверка",
    textcopy: "Копировать текст", calibrate: "Масштаб по размеру", oneclick: "Площадь щелчком" })[id] || localizeText(id);
}
export function scaleRatioLabel(label, lang = language) {
  if (lang !== "ru" || typeof label !== "string" || label.startsWith("1:")) return label;
  const match = /^([\d/.-]+)"\s*=\s*(\d+)'(?:-(\d+)")?$/.exec(label);
  if (!match) return label;
  const paper = match[1].split("-").reduce((sum, part) => {
    const [num, den] = part.split("/").map(Number);
    return sum + (den ? num / den : num);
  }, 0);
  return paper > 0 ? `1:${Number(((Number(match[2]) * 12 + Number(match[3] || 0)) / paper).toFixed(3))}` : label;
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.entries(ru).filter(([key]) => /\{\d+\}/.test(key)).map(([key, value]) => {
  const fields = [...key.matchAll(/\{(\d+)\}/g)].map((m) => m[1]);
  const parts = key.split(/\{\d+\}/g);
  return { prefix: parts[0], regex: new RegExp("^" + parts.map(escape).join("([\\s\\S]*?)") + "$"), fields, value };
}).sort((a, b) => b.prefix.length - a.prefix.length);
const cache = new Map();

// Runs at the React presentation boundary. React nodes, arrays, numbers and
// unknown project strings pass through unchanged; no DOM rewriting occurs.
export function localizeText(value, lang = language) {
  if (lang !== "ru" || typeof value !== "string" || !value) return value;
  if (cache.has(value)) return cache.get(value);
  const key = value.trim().replace(/\s+/g, " ");
  let translated = Object.hasOwn(ru, key) ? ru[key] : finishLabel(key, lang);
  if (translated === key) {
    for (const pattern of patterns) {
      if (!key.startsWith(pattern.prefix)) continue;
      const match = pattern.regex.exec(key);
      if (!match) continue;
      const args = Object.fromEntries(pattern.fields.map((field, i) => [field, match[i + 1]]));
      translated = pattern.value.replace(/\{(\d+)\}/g, (_m, field) => {
        const arg = args[field] ?? "";
        return Object.hasOwn(ru, arg) ? ru[arg] : finishLabel(arg, lang);
      });
      break;
    }
  }
  const result = translated === key ? value : value.replace(value.trim(), () => translated);
  if (cache.size >= 3000) cache.clear();
  cache.set(value, result);
  return result;
}

// Human-facing CSV exports only. JSON/API record keys remain unchanged.
export function localizeCsv(text) {
  if (language !== "ru") return text;
  const rows = [];
  let row = [], cell = "", quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\n")) {
      row.push(cell.replace(/\r$/, "")); cell = "";
      if (ch === "\n") { rows.push(row); row = []; }
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  const encode = (value) => {
    const localized = localizeText(value);
    return /[,"\r\n]/.test(localized) ? '"' + localized.replace(/"/g, '""') + '"' : localized;
  };
  return (text.startsWith("\uFEFF") ? "\uFEFF" : "") + rows.map((cells) => cells.map(encode).join(",")).join("\r\n");
}
