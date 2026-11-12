// Everything the bot does is in Indian Standard Time, whatever the server's zone.
export const IST = "Asia/Kolkata";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: IST,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

// { date: "2026-11-03", hm: "09:20", minutes: 560, weekday: "Mon", hour, minute }
export function istParts(d = new Date()) {
  const p = {};
  for (const part of fmt.formatToParts(d)) if (part.type !== "literal") p[part.type] = part.value;
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hm: `${p.hour}:${p.minute}`,
    minutes: hour * 60 + minute,
    seconds: hour * 3600 + minute * 60 + Number(p.second),
    weekday: p.weekday,
    hour,
    minute,
  };
}

export function hmToMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToHm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function isTradingDay(parts, holidays = []) {
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  return !holidays.includes(parts.date);
}

// Epoch ms for an IST date + "HH:MM" (IST is UTC+5:30 with no daylight saving).
export function istToEpoch(date, hm) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - 330 * 60 * 1000;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
