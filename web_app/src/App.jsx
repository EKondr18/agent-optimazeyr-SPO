import { useState, useMemo, useRef } from 'react';
import { parseCSV } from './utils/dataParser';
import { runOptimizer } from './optimizer';
import MetricsSummary from './components/MetricsSummary';
import GanttChart from './components/GanttChart';
import BacklogPanel from './components/BacklogPanel';
import TaskDelayPanel from './components/TaskDelayPanel';
import HourlyLoadChart from './components/HourlyLoadChart';

export default function App() {
  const [tasksDB, setTasksDB] = useState([]);
  const [staffDB, setStaffDB] = useState({});
  const [colorMap, setColorMap] = useState({});
  const [selectedDate, setSelectedDate] = useState('');
  const [activeTab, setActiveTab] = useState('schedule');
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
      setActiveTab('schedule');
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
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(loadData)
      .catch(e => {
        setError(`Демо-данные недоступны: ${e.message}`);
        setIsLoading(false);
      });
  }

  function handleRunOptimizer() {
    const updated = runOptimizer(tasksDB, staffDB, selectedDate);
    setTasksDB(updated);
    setOptimizerRan(true);
  }

  function handleResetBacklog() {
    setTasksDB(prev =>
      prev.map(t =>
        t.date === selectedDate && !t.isLocked
          ? { ...t, employee: 'Не назначено' }
          : t
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
    if (optimizerRan) {
      updated = runOptimizer(updated, staffDB, selectedDate);
    }
    setTasksDB(updated);
  }

  function handleAssign(taskId, employeeName, lock) {
    setTasksDB(prev =>
      prev.map(t =>
        t.id === taskId ? { ...t, employee: employeeName, isLocked: lock } : t
      )
    );
  }

  function toggleType(name) {
    setFilterTypes(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const tabs = [
    { id: 'schedule', label: 'Расписание' },
    { id: 'backlog', label: 'Бэклог' },
    { id: 'delays', label: 'Задержки' },
    { id: 'load', label: 'Нагрузка' },
  ];

  const hasData = tasksDB.length > 0;
  const backlogCount = currentTasks.filter(t => t.employee === 'Не назначено').length;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-blue-700 text-white px-6 py-4 shadow-md">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🛫</span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Глобальный пульт КК — Внуково</h1>
            <p className="text-blue-200 text-xs">Оптимизация совмещения задач SV+GH с контролем нагрузки</p>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col p-4 gap-4 overflow-y-auto shrink-0">
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Данные</p>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFileUpload} className="hidden" />
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full text-sm bg-blue-600 text-white rounded px-3 py-2 mb-2 hover:bg-blue-700 transition-colors"
            >
              📂 Загрузить CSV
            </button>
            <button
              onClick={handleDemoLoad}
              className="w-full text-sm bg-gray-100 text-gray-700 rounded px-3 py-2 hover:bg-gray-200 transition-colors"
            >
              🎬 Демо-данные
            </button>
          </div>

          {hasData && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Дата</p>
              <select
                value={selectedDate}
                onChange={e => { setSelectedDate(e.target.value); setOptimizerRan(false); }}
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
              >
                {availableDates.map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          )}

          {hasData && (
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase">Типы задач</p>
                <button
                  onClick={() =>
                    setFilterTypes(
                      filterTypes.length === allTaskTypes.length ? [] : [...allTaskTypes]
                    )
                  }
                  className="text-xs text-blue-600 hover:underline"
                >
                  {filterTypes.length === allTaskTypes.length ? 'Снять' : 'Все'}
                </button>
              </div>
              <div className="space-y-1.5">
                {allTaskTypes.map(name => (
                  <label key={name} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filterTypes.includes(name)}
                      onChange={() => toggleType(name)}
                      className="rounded shrink-0"
                    />
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: colorMap[name] || '#888' }}
                    />
                    <span className="text-xs text-gray-700 truncate" title={name}>{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-auto p-6">
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded px-4 py-3 text-sm">
              ⚠️ {error}
            </div>
          )}

          {isLoading && (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              ⏳ Загрузка данных…
            </div>
          )}

          {!hasData && !isLoading && (
            <div className="flex flex-col items-center justify-center h-64 text-gray-400 gap-3">
              <span className="text-4xl">📋</span>
              <p className="text-sm">Загрузите CSV-файл или нажмите «Демо-данные»</p>
            </div>
          )}

          {hasData && !isLoading && (
            <>
              {/* Tabs */}
              <div className="flex gap-0 border-b border-gray-200 mb-5">
                {tabs.map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`tab-btn px-4 py-2 text-sm font-medium rounded-t ${
                      activeTab === tab.id ? 'tab-btn-active' : ''
                    }`}
                  >
                    {tab.label}
                    {tab.id === 'backlog' && backlogCount > 0 && (
                      <span className="ml-1.5 bg-red-100 text-red-600 text-xs rounded-full px-1.5 py-0.5">
                        {backlogCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              {/* Schedule */}
              {activeTab === 'schedule' && (
                <div>
                  <MetricsSummary tasks={tasksDB} staffList={currentStaff} selectedDate={selectedDate} />
                  <div className="flex gap-2 mb-4 flex-wrap">
                    <button
                      onClick={handleRunOptimizer}
                      className="px-4 py-2 bg-purple-600 text-white rounded text-sm hover:bg-purple-700 transition-colors"
                    >
                      🪄 Запустить оптимизатор
                    </button>
                    <button
                      onClick={handleResetBacklog}
                      className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300 transition-colors"
                    >
                      🧹 Сбросить в бэклог
                    </button>
                    <input
                      type="text"
                      placeholder="Фильтр по рейсу…"
                      value={filterFlight}
                      onChange={e => setFilterFlight(e.target.value)}
                      className="border border-gray-300 rounded px-3 py-1.5 text-sm w-44"
                    />
                  </div>
                  <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4">
                    <GanttChart
                      tasks={tasksDB}
                      colorMap={colorMap}
                      selectedDate={selectedDate}
                      filterTypes={filterTypes}
                      filterFlight={filterFlight}
                    />
                  </div>
                </div>
              )}

              {/* Backlog */}
              {activeTab === 'backlog' && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4">
                  <h2 className="text-sm font-semibold text-gray-700 mb-4">
                    Нераспределённые задачи — {selectedDate}
                  </h2>
                  <BacklogPanel
                    tasks={tasksDB}
                    staffList={currentStaff}
                    selectedDate={selectedDate}
                    colorMap={colorMap}
                    onAssign={handleAssign}
                  />
                </div>
              )}

              {/* Delays */}
              {activeTab === 'delays' && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4">
                  <h2 className="text-sm font-semibold text-gray-700 mb-4">
                    Симуляция задержек — {selectedDate}
                  </h2>
                  <TaskDelayPanel
                    tasks={tasksDB}
                    selectedDate={selectedDate}
                    onApplyDelays={handleApplyDelays}
                  />
                </div>
              )}

              {/* Load chart */}
              {activeTab === 'load' && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4">
                  <h2 className="text-sm font-semibold text-gray-700 mb-4">
                    Почасовая нагрузка — {selectedDate}
                  </h2>
                  <HourlyLoadChart
                    tasks={tasksDB}
                    selectedDate={selectedDate}
                    selectedTaskTypes={filterTypes}
                    colorMap={colorMap}
                  />
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
