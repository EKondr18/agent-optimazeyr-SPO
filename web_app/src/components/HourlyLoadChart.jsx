import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function HourlyLoadChart({ tasks, selectedDate, selectedTaskTypes, colorMap, isDark }) {
  const { traces } = useMemo(() => {
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
        if (Math.min(t.end, slotEnd) > Math.max(t.start, slotStart)) {
          byType[t.name][h]++;
        }
      }
    }

    // Unique flights per hour based on filtered tasks only
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

    // Sort descending by total count: largest total renders first (at back/bottom of stack)
    const sortedTypes = [...selectedTaskTypes].sort((a, b) => {
      const sumA = (byType[a] || []).reduce((s, v) => s + v, 0);
      const sumB = (byType[b] || []).reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });

    const fontColor = isDark ? '#d4d4d4' : '#444';
    const gridColor = isDark ? '#2d2d2d' : '#e5e7eb';
    const plotBg = isDark ? '#1a1a2e' : '#F8FAFC';

    const areaTraces = sortedTypes.map(typeName => {
      const color = colorMap[typeName] || '#888888';
      return {
        type: 'scatter',
        mode: 'lines',
        fill: 'tozeroy',
        stackgroup: 'one',
        name: typeName,
        x: xLabels,
        y: byType[typeName],
        line: { color, width: 1 },
        fillcolor: hexToRgba(color, 0.75),
        hovertemplate: `<b>${typeName}</b>: %{y}<extra></extra>`,
      };
    });

    const reqTrace = {
      type: 'scatter',
      mode: 'lines+markers+text',
      name: 'Потребность в персонале (чел.)',
      x: xLabels,
      y: hourlyReq,
      text: hourlyReq.map(v => (v > 0 ? String(v) : '')),
      textposition: 'top center',
      textfont: { size: 10, color: fontColor },
      line: { color: isDark ? '#ffffff' : '#111111', width: 2.5, dash: 'dot' },
      marker: { color: isDark ? '#ffffff' : '#111111', size: 6 },
      hovertemplate: '<b>Потребность (рейсы)</b>: %{y}<extra></extra>',
    };

    return { traces: [...areaTraces, reqTrace], plotBg, fontColor, gridColor };
  }, [tasks, selectedDate, selectedTaskTypes, colorMap, isDark]);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#e5e7eb';
  const plotBg = isDark ? '#1a1a2e' : '#F8FAFC';

  return (
    <Plot
      data={traces}
      layout={{
        height: 420,
        hovermode: 'x unified',
        margin: { l: 55, r: 20, t: 15, b: 100 },
        xaxis: {
          title: { text: 'Время суток', standoff: 10, font: { color: fontColor } },
          tickangle: -45,
          tickfont: { size: 11, color: fontColor },
          gridcolor: gridColor,
        },
        yaxis: {
          title: { text: 'Ресурсы / Задачи в часовом интервале', standoff: 5, font: { color: fontColor } },
          tickfont: { size: 11, color: fontColor },
          rangemode: 'tozero',
          gridcolor: gridColor,
        },
        legend: {
          orientation: 'h',
          y: -0.35,
          yanchor: 'top',
          font: { size: 11, color: fontColor },
          title: { text: 'Тип задачи', font: { color: fontColor } },
        },
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: plotBg,
        hoverlabel: { font: { size: 12 }, namelength: -1 },
        font: { color: fontColor },
      }}
      config={{ responsive: true, displayModeBar: false }}
      style={{ width: '100%' }}
      useResizeHandler
    />
  );
}
