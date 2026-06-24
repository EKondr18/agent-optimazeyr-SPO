import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function fmt(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

const SEP = '—';

// Shared x-axis config used in both the header ruler and the main chart
function xAxisConfig(dateObj, nextDay, fontColor, gridColor, showLabels) {
  return {
    type: 'date',
    range: [dateObj.getTime(), nextDay.getTime()],
    tickformat: '%H:%M',
    dtick: 3600000 * 2,
    gridcolor: gridColor,
    tickfont: { color: fontColor, size: 11 },
    showticklabels: showLabels,
    showgrid: showLabels ? false : true,   // gridlines only in main chart
    zeroline: false,
    fixedrange: true,
  };
}

export default function GanttChart({ tasks, colorMap, selectedDate, filterTypes, filterFlight, isDark }) {
  const plotData = useMemo(() => {
    const filtered = tasks.filter(t =>
      t.date === selectedDate &&
      t.employee !== 'Не назначено' &&
      filterTypes.includes(t.name) &&
      (filterFlight === '' ||
        t.flight.toLowerCase().includes(filterFlight.toLowerCase()))
    );

    if (filtered.length === 0) return null;

    const empTypesMap = {};
    for (const t of filtered) {
      if (!empTypesMap[t.employee]) empTypesMap[t.employee] = new Set();
      empTypesMap[t.employee].add(t.reqType);
    }

    const employees = Object.keys(empTypesMap).sort((a, b) => a.localeCompare(b, 'ru'));

    const yRowsTopDown = [];
    for (const emp of employees) {
      const types = [...empTypesMap[emp]].sort().reverse();
      const hasBoth = types.length > 1;
      types.forEach((reqType, idx) => {
        const yVal = `${emp}${SEP}${reqType}`;
        let label;
        if (!hasBoth) {
          label = `${emp} (${reqType})`;
        } else if (idx === 0) {
          label = emp;
        } else {
          label = `  └ ${reqType}`;
        }
        yRowsTopDown.push({ yVal, label });
      });
    }

    const yOrder = yRowsTopDown.map(r => r.yVal);
    const yOrderBottomUp = [...yOrder].reverse();
    const yTickVals = yRowsTopDown.map(r => r.yVal);
    const yTickText = yRowsTopDown.map(r => r.label);

    const byName = {};
    for (const t of filtered) {
      if (!byName[t.name]) byName[t.name] = [];
      byName[t.name].push(t);
    }

    // Render shorter/point-like task types last so they paint on top of wider
    // bars they overlap with — Plotly's hover tie-break favors the
    // last-rendered trace, so this keeps hover matching what's visually on top.
    const avgDuration = list => list.reduce((sum, t) => sum + (t.end - t.start), 0) / list.length;
    const orderedEntries = Object.entries(byName).sort(
      ([, a], [, b]) => avgDuration(b) - avgDuration(a)
    );

    const traces = orderedEntries.map(([name, taskList]) => {
      const color = colorMap[name] || '#888';
      return {
        type: 'bar',
        orientation: 'h',
        name,
        x: taskList.map(t => t.end - t.start),
        base: taskList.map(t => t.start.getTime()),
        y: taskList.map(t => `${t.employee}${SEP}${t.reqType}`),
        text: taskList.map(t => {
          const mins = Math.round((t.end - t.start) / 60000);
          return mins >= 30 ? t.flight.trim() : '';
        }),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 9, color: '#fff' },
        customdata: taskList.map(t => ({
          desc:   t.name,
          flight: t.flight,
          pos:    t.pos,
          qual:   t.reqType,
          start:  fmt(t.start),
          end:    fmt(t.end),
          dur:    `${Math.round((t.end - t.start) / 60000)} мин`,
          emp:    t.employee,
          lock:   t.isLocked ? '🔒 Закреплено' : 'Свободно',
        })),
        hovertemplate:
          '<b>%{customdata.desc}</b><br>' +
          'Рейс: <b>%{customdata.flight}</b>  |  POS: %{customdata.pos}<br>' +
          'Время: %{customdata.start} – %{customdata.end}  (%{customdata.dur})<br>' +
          'Квалификация: %{customdata.qual}  |  %{customdata.lock}<br>' +
          '<extra>%{customdata.emp}</extra>',
        marker: { color, opacity: 0.9 },
      };
    });

    return { traces, yOrderBottomUp, yTickVals, yTickText, rowCount: yOrder.length };
  }, [tasks, colorMap, selectedDate, filterTypes, filterFlight]);

  if (!plotData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 128, color: '#9ca3af', fontSize: 14 }}>
        Нет назначений — запустите оптимизатор
      </div>
    );
  }

  const { traces, yOrderBottomUp, yTickVals, yTickText, rowCount } = plotData;

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + 24 * 3600000);

  const ROW_PX     = 26;
  const chartH     = Math.max(300, rowCount * ROW_PX + 120);
  const containerH = Math.min(chartH, 560);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FAFAFA';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';

  // Left margin must match in BOTH charts so gridlines align with the time ruler
  const ML = 210;

  return (
    <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden' }}>

      {/* ── Sticky time ruler ── stays visible while scrolling the bars ─────── */}
      <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
        <Plot
          data={[]}
          layout={{
            height: 44,
            margin: { l: ML, r: 16, t: 6, b: 28 },
            xaxis: xAxisConfig(dateObj, nextDay, fontColor, gridColor, true),
            yaxis: { visible: false, fixedrange: true },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            showlegend: false,
          }}
          config={{ responsive: true, displayModeBar: false, staticPlot: true }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </div>

      {/* ── Scrollable bars ─────────────────────────────────────────────────── */}
      <div style={{ height: containerH, overflowY: 'auto', overflowX: 'hidden' }}>
        <Plot
          data={traces}
          layout={{
            height: chartH,
            barmode: 'overlay',
            bargap: 0.15,
            showlegend: true,
            margin: { l: ML, r: 16, t: 4, b: 54 },
            xaxis: {
              ...xAxisConfig(dateObj, nextDay, fontColor, gridColor, false),
              showgrid: true,
              fixedrange: false,   // allow zoom/pan in main chart
            },
            yaxis: {
              categoryarray: yOrderBottomUp,
              categoryorder: 'array',
              tickvals: yTickVals,
              ticktext: yTickText,
              tickfont: { size: 11, color: fontColor },
              automargin: false,
              gridcolor: isDark ? '#2a2a3e' : '#F3F4F6',
            },
            legend: {
              orientation: 'h',
              y: -0.06,
              yanchor: 'top',
              font: { size: 11, color: fontColor },
            },
            hovermode: 'closest',
            hoverdistance: 2,
            hoverlabel: { font: { size: 12 }, namelength: -1 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: plotBg,
            font: { color: fontColor },
          }}
          config={{
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['select2d','lasso2d','autoScale2d'],
            scrollZoom: false,
            toImageButtonOptions: { format: 'png', scale: 2 },
          }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </div>
    </div>
  );
}
