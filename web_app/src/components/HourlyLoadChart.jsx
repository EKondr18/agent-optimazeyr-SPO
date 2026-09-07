import Plot from 'react-plotly.js';
import { useMemo, useState, useEffect, useRef } from 'react';
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

  const { traces, bucketCount } = useMemo(() => {
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

    return { traces: [...areaTraces, reqTrace], bucketCount: buckets.length };
  }, [tasks, selectedDate, selectedTaskTypes, isDark, roster, granularity]);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#e5e7eb';
  const plotBg = isDark ? '#1a1a2e' : '#F8FAFC';

  // Fine granularities (5/15 min) produce far more points than a fixed-width
  // chart can space out without them running together, so the plot needs
  // real width per point and a horizontally-scrolling wrapper. We size the
  // plot ourselves with an explicit pixel width/height (via ResizeObserver
  // on a sibling that never itself changes size) instead of leaning on
  // Plotly's own `responsive` auto-resize: that path only re-measures on
  // the browser's `window` resize event, so a CSS width change on our own
  // wrapper never reaches it, and forcing a re-measure with a synthetic
  // resize event was observed to sometimes catch Plotly mid-measure and
  // lock its SVG at a transient 0 height. Explicit numbers sidestep both
  // problems entirely.
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(900);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setContainerWidth(w);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const PX_PER_BUCKET = 26;
  const plotWidth = Math.max(containerWidth, bucketCount * PX_PER_BUCKET);

  return (
    <div ref={containerRef}>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: fontColor }}>Гранулярность:</span>
        <Segmented
          size="small"
          value={granularity}
          onChange={setGranularity}
          options={GRANULARITY_OPTIONS}
        />
      </div>
      <div style={{ overflowX: 'auto' }}>
        <Plot
          data={traces}
          layout={{
            width: plotWidth,
            height: 420,
            autosize: false,
            hovermode: 'x unified',
            margin: { l: 55, r: 20, t: 15, b: 100 },
            xaxis: {
              title: { text: 'Время суток', standoff: 10, font: { color: fontColor } },
              tickangle: -45,
              tickfont: { size: 11, color: fontColor },
              gridcolor: gridColor,
              nticks: Math.min(bucketCount, 96),
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
          config={{ responsive: false, displayModeBar: false }}
        />
      </div>
    </div>
  );
}
