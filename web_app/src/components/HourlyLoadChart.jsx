import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Categorical palette for qualification codes — independent of colorMap
// (which is keyed by task name), since this chart groups by required
// qualification instead.
const QUAL_COLOR_PALETTE = [
  '#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD',
  '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
  '#AEC7E8', '#FFBB78', '#98DF8A', '#FF9896', '#C5B0D5',
];
function qualColor(qual) {
  let hash = 0;
  for (let i = 0; i < qual.length; i++) hash = (hash * 31 + qual.charCodeAt(i)) | 0;
  return QUAL_COLOR_PALETTE[Math.abs(hash) % QUAL_COLOR_PALETTE.length];
}

export default function HourlyLoadChart({ tasks, selectedDate, selectedTaskTypes, isDark }) {
  const { traces } = useMemo(() => {
    const xLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    const dateBase = new Date(selectedDate + 'T00:00:00');

    const dayTasks = tasks.filter(
      t => t.date === selectedDate && selectedTaskTypes.includes(t.name)
    );

    // Grouped by required qualification (same convention as the rest of the
    // app — GanttChart's sub-rows, StaffingGapPanel) rather than by task
    // name: a handful of qualification codes instead of 50+ task-name
    // variants keeps the legend and hover actually readable.
    const byQual = {};
    for (let h = 0; h < 24; h++) {
      const slotStart = new Date(dateBase.getTime() + h * 3600000);
      const slotEnd = new Date(slotStart.getTime() + 3600000);
      for (const t of dayTasks) {
        if (Math.min(t.end, slotEnd) > Math.max(t.start, slotStart)) {
          const qual = t.reqType || '(без квалификации)';
          if (!byQual[qual]) byQual[qual] = Array(24).fill(0);
          byQual[qual][h]++;
        }
      }
    }

    const hourlyReq = Array(24).fill(0);
    for (const counts of Object.values(byQual)) {
      for (let h = 0; h < 24; h++) hourlyReq[h] += counts[h];
    }

    // Sort descending by total count: largest total renders first (at back/bottom of stack)
    const sortedQuals = Object.keys(byQual).sort((a, b) => {
      const sumA = byQual[a].reduce((s, v) => s + v, 0);
      const sumB = byQual[b].reduce((s, v) => s + v, 0);
      return sumB - sumA;
    });

    const fontColor = isDark ? '#d4d4d4' : '#444';

    // No stackgroup — each trace fills from zero independently.
    // Sorted largest→smallest so biggest area renders at back, smaller ones visible on top.
    const areaTraces = sortedQuals.map(qual => {
      const color = qualColor(qual);
      return {
        type: 'scatter',
        mode: 'lines',
        fill: 'tozeroy',
        name: qual,
        x: xLabels,
        // null (not 0) at zero-demand hours so hovermode:'x unified' omits
        // this trace from the tooltip there, instead of listing every
        // qualification with "0" at every hour it isn't actually needed.
        y: byQual[qual].map(v => (v === 0 ? null : v)),
        line: { color, width: 1.5 },
        fillcolor: hexToRgba(color, 0.55),
        hovertemplate: `<b>${qual}</b>: %{y}<extra></extra>`,
      };
    });

    const reqTrace = {
      type: 'scatter',
      mode: 'lines+markers+text',
      name: 'Потребность в персонале (чел.)',
      x: xLabels,
      y: hourlyReq.map(v => (v === 0 ? null : v)),
      text: hourlyReq.map(v => (v > 0 ? String(v) : '')),
      textposition: 'top center',
      textfont: { size: 10, color: fontColor },
      line: { color: isDark ? '#ffffff' : '#111111', width: 2.5, dash: 'dot' },
      marker: { color: isDark ? '#ffffff' : '#111111', size: 6 },
      hovertemplate: '<b>Потребность (чел.)</b>: %{y}<extra></extra>',
    };

    return { traces: [...areaTraces, reqTrace] };
  }, [tasks, selectedDate, selectedTaskTypes, isDark]);

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
          title: { text: 'Квалификация', font: { color: fontColor } },
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
