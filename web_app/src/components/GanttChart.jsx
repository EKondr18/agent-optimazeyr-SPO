import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function GanttChart({ tasks, colorMap, selectedDate, filterTypes, filterFlight }) {
  const traces = useMemo(() => {
    const filtered = tasks.filter(t =>
      t.date === selectedDate &&
      t.employee !== 'Не назначено' &&
      filterTypes.includes(t.name) &&
      (filterFlight === '' || t.flight.toLowerCase().includes(filterFlight.toLowerCase()))
    );

    if (filtered.length === 0) return null;

    // Sort by employee, reqType, start
    const sorted = [...filtered].sort((a, b) =>
      a.employee.localeCompare(b.employee) ||
      a.reqType.localeCompare(b.reqType) ||
      a.start - b.start
    );

    // Group by task name for traces
    const byName = {};
    for (const t of sorted) {
      if (!byName[t.name]) byName[t.name] = [];
      byName[t.name].push(t);
    }

    return Object.entries(byName).map(([name, taskList]) => ({
      type: 'bar',
      orientation: 'h',
      name,
      x: taskList.map(t => t.end - t.start),
      base: taskList.map(t => t.start.getTime()),
      y: taskList.map(t => `${t.employee} (${t.reqType})`),
      text: taskList.map(t => `${t.flight} (${fmt(t.start)}–${fmt(t.end)})`),
      hovertext: taskList.map(t =>
        `${t.isLocked ? '🔒 ' : ''}[${t.flight}] ${t.name}<br>POS: ${t.pos} | ${t.reqType}`
      ),
      hoverinfo: 'text',
      marker: { color: colorMap[name] || '#888' },
      insidetextanchor: 'middle',
      textfont: { size: 10, color: 'white' },
    }));
  }, [tasks, colorMap, selectedDate, filterTypes, filterFlight]);

  if (!traces) {
    return (
      <div className="flex items-center justify-center h-40 bg-gray-50 rounded-lg text-gray-400 text-sm">
        Нет назначений — запустите оптимизатор
      </div>
    );
  }

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay = new Date(dateObj.getTime() + 24 * 3600 * 1000);

  return (
    <Plot
      data={traces}
      layout={{
        height: 460,
        barmode: 'overlay',
        showlegend: true,
        margin: { l: 180, r: 20, t: 10, b: 50 },
        xaxis: {
          type: 'date',
          range: [dateObj.getTime(), nextDay.getTime()],
          tickformat: '%H:%M',
          dtick: 3600000 * 2,
        },
        yaxis: { automargin: true },
        legend: { orientation: 'h', y: -0.15 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#F9FAFB',
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: '100%' }}
    />
  );
}
