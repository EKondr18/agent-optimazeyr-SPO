import Plot from 'react-plotly.js';
import { useMemo, useState } from 'react';
import { Segmented } from 'antd';
import { packIntoChannels, bucketizeChannels, GRANULARITY_OPTIONS } from '../utils/staffDemand';
import { qualColor } from '../utils/qualColors';

function hexToRgba(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function HourlyLoadChart({ tasks, selectedDate, selectedTaskTypes, isDark, roster = [] }) {
  const [granularity, setGranularity] = useState(60);

  const { traces } = useMemo(() => {
    const dayTasks = tasks.filter(
      t => t.date === selectedDate && selectedTaskTypes.includes(t.name)
    );

    // Minimum number of distinct PEOPLE needed to cover dayTasks, not raw
    // task-overlap count — one person holding several relevant
    // qualifications can cover more than one task per interval as long as
    // they don't overlap in time. See utils/staffDemand.js.
    const channels = packIntoChannels(dayTasks, roster);
    const buckets = bucketizeChannels(channels, selectedDate, 1, granularity);

    const xLabels = buckets.map(b => {
      const h = String(b.start.getHours()).padStart(2, '0');
      const m = String(b.start.getMinutes()).padStart(2, '0');
      return `${h}:${m}`;
    });

    const quals = [...new Set(buckets.flatMap(b => Object.keys(b.byQual)))];
    const sortedQuals = quals.sort((a, b) => {
      const sumA = buckets.reduce((s, bk) => s + (bk.byQual[a] || 0), 0);
      const sumB = buckets.reduce((s, bk) => s + (bk.byQual[b] || 0), 0);
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
        // null (not 0) at zero-demand buckets so hovermode:'x unified' omits
        // this trace from the tooltip there, instead of listing every
        // qualification with "0" at every bucket it isn't actually needed.
        y: buckets.map(b => (b.byQual[qual] ? b.byQual[qual] : null)),
        line: { color, width: 1.5 },
        fillcolor: hexToRgba(color, 0.55),
        hovertemplate: `<b>${qual}</b>: %{y} чел.<extra></extra>`,
      };
    });

    const totalPeople = buckets.map(b => b.count);
    const reqTrace = {
      type: 'scatter',
      mode: 'lines+markers+text',
      name: 'Нужно людей одновременно',
      x: xLabels,
      y: totalPeople.map(v => (v === 0 ? null : v)),
      text: totalPeople.map(v => (v > 0 ? String(v) : '')),
      textposition: 'top center',
      textfont: { size: 10, color: fontColor },
      line: { color: isDark ? '#ffffff' : '#111111', width: 2.5, dash: 'dot' },
      marker: { color: isDark ? '#ffffff' : '#111111', size: 6 },
      hovertemplate: '<b>Нужно людей одновременно</b>: %{y}<extra></extra>',
    };

    return { traces: [...areaTraces, reqTrace] };
  }, [tasks, selectedDate, selectedTaskTypes, isDark, roster, granularity]);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#e5e7eb';
  const plotBg = isDark ? '#1a1a2e' : '#F8FAFC';

  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: fontColor }}>Гранулярность:</span>
        <Segmented
          size="small"
          value={granularity}
          onChange={setGranularity}
          options={GRANULARITY_OPTIONS}
        />
      </div>
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
            // Finer granularities produce many more category ticks than fit
            // on screen — cap how many are shown so labels stay readable
            // regardless of the chosen granularity.
            nticks: 24,
          },
          yaxis: {
            title: { text: 'Необходимо людей одновременно', standoff: 5, font: { color: fontColor } },
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
    </div>
  );
}
