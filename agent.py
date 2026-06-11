#!/usr/bin/env python3
"""
agent.py — Autonomous SPO Resource Allocation Optimizer → React Web App Generator
===================================================================================
Reads the original Python/Streamlit implementation and sample CSV data,
then autonomously generates a complete, production-ready React + Vite web
application using the Anthropic Claude API.

Generated web app features (1:1 port from Python):
  • CSV upload + auto-parse of personnel task data
  • Employee shift reconstruction with SV/GH qualification inference
  • Two-pass greedy optimizer with conflict-aware task rotation
  • Interactive Gantt chart (Plotly.js timeline)
  • Unassigned task backlog with manual drag-and-drop assignment
  • Task delay simulation (shift start/end times)
  • Hourly load & headcount demand chart
  • Russian-language UI (matching original)

Usage:
    python agent.py
    python agent.py --source source/notebook.ipynb --data source/sample_data.csv
    python agent.py --output ./my_app --verbose

Environment:
    ANTHROPIC_API_KEY   — required (or place in .env file)
"""

# ─── Standard library ────────────────────────────────────────────────────────
import argparse
import csv
import json
import logging
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Optional

# ─── Third-party ─────────────────────────────────────────────────────────────
try:
    import anthropic
except ImportError:
    print("ERROR: anthropic package not found.  Run:  pip install -r requirements.txt")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv is optional; ANTHROPIC_API_KEY can be set in the environment

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

MODEL         = "claude-opus-4-5"
MAX_TOKENS    = 8192
MAX_RETRIES   = 3
RETRY_BASE_S  = 5.0    # seconds; doubles on each retry

OUTPUT_DIR    = Path("web_app")

# Candidate paths searched when --source / --data are not provided
DEFAULT_NOTEBOOK_PATHS = [
    "source/notebook.ipynb",
    "source/СПО_рабочии__python.ipynb",
    "СПО_рабочии__python.ipynb",
    "notebook.ipynb",
]
DEFAULT_CSV_PATHS = [
    "source/sample_data.csv",
    "data/sample_data.csv",
    "sample_data.csv",
]

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════

def _setup_logging(verbose: bool = False) -> logging.Logger:
    level  = logging.DEBUG if verbose else logging.INFO
    fmt    = "%(asctime)s  %(levelname)-8s  %(message)s"
    handlers: list[logging.Handler] = [
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("agent.log", mode="w", encoding="utf-8"),
    ]
    logging.basicConfig(level=level, format=fmt, datefmt="%H:%M:%S", handlers=handlers)
    return logging.getLogger("agent")


log: logging.Logger  # filled by main()

# ═══════════════════════════════════════════════════════════════════════════════
# SOURCE FILE READERS
# ═══════════════════════════════════════════════════════════════════════════════

def extract_notebook_code(path: Path) -> str:
    """Return all code cells from a Jupyter notebook concatenated as plain text."""
    with open(path, encoding="utf-8") as fh:
        nb = json.load(fh)
    cells: list[str] = []
    for cell in nb.get("cells", []):
        if cell.get("cell_type") == "code":
            src = "".join(cell.get("source", []))
            if src.strip():
                cells.append(src)
    joined = "\n\n# ── CELL ──\n\n".join(cells)
    log.debug(f"Extracted {len(cells)} code cells ({len(joined):,} chars) from {path.name}")
    return joined


def extract_csv_schema(path: Path) -> str:
    """Return column names + 2 sample rows as a human-readable string."""
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        try:
            headers = next(reader)
        except StopIteration:
            return "(empty file)"
        samples: list[list[str]] = []
        for _ in range(2):
            try:
                samples.append(next(reader))
            except StopIteration:
                break

    lines = ["COLUMNS:"]
    for h in headers:
        lines.append(f"  • {h!r}")
    lines.append("\nSAMPLE ROWS:")
    for row in samples:
        pairs = [f"{headers[i]!r}: {v!r}" for i, v in enumerate(row) if i < len(headers)]
        lines.append("  { " + ",  ".join(pairs[:10]) + (" …" if len(pairs) > 10 else "") + " }")
    return "\n".join(lines)


def find_file(candidates: list[str], hint: Optional[str]) -> Optional[Path]:
    """Return first existing path from candidates (--flag override has priority)."""
    if hint:
        p = Path(hint)
        if p.exists():
            return p
        log.warning(f"Provided path not found: {hint}")
    for c in candidates:
        p = Path(c)
        if p.exists():
            return p
    return None

# ═══════════════════════════════════════════════════════════════════════════════
# DOMAIN CONTEXT  (embedded once, referenced in every prompt)
# ═══════════════════════════════════════════════════════════════════════════════

#  Russian → English column mapping used by the data parser
CSV_COLUMN_MAP = """
COLUMN MAPPING (Russian source → English internal name):
  "Дата рейса"       → date         (DD.MM.YYYY)
  "Взлёт Посадка"    → flightTime   (DD.MM.YY HH:MM)
  "POS"              → pos          (gate/stand, e.g. "17", "26A")
  "Номер рейса"      → flightNumber (e.g. "AZV 2502")
  "Борт"             → aircraft     (tail number)
  "Фамилия"          → lastName
  "ИО"               → initials
  "Описание"         → taskDescription
  "Начало задач"     → startTime    (DD.MM.YY HH:MM)
  "Окончание задач"  → endTime      (DD.MM.YY HH:MM)
  "Примечание"       → notes
  "Тип задачи"       → taskType
  "Отдел"            → department
  "Рабочая область"  → workArea

QUALIFICATION LOGIC (from "Примечание"):
  • empty / NaN           → "GH"  (ground handling)
  • digits-only string    → "SV"  (fuel service)
  • contains "SV"         → "SV"
  • contains "GH"         → "GH"
  • contains any digit    → "SV"
  • otherwise             → "GH"
"""

#  Optimizer algorithm summary (for prompts where full Python is too long)
OPTIMIZER_SUMMARY = """
OPTIMIZER ALGORITHM (translated from Python):

DATA SETUP:
  - Each task: { id, date, name, flight, pos, zone, baseStart, baseEnd, start, end,
                 duration, color, reqType("SV"|"GH"), employee, isLocked }
  - Each staff member: { name, quals:["SV","GH"|…], zone, shiftStart, shiftEnd }
  - Staff shifts are INFERRED from task history:
      * Sort all tasks for each person by start time
      * Cluster them: tasks within 6 hours of each other = same shift
      * Shift boundaries = min(taskStarts) - 60 min  …  max(taskEnds) + 60 min
      * A person appears in staffDB[date] for every date their shift overlaps

PASS 1 — Greedy Assignment (unlocked tasks sorted by start time):
  For each unassigned task T:
    Find best employee E where ALL of:
      • E.quals includes T.reqType
      • E.shiftStart <= T.start  AND  T.end <= E.shiftEnd
      • No time overlap with E's already-assigned tasks
        (tasks on the SAME flight as T are exempt from overlap check)
    Score E by:  (1) min POS distance to last task, (2) min current load
    Assign T → E, or push to backlog if no employee found.

PASS 2 — Rotation for Backlog Tasks:
  For each backlog task T:
    For each candidate employee E (right qual + shift):
      Find all conflicting tasks CT[] (same-flight exempt, not locked)
      If ANY CT is locked → skip E entirely
      Try to relocate EACH CT to a different free employee (recursive relocation)
      If ALL conflicts resolved → execute the full migration chain and assign T → E

POS DISTANCE FUNCTION:
  posDistance(a, b):
    a == b                   → 0
    same letter prefix, diff number → |num_a - num_b|
    different prefix         → 100
    missing value            → 999
"""

# ═══════════════════════════════════════════════════════════════════════════════
# GENERATION PLAN
# Each entry: (output_path, description, list_of_context_file_keys)
# Files are generated in order; generated content is accumulated as context.
# ═══════════════════════════════════════════════════════════════════════════════

PLAN: list[tuple[str, str, list[str]]] = [

    # ── Utilities ──────────────────────────────────────────────────────────────

    (
        "src/utils/posDistance.js",
        """
Export a single named function:
  export function getPosDistance(pos1, pos2): number

Rules:
  • Either null/undefined/empty  → return 999
  • pos1 === pos2 (case-insensitive) → return 0
  • Same letter prefix, different trailing number
    e.g. "26A" vs "26C" are different prefixes (100)
    but "14" vs "17" → |14-17| = 3
    Logic: strip all non-letter chars → prefix; strip all non-digit chars → number
    If both letters match AND both have digits → |parseInt difference|
  • Otherwise (different prefix) → return 100

No external dependencies.
""",
        [],
    ),

    (
        "src/utils/dataParser.js",
        f"""
{CSV_COLUMN_MAP}

Export one function:
  export function parseCSV(csvText: string): {{ tasks: Task[], staffDB: StaffDB }}

Task object shape (TypeScript-style comment, plain JS):
{{
  id:          string,        // "T-1000", "T-1001", …
  date:        string,        // "YYYY-MM-DD"
  name:        string,        // taskDescription
  flight:      string,        // flightNumber or "Рейс не указ."
  pos:         string,        // gate/stand or "ПЕРРОН"
  zone:        "APRON"|"TERMINAL",
  baseStart:   Date,
  baseEnd:     Date,
  start:       Date,          // initially equals baseStart
  end:         Date,          // initially equals baseEnd
  duration:    number,        // minutes
  color:       string,        // from fixed palette
  reqType:     "SV"|"GH",
  employee:    string,        // "Не назначено" initially
  isLocked:    boolean,
}}

StaffDB shape:
  Record<dateString, StaffMember[]>

StaffMember shape:
{{
  name:       string,
  quals:      string[],   // ["SV"], ["GH"], or ["SV","GH"]
  zone:       "APRON",
  shiftStart: Date,
  shiftEnd:   Date,
}}

Date parsing:  "DD.MM.YY HH:MM" → JS Date  (use manual split, no external lib)
Color palette: ["#1F77B4","#9467BD","#FF9900","#E6A800","#2CA02C",
                "#D62728","#8C564B","#E377C2","#7F7F7F","#BCBD22","#17BECF"]
  Assign per unique taskDescription round-robin.

Shift inference algorithm:
  1. Group all tasks by employee (fio = lastName + " " + initials).
     Split lastName on "/" and take first part for employees like "Иванов/Петров".
  2. Sort tasks by startTime.
  3. Cluster into shifts: gap between consecutive task ends > 6 hours → new shift.
  4. For each shift:
       shiftStart = min(starts) - 60 min
       shiftEnd   = max(ends)   + 60 min
       quals      = unique set of reqTypes found in shift
  5. For each date the shift spans, add the StaffMember to staffDB[date].

Zone detection: "TERMINAL" if description (lowercased) contains any of
  ['вокзал','терминал','посадка','baggage','регистрация','terminal']

Use PapaParse (import Papa from 'papaparse') for CSV parsing.
Import getPosDistance from './posDistance' (not used inside parser itself,
but re-export it for convenience: export {{ getPosDistance }} from './posDistance').
""",
        ["src/utils/posDistance.js"],
    ),

    (
        "src/optimizer.js",
        f"""
{OPTIMIZER_SUMMARY}

Export one function:
  export function runOptimizer(tasks, staffDB, selectedDate): Task[]

Contract:
  • Receives the full tasks array (all dates) and staffDB.
  • Processes ONLY tasks where task.date === selectedDate AND !task.isLocked.
  • Resets non-locked tasks on selectedDate to employee = "Не назначено".
  • Returns the FULL updated tasks array (all dates, only selectedDate tasks changed).
  • Does NOT mutate the input array — return a new array (shallow copy + modified items).

Important details:
  • "Same flight" overlap exception: two tasks for the SAME flight number
    on the SAME employee are NOT considered conflicting.
  • POS distance scoring: prefer the employee whose last completed task
    is at the closest POS. If the employee already has a task on the same
    flight → distance = 0 (bonus for co-location).
    If no previous task → distance = 10 (neutral).
  • Tie-break by total load (fewer tasks = preferred).
  • Pass-2 rotation chain: collect (conflictingTask, newEmployee) migrations
    in a temporary list before committing, to avoid partial states.

Import getPosDistance from './utils/posDistance'.
No external dependencies.
""",
        ["src/utils/posDistance.js", "src/utils/dataParser.js"],
    ),

    # ── UI Components ──────────────────────────────────────────────────────────

    (
        "src/components/MetricsSummary.jsx",
        """
React functional component. Props: { tasks, staffList, selectedDate }

Renders a horizontal metrics bar with 4 tiles:
  • "Задач дня"       — total tasks for selectedDate
  • "Распределено"    — assigned tasks (employee !== "Не назначено")  — green value
  • "Бэклог"          — unassigned tasks                              — red value
  • "Доступно смены"  — staffList.length                              — blue value

Styling: Tailwind CSS only. Each tile is a white card with rounded-lg shadow-sm,
showing a small grey label and a large bold number. Tile row is a responsive grid.

No external library dependencies.
""",
        [],
    ),

    (
        "src/components/GanttChart.jsx",
        """
React component. Props:
  { tasks, colorMap, selectedDate, filterTypes, filterFlight }

Renders an interactive Plotly timeline (Gantt chart).

Data preparation:
  • Filter tasks: task.date === selectedDate
                  && task.employee !== "Не назначено"
                  && filterTypes.includes(task.name)
                  && (filterFlight === "" || task.flight includes filterFlight)
  • Sort by [employee, reqType, start]
  • Y-axis label: "{employee} ({reqType})"
  • Bar text:     "{flight} ({HH:MM}–{HH:MM})"
  • Hover label:  "🔒 [{flight}] {name}" for locked, "[{flight}] {name}" otherwise
  • Hover data:   pos, isLocked, reqType

Plotly layout:
  • height: 460, showlegend: false, margin: {l:10,r:10,t:10,b:30}
  • xaxis range: [selectedDate 00:00, selectedDate+1 00:00], tickformat: "%H:%M"
  • Use px.timeline equivalent: plotly type "bar" with orientation "h"
    Or use react-plotly.js with type="bar" horizontal, or Plotly scatter with shape.
    Best approach: use Plotly.js directly via window.Plotly or import Plot from 'react-plotly.js'.
    Represent each task as a trace entry in a Gantt using base + x approach.

Build data as an array of objects suitable for react-plotly.js Figure prop:
  data: [ { type:'bar', orientation:'h', ... } ] per task type
  OR use a single scatter trace with custom shapes.

Recommended approach (simplest correct Gantt in Plotly.js):
  Use multiple horizontal bar traces, one per task type, with
  x = duration in ms, base = start timestamp, y = employee label.
  Color by task name using colorMap.

Import Plot from 'react-plotly.js'.
Show "Нет назначений — запустите оптимизатор" placeholder when empty.
""",
        ["src/utils/dataParser.js"],
    ),

    (
        "src/components/HourlyLoadChart.jsx",
        """
React component. Props:
  { tasks, selectedDate, selectedTaskTypes, colorMap }

Renders a stacked area + line chart for hourly task density.

Logic:
  1. Build 24-element arrays (h=0..23) for each task type:
       count[h][typeName] = tasks where task.name === typeName
         AND task.date === selectedDate
         AND max(task.start, slotStart) < min(task.end, slotEnd)
         AND typeName ∈ selectedTaskTypes
     slotStart = selectedDate 00:00 + h hours
     slotEnd   = slotStart + 1 hour

  2. Required headcount line:
       hourlyReq[h] = count of UNIQUE flight numbers active in slot h
         (same task type filter applied)

  3. Plotly figure:
       Stacked area traces (one per task type), colored by colorMap
       + one scatter "lines+markers+text" trace for hourlyReq in black (#1A1A1A)
         with text labels (hide zeros)
       xaxis: 24 labels "00:00"…"23:00"
       yaxis: "Ресурсы / задачи в час"
       height: 500, hovermode: "x unified"
       Legend: horizontal, bottom

Import Plot from 'react-plotly.js'.
""",
        ["src/utils/dataParser.js"],
    ),

    (
        "src/components/BacklogPanel.jsx",
        """
React component. Props:
  { tasks, staffList, selectedDate, colorMap, onAssign }

Renders the unassigned task backlog with two sections:

SECTION A — Mini Gantt chart (Plotly horizontal bar, same approach as GanttChart)
  • Shows unassigned tasks grouped on Y-axis by flight number
  • Full 24-hour x-range for selectedDate
  • height: 300

SECTION B — Manual assignment list (scrollable, max-h: 400px overflow-y-auto)
  For each unassigned task:
    Left:   "{HH:MM}–{HH:MM}  |  {name}  |  Рейс: {flight}  |  POS: {pos}  |  {reqType}"
            (styled with a left color border matching task color)
    Center: <select> of eligible staff:
              filter: staff.quals.includes(task.reqType)
                      && staff.shiftStart <= task.start
                      && task.end <= staff.shiftEnd
              Default option: "Выбрать сотрудника…"
    Right:  Button "➡ Назначить"  →  calls onAssign(task.id, selectedEmployee, true)
            Disabled when no employee selected or select is at default.

Empty state: green success card "✅ Бэклог пуст! Все задачи распределены."

Import Plot from 'react-plotly.js'. Use Tailwind CSS.
""",
        ["src/utils/dataParser.js"],
    ),

    (
        "src/components/TaskDelayPanel.jsx",
        """
React component. Props:
  { tasks, selectedDate, onApplyDelays }

Renders an editable delay table for tasks on selectedDate.

Features:
  • Text input to filter by flight or task name (live filter, case-insensitive)
  • HTML table columns: Задача (описание) | Рейс | POS | Старт | Сдвиг (мин)
    The "Сдвиг (мин)" column is an editable <input type="number" min=0 max=300 step=5>
    All other columns are read-only.
  • Local state: Record<taskId, number>  (delay in minutes for each task)
  • "🔄 Применить задержки" button → calls onApplyDelays(delayMap)
  • "⟳ Сбросить всё" button → clears all delays back to 0

Styling: Tailwind CSS. Sticky table header. Alternating row backgrounds.
No external dependencies.
""",
        [],
    ),

    # ── Main App ───────────────────────────────────────────────────────────────

    (
        "src/App.jsx",
        """
Main React application component. No props.

STATE:
  tasksDB:       Task[]        (all tasks, all dates)
  staffDB:       StaffDB       (staffDB[date] = StaffMember[])
  selectedDate:  string        ("YYYY-MM-DD")
  taskDelays:    Record<id,number>   (delay in minutes per task id)
  activeTab:     "schedule"|"backlog"|"delays"|"load"
  optimizerRan:  boolean
  filterTypes:   string[]      (task description names to show)
  filterFlight:  string
  colorMap:      Record<name,color>
  isLoading:     boolean       (while parsing CSV)
  error:         string|null

DERIVED:
  availableDates = sorted unique task.date values
  currentTasks   = tasksDB filtered by selectedDate
  currentStaff   = staffDB[selectedDate] ?? []

LAYOUT (Tailwind CSS, responsive):
  ┌─────────────────────────────────────────────────────────────┐
  │  HEADER  🛫 Глобальный пульт КК (Внуково)                  │
  │  sub: "Оптимизация совмещения задач SV+GH с контролем нагр."│
  ├──────────┬──────────────────────────────────────────────────┤
  │ SIDEBAR  │  MAIN CONTENT AREA                               │
  │ (w-64)   │                                                  │
  │          │  [TABS: Расписание | Бэклог | Задержки | Нагрузка]│
  │ • Upload │                                                  │
  │   CSV    │  TAB CONTENT                                     │
  │ • Demo   │                                                  │
  │   button │                                                  │
  │ • Date   │                                                  │
  │   select │                                                  │
  │ • Task   │                                                  │
  │   types  │                                                  │
  │   multi- │                                                  │
  │   select │                                                  │
  └──────────┴──────────────────────────────────────────────────┘

TAB CONTENTS:

"schedule" (Расписание):
  MetricsSummary (top)
  Two action buttons: [🪄 Запустить оптимизатор]  [🧹 Сбросить в бэклог]
  Filter row: task type multiselect + flight text input (scoped to Gantt only)
  GanttChart

"backlog" (Бэклог):
  BacklogPanel

"delays" (Задержки):
  TaskDelayPanel

"load" (Нагрузка):
  HourlyLoadChart

HANDLERS:

handleFileUpload(file):
  Read file as text → parseCSV(text)
  Set tasksDB, staffDB, selectedDate (first date), colorMap, filterTypes
  Reset taskDelays, optimizerRan

handleDemoLoad():
  fetch('/sample_data.csv') → same as handleFileUpload

handleRunOptimizer():
  newTasks = runOptimizer(tasksDB, staffDB, selectedDate)
  setTasksDB(newTasks); setOptimizerRan(true)

handleResetBacklog():
  Reset employee="Не назначено" and isLocked=false for all non-locked tasks on selectedDate

handleApplyDelays(delayMap):
  setTaskDelays(delayMap)
  Update task.start = task.baseStart + delayMap[task.id] minutes
  Update task.end   = task.baseEnd   + delayMap[task.id] minutes
  If optimizerRan → re-run optimizer

handleAssign(taskId, employeeName, lock):
  Update task.employee and task.isLocked in tasksDB

Import: parseCSV from './utils/dataParser'
        runOptimizer from './optimizer'
        MetricsSummary, GanttChart, BacklogPanel, TaskDelayPanel, HourlyLoadChart
        from './components/*'
""",
        [
            "src/utils/dataParser.js",
            "src/optimizer.js",
            "src/components/MetricsSummary.jsx",
            "src/components/GanttChart.jsx",
            "src/components/BacklogPanel.jsx",
            "src/components/TaskDelayPanel.jsx",
            "src/components/HourlyLoadChart.jsx",
        ],
    ),

    (
        "src/main.jsx",
        """
React 18 entry point.
  import React from 'react'
  import ReactDOM from 'react-dom/client'
  import App from './App'
  import './index.css'
  ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)
""",
        ["src/App.jsx"],
    ),

    (
        "src/index.css",
        """
Tailwind CSS global stylesheet.
@tailwind base;
@tailwind components;
@tailwind utilities;

Add custom utility classes:
  .backlog-row — left border 4px solid var(--row-color), padding, background, rounded
  .tab-btn     — tab button base style (used in App.jsx)
  .tab-btn-active — active tab highlight (blue-600 text, border-b-2)
""",
        [],
    ),

    # ── Config files ───────────────────────────────────────────────────────────

    (
        "index.html",
        """
Vite HTML entry point.
  <!DOCTYPE html><html lang="ru"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SPO Пульт КК ВНК</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body></html>
""",
        [],
    ),

    (
        "package.json",
        """
{
  "name": "spo-optimizer",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev":     "vite",
    "build":   "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react":            "^18.3.1",
    "react-dom":        "^18.3.1",
    "react-plotly.js":  "^2.6.0",
    "plotly.js":        "^2.35.2",
    "papaparse":        "^5.4.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer":         "^10.4.20",
    "postcss":              "^8.4.49",
    "tailwindcss":          "^3.4.17",
    "vite":                 "^6.0.5"
  }
}
""",
        [],
    ),

    (
        "vite.config.js",
        """
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',           // relative paths for GitHub Pages
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          plotly: ['plotly.js'],
          react:  ['react', 'react-dom'],
        },
      },
    },
  },
})
""",
        [],
    ),

    (
        "tailwind.config.js",
        """
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
}
""",
        [],
    ),

    (
        "postcss.config.js",
        """
export default {
  plugins: {
    tailwindcss:  {},
    autoprefixer: {},
  },
}
""",
        [],
    ),
]


# ═══════════════════════════════════════════════════════════════════════════════
# AGENT CLASS
# ═══════════════════════════════════════════════════════════════════════════════

class WebAppGeneratorAgent:
    """
    Autonomous agent that converts a Streamlit/Python resource-allocation
    optimizer into a production-ready React + Vite web application.

    Workflow
    --------
    1. Read Python notebook source + CSV column schema from disk.
    2. Iterate through PLAN: for each target file, build a detailed prompt
       that includes:
         a. The domain description (algorithm, column mapping).
         b. Relevant previously-generated files (context window).
         c. File-specific requirements.
    3. Call Claude API to generate file content.
    4. Write file to output directory.
    5. Accumulate generated content as context for subsequent files.
    """

    SYSTEM_PROMPT = (
        "You are a senior full-stack engineer specialising in React 18, Vite, "
        "Plotly.js, PapaParse, and Tailwind CSS.\n"
        "You are porting a Python/Streamlit airport ground-handling resource "
        "allocation application to a standalone browser-based React web app.\n\n"
        "OUTPUT RULES (strictly enforced):\n"
        "  • Output ONLY the raw file content — no markdown fences, no preambles, "
        "no explanations.\n"
        "  • The code must be complete, correct, and immediately runnable.\n"
        "  • Keep all Russian-language labels exactly as in the original.\n"
        "  • Use Tailwind CSS utility classes for all styling.\n"
        "  • The app must work fully in the browser with no backend server."
    )

    def __init__(
        self,
        *,
        output_dir: Path,
        python_source: str,
        csv_schema: str,
        api_key: Optional[str] = None,
    ):
        key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        if not key:
            log.error(
                "ANTHROPIC_API_KEY is not set. "
                "Export it or place it in a .env file."
            )
            sys.exit(1)

        self.client      = anthropic.Anthropic(api_key=key)
        self.out         = output_dir
        self.py_src      = python_source
        self.csv_schema  = csv_schema
        self.context: dict[str, str] = {}   # path → generated content

        self._mkdir()

    # ──────────────────────────────────────────────────────────────────────────
    def _mkdir(self) -> None:
        for subdir in [
            self.out,
            self.out / "src" / "components",
            self.out / "src" / "utils",
            self.out / "public",
        ]:
            subdir.mkdir(parents=True, exist_ok=True)

    # ──────────────────────────────────────────────────────────────────────────
    def _build_user_prompt(
        self, path: str, description: str, ctx_files: list[str]
    ) -> str:
        """Assemble the user-turn message for a single file generation."""

        # Domain knowledge header (trimmed for token budget)
        py_excerpt = self.py_src[:4_500] if self.py_src else "(not available)"
        domain = (
            f"DOMAIN: Airport Ground Handling Resource Allocation Optimizer\n\n"
            f"ORIGINAL PYTHON/STREAMLIT SOURCE (excerpt):\n"
            f"```python\n{py_excerpt}\n```\n\n"
            f"CSV SCHEMA:\n{self.csv_schema}\n\n"
            f"{CSV_COLUMN_MAP}\n\n"
            f"{OPTIMIZER_SUMMARY}\n"
        )

        # Previously-generated context files (newest / most-relevant first)
        ctx_block = ""
        if ctx_files:
            ctx_block = "\nPREVIOUSLY GENERATED FILES (for reference):\n"
            for cf in ctx_files:
                code = self.context.get(cf, "")
                if not code:
                    continue
                snippet = code[:2_000] + ("\n… (truncated)" if len(code) > 2_000 else "")
                ctx_block += f"\n### {cf}\n```\n{snippet}\n```\n"

        return (
            f"Generate the complete contents of: `{path}`\n\n"
            f"REQUIREMENTS:\n{description.strip()}\n\n"
            f"{domain}"
            f"{ctx_block}"
        )

    # ──────────────────────────────────────────────────────────────────────────
    def _call_api(self, user_prompt: str) -> str:
        """Call Claude API with retries and exponential back-off."""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = self.client.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    system=self.SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": user_prompt}],
                )
                raw = response.content[0].text

                # Strip accidental markdown fences (model sometimes slips them in)
                raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw.strip())
                raw = re.sub(r"\n?```\s*$", "", raw.strip())
                return raw.strip()

            except anthropic.RateLimitError:
                wait = RETRY_BASE_S * (2 ** (attempt - 1))
                log.warning(f"Rate-limited — waiting {wait:.0f}s (attempt {attempt}/{MAX_RETRIES})")
                time.sleep(wait)

            except anthropic.APIConnectionError as exc:
                wait = RETRY_BASE_S * attempt
                log.warning(f"Connection error: {exc} — retrying in {wait:.0f}s")
                time.sleep(wait)

            except anthropic.APIStatusError as exc:
                if exc.status_code >= 500:
                    wait = RETRY_BASE_S * attempt
                    log.warning(f"Server error {exc.status_code} — retrying in {wait:.0f}s")
                    time.sleep(wait)
                else:
                    log.error(f"API error {exc.status_code}: {exc.message}")
                    raise

        raise RuntimeError(f"API call failed after {MAX_RETRIES} attempts")

    # ──────────────────────────────────────────────────────────────────────────
    def generate_file(self, path: str, description: str, ctx_files: list[str]) -> str:
        """Generate a single file and return its content."""
        log.info(f"  ⟳  Generating  {path} …")
        prompt  = self._build_user_prompt(path, description, ctx_files)
        log.debug(f"     Prompt length: {len(prompt):,} chars")
        content = self._call_api(prompt)
        if not content:
            raise RuntimeError(f"Empty content returned for {path}")
        log.debug(f"     Generated: {len(content):,} chars")
        return content

    # ──────────────────────────────────────────────────────────────────────────
    def save_file(self, path: str, content: str) -> None:
        """Write content to disk and store in context cache."""
        dest = self.out / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content, encoding="utf-8")
        self.context[path] = content
        log.info(f"  ✅  {path}  ({len(content):,} chars)")

    # ──────────────────────────────────────────────────────────────────────────
    def copy_sample_data(self, src_csv: Optional[Path]) -> None:
        dst = self.out / "public" / "sample_data.csv"
        if src_csv and src_csv.exists():
            shutil.copy2(src_csv, dst)
            log.info(f"  📄  Copied sample data → {dst.relative_to(self.out)}")
        else:
            log.warning("  ⚠   Sample CSV not found — skipping copy")

    # ──────────────────────────────────────────────────────────────────────────
    def write_readme(self) -> None:
        """Write a README for the generated web app."""
        readme = """\
# SPO Пульт КК ВНК — Resource Allocation Optimizer

> Generated by **agent.py** — autonomous Anthropic Claude-powered code generator.

## Quick start

```bash
cd web_app
npm install
npm run dev        # development server at http://localhost:5173
npm run build      # production build → dist/
npm run preview    # preview the production build
```

## Features

- 📂 **CSV upload** — load any SPO personnel task export
- 🪄 **AI Optimizer** — two-pass greedy algorithm with rotation
- 📊 **Gantt chart** — interactive Plotly.js timeline by employee
- 📦 **Backlog panel** — manual assignment for unscheduled tasks
- ⏱️ **Delay simulation** — shift every task's start/end by N minutes
- 📈 **Hourly load chart** — stacked area + headcount demand line

## Deployment (GitHub Pages)

The GitHub Actions workflow builds and deploys automatically on every push to `main`.
See `.github/workflows/generate-webapp.yml`.
"""
        (self.out / "README.md").write_text(readme, encoding="utf-8")
        log.info("  📝  README.md written")

    # ──────────────────────────────────────────────────────────────────────────
    def run(self, sample_csv: Optional[Path] = None) -> None:
        """Execute the full generation pipeline."""
        log.info("=" * 64)
        log.info("🚀  SPO Optimizer → React Web App  |  Agent starting")
        log.info(f"    Model:  {MODEL}")
        log.info(f"    Output: {self.out.absolute()}")
        log.info(f"    Files to generate: {len(PLAN)}")
        log.info("=" * 64)

        t0    = time.time()
        total = len(PLAN)

        for step, (path, description, ctx_files) in enumerate(PLAN, 1):
            log.info(f"\n[{step:02d}/{total}]  {path}")
            content = self.generate_file(path, description, ctx_files)
            self.save_file(path, content)

        self.copy_sample_data(sample_csv)
        self.write_readme()

        elapsed = time.time() - t0
        log.info("")
        log.info("=" * 64)
        log.info(f"🎉  Done!  {total} files generated in {elapsed:.1f}s")
        log.info(f"    cd {self.out}  &&  npm install  &&  npm run dev")
        log.info("=" * 64)


# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Autonomous SPO Optimizer → React Web App generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--source", metavar="PATH",
        help="Path to the Python/Jupyter notebook (.ipynb) source file",
    )
    p.add_argument(
        "--data", metavar="PATH",
        help="Path to the sample CSV data file",
    )
    p.add_argument(
        "--output", metavar="DIR", default=str(OUTPUT_DIR),
        help=f"Output directory for the generated web app (default: {OUTPUT_DIR})",
    )
    p.add_argument(
        "--api-key", metavar="KEY",
        help="Anthropic API key (overrides ANTHROPIC_API_KEY env var)",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging",
    )
    return p.parse_args()


def main() -> None:
    global log
    args = parse_args()
    log  = _setup_logging(args.verbose)

    # ── Locate source files ───────────────────────────────────────────────────
    notebook_path = find_file(DEFAULT_NOTEBOOK_PATHS, args.source)
    csv_path      = find_file(DEFAULT_CSV_PATHS,      args.data)

    if notebook_path:
        log.info(f"📓  Python source: {notebook_path}")
        py_source = extract_notebook_code(notebook_path)
    else:
        log.warning("⚠   Python notebook not found — using algorithm summary only")
        py_source = ""

    if csv_path:
        log.info(f"📊  Sample data:  {csv_path}")
        csv_schema = extract_csv_schema(csv_path)
    else:
        log.warning("⚠   Sample CSV not found — schema will be inferred from column map")
        csv_schema = ""

    # ── Run agent ─────────────────────────────────────────────────────────────
    agent = WebAppGeneratorAgent(
        output_dir   = Path(args.output),
        python_source= py_source,
        csv_schema   = csv_schema,
        api_key      = args.api_key,
    )
    agent.run(sample_csv=csv_path)


if __name__ == "__main__":
    main()
