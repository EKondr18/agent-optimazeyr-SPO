import { useState, useMemo } from 'react';
import Plot from 'react-plotly.js';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function BacklogPanel({ tasks, staffList, selectedDate, colorMap, onAssign }) {
  const [selections, setSelections] = useState({});

  const unassigned = useMemo(
    () => tasks.filter(t => t.date === selectedDate && t.employee === 'Не назначено'),
    [tasks, selectedDate]
  );

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay = new Date(dateObj.getTime() + 24 * 3600000);

  const ganttTraces = useMemo(() => {
    const byFlight = {};
    for (const t of unassigned) {
      if (!byFlight[t.flight]) byFlight[t.flight] = [];
      byFlight[t.flight].push(t);
    }
    return Object.entries(byFlight).map(([flight, list]) => ({
      type: 'bar',
      orientation: 'h',
      name: flight,
      x: list.map(t => t.end - t.start),
      base: list.map(t => t.start.getTime()),
      y: list.map(() => flight),
      text: list.map(t => `${t.name} (${fmt(t.start)}–${fmt(t.end)})`),
      hoverinfo: 'text',
      marker: { color: list.map(t => colorMap[t.name] || '#888') },
    }));
  }, [unassigned, colorMap]);

  if (unassigned.length === 0) {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center text-green-700 font-medium">
        ✅ Бэклог пуст! Все задачи распределены.
      </div>
    );
  }

  return (
    <div>
      {/* Mini Gantt */}
      <div className="mb-4">
        <Plot
          data={ganttTraces}
          layout={{
            height: 300,
            barmode: 'overlay',
            showlegend: false,
            margin: { l: 120, r: 20, t: 10, b: 40 },
            xaxis: {
              type: 'date',
              range: [dateObj.getTime(), nextDay.getTime()],
              tickformat: '%H:%M',
              dtick: 3600000 * 3,
            },
            yaxis: { automargin: true },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: '#FFF7ED',
          }}
          config={{ responsive: true, displayModeBar: false }}
          style={{ width: '100%' }}
        />
      </div>

      {/* Manual assignment */}
      <div className="max-h-96 overflow-y-auto space-y-2">
        {unassigned.map(task => {
          const eligible = staffList.filter(s =>
            s.quals.includes(task.reqType) &&
            s.shiftStart <= task.start &&
            task.end <= s.shiftEnd
          );
          const sel = selections[task.id] || '';

          return (
            <div
              key={task.id}
              className="backlog-row flex items-center gap-3 p-3 rounded-lg bg-white border border-gray-200"
              style={{ borderLeftColor: colorMap[task.name] || '#888', borderLeftWidth: 4 }}
            >
              <div className="flex-1 text-sm text-gray-700 min-w-0">
                <span className="font-medium">{fmt(task.start)}–{fmt(task.end)}</span>
                {' | '}{task.name}{' | '}
                <span className="text-gray-500">Рейс: {task.flight}</span>
                {' | POS: '}{task.pos}
                {' | '}<span className={task.reqType === 'SV' ? 'text-blue-600' : 'text-green-600'}>{task.reqType}</span>
              </div>
              <select
                value={sel}
                onChange={e => setSelections(prev => ({ ...prev, [task.id]: e.target.value }))}
                className="text-sm border border-gray-300 rounded px-2 py-1 bg-white min-w-[160px]"
              >
                <option value="">Выбрать сотрудника…</option>
                {eligible.map(s => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
              <button
                disabled={!sel}
                onClick={() => {
                  if (sel) {
                    onAssign(task.id, sel, true);
                    setSelections(prev => { const n = { ...prev }; delete n[task.id]; return n; });
                  }
                }}
                className="text-sm px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-700"
              >
                ➡ Назначить
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
