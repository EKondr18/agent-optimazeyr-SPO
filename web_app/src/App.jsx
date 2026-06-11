import { useState, useMemo, useRef } from 'react';
import { parseCSV } from './utils/dataParser';
import { runOptimizer } from './optimizer';
import MetricsSummary from './components/MetricsSummary';
import GanttChart from './components/GanttChart';
import BacklogPanel from './components/BacklogPanel';
import TaskDelayPanel from './components/TaskDelayPanel';
import HourlyLoadChart from './components/HourlyLoadChart';

function SectionCard({ icon, title, badge, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <h2 className="text-base font-semibold text-gray-800">{title}</h2>
          {badge !== undefined && badge !== null && (
            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
              badge === 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
            }`}>
              {badge}
            </span>
          )}
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}

export default function App() {
  const [tasksDB, setTasksDB] = useState([]);
  const [staffDB, setStaffDB] = useState({});
  const [colorMap, setColorMap] = useState({});
  const [selectedDate, setSelectedDate] = useState('');
  const [optimizerRan, setOptimizerRan] = useState(false);
  const [filterTypes, setFilterTypes] = useState([]);
  const [filterFlight, setFilterFlight] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef();

  const availableDates = useMemo(
    () => [...new Set(tasksDB.map(t => t.date))].sort(),
    [tasksDB]
  );
  const currentTasks = useMemo(
    () => tasksDB.filter(t => t.date === selectedDate),
    [tasksDB, selectedDate]
  );
  const currentStaff = useMemo(
    () => staffDB[selectedDate] ?? [],
    [staffDB, selectedDate]
  );
  const allTaskTypes = useMemo(
    () => [...new Set(tasksDB.map(t => t.name))].sort(),
    [tasksDB]
  );
  const backlogCount = currentTasks.filter(t => t.employee === 'Не назначено').length;

  function loadData(text) {
    setIsLoading(true);
    setError(null);
    try {
      const { tasks, staffDB: db, colorMap: cm } = parseCSV(text);
      if (tasks.length === 0) throw new Error('CSV не содержит корректных данных');
      const dates = [...new Set(tasks.map(t => t.date))].sort();
      const types = [...new Set(tasks.map(t => t.name))];
      setTasksDB(tasks);
      setStaffDB(db);
      setColorMap(cm);
      setSelectedDate(dates[0]);
      setFilterTypes(types);
      setFilterFlight('');
      setOptimizerRan(false);
    } catch (e) {
      setError(`Ошибка загрузки: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadData(ev.target.result);
    reader.onerror = () => setError('Не удалось прочитать файл');
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  }

  function handleDemoLoad() {
    setIsLoading(true);
    fetch('./sample_data.csv')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(loadData)
      .catch(e => { setError(`Демо-данные недоступны: ${e.message}`); setIsLoading(false); });
  }

  function handleRunOptimizer() {
    const updated = runOptimizer(tasksDB, staffDB, selectedDate);
    setTasksDB(updated);
    setOptimizerRan(true);
  }

  function handleResetBacklog() {
    setTasksDB(prev =>
      prev.map(t =>
        t.date === selectedDate && !t.isLocked ? { ...t, employee: 'Не назначено' } : t
      )
    );
    setOptimizerRan(false);
  }

  function handleApplyDelays(delayMap) {
    let updated = tasksDB.map(t => {
      const minutes = delayMap[t.id] ?? 0;
      return {
        ...t,
        start: new Date(t.baseStart.getTime() + minutes * 60000),
        end: new Date(t.baseEnd.getTime() + minutes * 60000),
      };
    });
    if (optimizerRan) updated = runOptimizer(updated, staffDB, selectedDate);
    setTasksDB(updated);
  }

  function handleAssign(taskId, employeeName, lock) {
    setTasksDB(prev =>
      prev.map(t => t.id === taskId ? { ...t, employee: employeeName, isLocked: lock } : t)
    );
  }

  function toggleType(name) {
    setFilterTypes(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const hasData = tasksDB.length > 0;

  return (
    <div className="flex h-screen bg-gray-100 overflow-hidden">
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col shrink-0 overflow-y-auto">
        {/* Sidebar header */}
        <div className="px-4 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xl">🛫</span>
            <span className="font-bold text-gray-800 text-sm leading-tight">Пульт КК — Внуково</span>
          </div>
          <p className="text-xs text-gray-400 leading-tight">SPO оптимизатор SV+GH</p>
        </div>

        <div className="flex-1 flex flex-col gap-5 px-4 py-4">
          {/* Upload */}
          <div>
            <p className="sidebar-label">Данные</p>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
            <button onClick={() => fileRef.current?.click()}
              className="w-full text-sm bg-blue-600 text-white rounded-lg px-3 py-2 mb-2 hover:bg-blue-700 transition-colors font-medium">
              📂 Загрузить CSV
            </button>
            <button onClick={handleDemoLoad}
              className="w-full text-sm bg-gray-100 text-gray-700 rounded-lg px-3 py-2 hover:bg-gray-200 transition-colors">
              🎬 Демо-данные
            </button>
          </div>

          {/* Date */}
          {hasData && (
            <div>
              <p className="sidebar-label">Дата смены</p>
              <select
                value={selectedDate}
                onChange={e => { setSelectedDate(e.target.value); setOptimizerRan(false); }}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-300"
              >
                {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          )}

          {/* Optimizer actions */}
          {hasData && (
            <div>
              <p className="sidebar-label">Оптимизация</p>
              <button
                onClick={handleRunOptimizer}
                className="w-full text-sm bg-purple-600 text-white rounded-lg px-3 py-2.5 mb-2 hover:bg-purple-700 transition-colors font-semibold shadow-sm"
              >
                🪄 Запустить оптимизатор
              </button>
              <button
                onClick={handleResetBacklog}
                className="w-full text-sm bg-gray-100 text-gray-600 rounded-lg px-3 py-2 hover:bg-gray-200 transition-colors"
              >
                🧹 Сбросить в бэклог
              </button>
            </div>
          )}

          {/* Task type filter */}
          {hasData && (
            <div className="flex-1 min-h-0">
              <div className="flex justify-between items-center mb-2">
                <p className="sidebar-label mb-0">Типы задач</p>
                <button
                  onClick={() => setFilterTypes(
                    filterTypes.length === allTaskTypes.length ? [] : [...allTaskTypes]
                  )}
                  className="text-xs text-blue-600 hover:underline"
                >
                  {filterTypes.length === allTaskTypes.length ? 'Снять' : 'Все'}
                </button>
              </div>
              <div className="space-y-1.5 overflow-y-auto max-h-48">
                {allTaskTypes.map(name => (
                  <label key={name} className="flex items-center gap-2 cursor-pointer group">
                    <input type="checkbox" checked={filterTypes.includes(name)}
                      onChange={() => toggleType(name)} className="rounded shrink-0" />
                    <span className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ background: colorMap[name] || '#888' }} />
                    <span className="text-xs text-gray-700 truncate" title={name}>{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main scroll area ─────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        {/* Sticky header */}
        <header className="bg-blue-700 text-white px-6 py-3 sticky top-0 z-20 shadow-md shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="font-bold text-base leading-tight">Глобальный пульт КК — Внуково</h1>
              <p className="text-blue-200 text-xs">Оптимизация совмещения задач SV+GH с контролем нагрузки</p>
            </div>
            {hasData && selectedDate && (
              <div className="text-right">
                <p className="text-blue-100 text-xs">Операционная дата</p>
                <p className="font-semibold text-sm">{selectedDate}</p>
              </div>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-5 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
              ⚠️ {error}
            </div>
          )}

          {isLoading && (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm gap-2">
              <span className="animate-spin">⏳</span> Загрузка данных…
            </div>
          )}

          {!hasData && !isLoading && (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400 gap-3">
              <span className="text-5xl">📋</span>
              <p className="text-sm font-medium">Загрузите CSV-файл или нажмите «Демо-данные»</p>
              <p className="text-xs text-gray-300">Данные будут отображены на этой странице</p>
            </div>
          )}

          {hasData && !isLoading && (
            <>
              {/* Metrics */}
              <MetricsSummary tasks={tasksDB} staffList={currentStaff} selectedDate={selectedDate} />

              {/* Gantt chart */}
              <SectionCard icon="📊" title={`Оперативный план-график (${currentTasks.length} задач)`}>
                <div className="mb-3">
                  <input
                    type="text"
                    placeholder="Фильтр по рейсу…"
                    value={filterFlight}
                    onChange={e => setFilterFlight(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-56 focus:ring-2 focus:ring-blue-200"
                  />
                </div>
                <GanttChart
                  tasks={tasksDB}
                  colorMap={colorMap}
                  selectedDate={selectedDate}
                  filterTypes={filterTypes}
                  filterFlight={filterFlight}
                />
              </SectionCard>

              {/* Backlog */}
              <SectionCard
                icon="📋"
                title="Нераспределённые задачи"
                badge={backlogCount}
                defaultOpen={backlogCount > 0}
              >
                <BacklogPanel
                  tasks={tasksDB}
                  staffList={currentStaff}
                  selectedDate={selectedDate}
                  colorMap={colorMap}
                  onAssign={handleAssign}
                />
              </SectionCard>

              {/* Delays */}
              <SectionCard icon="⏱" title="Модуль задержки задач" defaultOpen={false}>
                <TaskDelayPanel
                  tasks={tasksDB}
                  selectedDate={selectedDate}
                  onApplyDelays={handleApplyDelays}
                />
              </SectionCard>

              {/* Load chart */}
              <SectionCard icon="📈" title="График нагрузки и потребности штата" defaultOpen={true}>
                <HourlyLoadChart
                  tasks={tasksDB}
                  selectedDate={selectedDate}
                  selectedTaskTypes={filterTypes}
                  colorMap={colorMap}
                />
              </SectionCard>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
