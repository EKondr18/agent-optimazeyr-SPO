import Papa from 'papaparse';
export { getPosDistance } from './posDistance';

const COLOR_PALETTE = [
  '#1F77B4', '#9467BD', '#FF9900', '#E6A800', '#2CA02C',
  '#D62728', '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
];

const TERMINAL_KEYWORDS = ['вокзал', 'терминал', 'посадка', 'baggage', 'регистрация', 'terminal'];

function parseDateTime(s) {
  if (!s || !s.trim()) return null;
  const str = s.trim();
  // "DD.MM.YY HH:MM" or "DD.MM.YYYY HH:MM"
  const spaceIdx = str.indexOf(' ');
  if (spaceIdx < 0) return null;
  const datePart = str.slice(0, spaceIdx);
  const timePart = str.slice(spaceIdx + 1);
  const dateSplit = datePart.split('.');
  const timeSplit = timePart.split(':');
  if (dateSplit.length < 3 || timeSplit.length < 2) return null;
  const day = parseInt(dateSplit[0], 10);
  const month = parseInt(dateSplit[1], 10) - 1;
  let year = parseInt(dateSplit[2], 10);
  if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
  const hours = parseInt(timeSplit[0], 10);
  const minutes = parseInt(timeSplit[1], 10);
  return new Date(year, month, day, hours, minutes, 0, 0);
}

function parseDateOnly(s) {
  if (!s || !s.trim()) return null;
  const str = s.trim();
  const parts = str.split('.');
  if (parts.length < 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  let year = parseInt(parts[2], 10);
  if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
  return new Date(year, month, day);
}

function toYMD(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function inferQual(notes) {
  if (!notes || !notes.trim()) return 'GH';
  const n = notes.trim();
  if (/^\d+$/.test(n)) return 'SV';
  if (n.includes('SV')) return 'SV';
  if (n.includes('GH')) return 'GH';
  if (/\d/.test(n)) return 'SV';
  return 'GH';
}

export function parseCSV(csvText) {
  const result = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    encoding: 'UTF-8',
  });

  const rows = result.data;
  const colorIndex = {};
  let colorCounter = 0;

  const tasks = [];
  let taskIdCounter = 1000;

  for (const row of rows) {
    const rawLastName = (row['Фамилия'] || '').trim();
    const initials = (row['ИО'] || '').trim();
    const lastName = rawLastName.split('/')[0].trim();
    const fio = lastName && initials ? `${lastName} ${initials}` : (lastName || initials || 'Неизвестно');

    const startRaw = row['Начало задач'] || '';
    const endRaw = row['Окончание задач'] || '';
    const start = parseDateTime(startRaw);
    const end = parseDateTime(endRaw);
    if (!start || !end) continue;

    const description = (row['Описание'] || '').trim() || (row['Тип задачи'] || '').trim();
    const notes = (row['Примечание'] || '').trim();
    const flightNumber = (row['Номер рейса'] || '').trim() || 'Рейс не указ.';
    const pos = (row['POS'] || '').trim() || 'ПЕРРОН';

    // Date from "Дата рейса" (DD.MM.YYYY) or derive from start
    const rawDate = row['Дата рейса'] || '';
    let taskDate;
    if (rawDate.trim()) {
      const d = parseDateOnly(rawDate);
      taskDate = d ? toYMD(d) : toYMD(start);
    } else {
      taskDate = toYMD(start);
    }

    // Zone
    const descLower = description.toLowerCase();
    const zone = TERMINAL_KEYWORDS.some(k => descLower.includes(k)) ? 'TERMINAL' : 'APRON';

    // reqType
    const reqType = inferQual(notes);

    // Color
    if (!(description in colorIndex)) {
      colorIndex[description] = COLOR_PALETTE[colorCounter % COLOR_PALETTE.length];
      colorCounter++;
    }
    const color = colorIndex[description];

    const duration = Math.round((end - start) / 60000);

    tasks.push({
      id: `T-${taskIdCounter++}`,
      date: taskDate,
      name: description,
      flight: flightNumber,
      pos,
      zone,
      baseStart: new Date(start),
      baseEnd: new Date(end),
      start: new Date(start),
      end: new Date(end),
      duration,
      color,
      reqType,
      employee: fio,
      isLocked: false,
    });
  }

  // Build staffDB by inferring shifts from task history
  // Group all tasks by employee name
  const byEmployee = {};
  for (const t of tasks) {
    if (!byEmployee[t.employee]) byEmployee[t.employee] = [];
    byEmployee[t.employee].push(t);
  }

  const staffDB = {};

  for (const [empName, empTasks] of Object.entries(byEmployee)) {
    // Sort by start
    const sorted = [...empTasks].sort((a, b) => a.start - b.start);

    // Cluster into shifts: gap > 6 hours → new shift
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const shifts = [];
    let currentShift = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = currentShift[currentShift.length - 1].end;
      const gap = sorted[i].start - prevEnd;
      if (gap > SIX_HOURS) {
        shifts.push(currentShift);
        currentShift = [sorted[i]];
      } else {
        currentShift.push(sorted[i]);
      }
    }
    shifts.push(currentShift);

    for (const shift of shifts) {
      const starts = shift.map(t => t.start);
      const ends = shift.map(t => t.end);
      const minStart = new Date(Math.min(...starts) - 60 * 60 * 1000);
      const maxEnd = new Date(Math.max(...ends) + 60 * 60 * 1000);
      const quals = [...new Set(shift.map(t => t.reqType))];

      const staffMember = {
        name: empName,
        quals,
        zone: 'APRON',
        shiftStart: minStart,
        shiftEnd: maxEnd,
      };

      // Add to every date the shift spans
      const cur = new Date(minStart);
      cur.setHours(0, 0, 0, 0);
      const endDay = new Date(maxEnd);
      endDay.setHours(0, 0, 0, 0);

      while (cur <= endDay) {
        const dateKey = toYMD(cur);
        if (!staffDB[dateKey]) staffDB[dateKey] = [];
        // Avoid duplicate (same name on same date from same shift window)
        const exists = staffDB[dateKey].some(s =>
          s.name === empName &&
          s.shiftStart.getTime() === minStart.getTime()
        );
        if (!exists) staffDB[dateKey].push(staffMember);
        cur.setDate(cur.getDate() + 1);
      }
    }
  }

  // Reset all task employees to "Не назначено" for optimizer
  for (const t of tasks) {
    t.employee = 'Не назначено';
    t.isLocked = false;
  }

  // Build color map
  const colorMap = {};
  for (const t of tasks) {
    colorMap[t.name] = t.color;
  }

  return { tasks, staffDB, colorMap };
}
