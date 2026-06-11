import Plot from 'react-plotly.js';
import { useMemo } from 'react';

export default function HourlyLoadChart({ tasks, selectedDate, selectedTaskTypes, colorMap }) {
  const { traces, xLabels } = useMemo(() => {
    const xLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    const dateBase = new Date(selectedDate + 'T00:00:00');

    const dayTasks = tasks.filter(
      t => t.date === selectedDate && selectedTaskTypes.includes(t.name)
    );

    const byType = {};
    for (const typeName of selectedTaskTypes) {
      byType[typeName] = Array(24).fill(0);
    }

    for (let h = 0; h < 24; h++) {
      const slotStart = new Date(dateBase.getTime() + h * 3600000);
      const slotEnd = new Date(slotStart.getTime() + 3600000);
      for (const t of dayTasks) {
        const overlap = Math.min(t.end, slotEnd) > Math.max(t.start, slotStart);
        if (overlap) byType[t.name][h]++;
      }
    }

    // Unique flights per hour
    const hourlyReq = Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      const slotStart = new Date(dateBase.getTime() + h * 3600000);
      const slotEnd = new Date(slotStart.getTime() + 3600000);
      const flights = new Set();
      for (const t of dayTasks) {
        const overlap = Math.min(t.end, slotEnd) > Math.max(t.start, slotStart);
        if (overlap) flights.add(t.flight);
      }
      hourlyReq[h] = flights.size;
    }

    const areaTraces = Object.entries(byType).map(([name, counts]) => ({
      type: 'scatter',
      mode: 'lines',
      fill: 'tozeroy',
      stackgroup: 'one',
      name,
      x: xLabels,
      y: counts,
      line: { color: colorMap[name] || '#888' },
    }));

    const reqTrace = {
      type: 'scatter',
      mode: 'lines+markers+text',
      name: 'Потребность (рейсы)',
      x: xLabels,
      y: hourlyReq,
      text: hourlyReq.map(v => (v > 0 ? String(v) : '')),
      textposition: 'top center',
      line: { color: '#1A1A1A', width: 2, dash: 'dash' },
      marker: { color: '#1A1A1A', size: 5 },
    };

    return { traces: [...areaTraces, reqTrace], xLabels };
  }, [tasks, selectedDate, selectedTaskTypes, colorMap]);

  return (
    <Plot
      data={traces}
      layout={{
        height: 500,
        hovermode: 'x unified',
        margin: { l: 50, r: 20, t: 20, b: 60 },
        xaxis: { title: 'Час', tickangle: -45 },
        yaxis: { title: 'Ресурсы / задачи в час' },
        legend: { orientation: 'h', y: -0.3 },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#F9FAFB',
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: '100%' }}
    />
  );
}
