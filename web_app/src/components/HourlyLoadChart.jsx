import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function HourlyLoadChart({ tasks, selectedDate, selectedTaskTypes, colorMap }) {
  const { traces } = useMemo(() => {
    const xLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    const dateBase = new Date(selectedDate + 'T00:00:00');

    const dayTasks = tasks.filter(
      t => t.date === selectedDate && selectedTaskTypes.includes(t.name)
    );

    // Count tasks per type per hour
    const byType = {};
    for (const typeName of selectedTaskTypes) {
      byType[typeName] = Array(24).fill(0);
    }
    for (let h = 0; h < 24; h++) {
      const slotStart = new Date(dateBase.getTime() + h * 3600000);
      const slotEnd = new Date(slotStart.getTime() + 3600000);
      for (const t of dayTasks) {
        if (Math.min(t.end, slotEnd) > Math.max(t.start, slotStart)) {
          byType[t.name][h]++;
        }
      }
    }

    // Unique flights per hour (required headcount)
    const hourlyReq = Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      const slotStart = new Date(dateBase.getTime() + h * 3600000);
      const slotEnd = new Date(slotStart.getTime() + 3600000);
      const flights = new Set();
      for (const t of dayTasks) {
        if (Math.min(t.end, slotEnd) > Math.max(t.start, slotStart)) {
          flights.add(t.flight);
        }
      }
      hourlyReq[h] = flights.size;
    }

    // Stacked area traces — MUST set both line.color and fillcolor explicitly
    // so each type gets its correct distinct color
    const areaTraces = selectedTaskTypes.map(typeName => {
      const color = colorMap[typeName] || '#888888';
      return {
        type: 'scatter',
        mode: 'lines',
        fill: 'tozeroy',
        stackgroup: 'one',        // Plotly accumulates values automatically
        name: typeName,           // full name shown in legend + tooltip
        x: xLabels,
        y: byType[typeName],
        line: { color, width: 1 },
        fillcolor: hexToRgba(color, 0.75),
        // Show full name in unified hover without truncation
        hovertemplate: `<b>${typeName}</b>: %{y}<extra></extra>`,
      };
    });

    // Requirement line
    const reqTrace = {
      type: 'scatter',
      mode: 'lines+markers+text',
      name: 'Потребность в персонале (чел.)',
      x: xLabels,
      y: hourlyReq,
      text: hourlyReq.map(v => (v > 0 ? String(v) : '')),
      textposition: 'top center',
      textfont: { size: 10, color: '#111' },
      line: { color: '#111111', width: 2.5, dash: 'dot' },
      marker: { color: '#111111', size: 6 },
      hovertemplate: '<b>Потребность (рейсы)</b>: %{y}<extra></extra>',
    };

    return { traces: [...areaTraces, reqTrace] };
  }, [tasks, selectedDate, selectedTaskTypes, colorMap]);

  return (
    <Plot
      data={traces}
      layout={{
        height: 420,
        hovermode: 'x unified',
        margin: { l: 55, r: 20, t: 15, b: 100 },
        xaxis: {
          title: { text: 'Время суток', standoff: 10 },
          tickangle: -45,
          tickfont: { size: 11 },
        },
        yaxis: {
          title: { text: 'Ресурсы / Задачи в часовом интервале', standoff: 5 },
          tickfont: { size: 11 },
          rangemode: 'tozero',
        },
        legend: {
          orientation: 'h',
          y: -0.35,
          yanchor: 'top',
          font: { size: 11 },
          title: { text: 'Тип задачи' },
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: '#F8FAFC',
        hoverlabel: { font: { size: 12 }, namelength: -1 },  // -1 = no truncation
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: '100%' }}
      useResizeHandler
    />
  );
}
