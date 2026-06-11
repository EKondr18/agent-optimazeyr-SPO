import Plot from 'react-plotly.js';
import { useMemo } from 'react';

function fmt(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Separator used to make SV/GH sub-row y-values unique
// (em dash + type, invisible separator in display)
const SEP = '—';

export default function GanttChart({ tasks, colorMap, selectedDate, filterTypes, filterFlight }) {
  const plotData = useMemo(() => {
    const filtered = tasks.filter(t =>
      t.date === selectedDate &&
      t.employee !== 'Не назначено' &&
      filterTypes.includes(t.name) &&
      (filterFlight === '' ||
        t.flight.toLowerCase().includes(filterFlight.toLowerCase()))
    );

    if (filtered.length === 0) return null;

    // ── Build Y-axis: one or two sub-rows per employee ──────────────────────
    // Determine which reqTypes each employee has
    const empTypesMap = {};
    for (const t of filtered) {
      if (!empTypesMap[t.employee]) empTypesMap[t.employee] = new Set();
      empTypesMap[t.employee].add(t.reqType);
    }

    const employees = Object.keys(empTypesMap).sort((a, b) => a.localeCompare(b, 'ru'));

    // yOrder: top-to-bottom order for display (Plotly renders bottom-up, we reverse later)
    const yRowsTopDown = [];   // [{yVal, label}]
    for (const emp of employees) {
      const types = [...empTypesMap[emp]].sort().reverse(); // SV before GH
      const hasBoth = types.length > 1;
      types.forEach((reqType, idx) => {
        const yVal = `${emp}${SEP}${reqType}`;
        let label;
        if (!hasBoth) {
          label = `${emp} (${reqType})`;
        } else if (idx === 0) {
          label = emp;  // show name only once
        } else {
          label = `  └ ${reqType}`;  // indent sub-row
        }
        yRowsTopDown.push({ yVal, label });
      });
    }

    // Plotly categorical axis: categoryarray must go bottom→top for correct display
    const yOrder = yRowsTopDown.map(r => r.yVal);
    const yOrderBottomUp = [...yOrder].reverse();
    const yTickVals = yRowsTopDown.map(r => r.yVal);
    const yTickText = yRowsTopDown.map(r => r.label);

    // ── Build bar traces grouped by task name (for legend/color) ────────────
    const byName = {};
    for (const t of filtered) {
      if (!byName[t.name]) byName[t.name] = [];
      byName[t.name].push(t);
    }

    const traces = Object.entries(byName).map(([name, taskList]) => {
      const color = colorMap[name] || '#888';
      return {
        type: 'bar',
        orientation: 'h',
        name,
        x: taskList.map(t => t.end - t.start),   // duration in ms
        base: taskList.map(t => t.start.getTime()),
        y: taskList.map(t => `${t.employee}${SEP}${t.reqType}`),
        // short text label inside bar
        text: taskList.map(t => {
          const mins = Math.round((t.end - t.start) / 60000);
          return mins >= 30 ? t.flight.trim() : '';
        }),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 9, color: '#fff' },
        // full tooltip with all task info
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
      <div className="flex items-center justify-center h-32 bg-gray-50 rounded-lg text-gray-400 text-sm">
        Нет назначений — запустите оптимизатор
      </div>
    );
  }

  const { traces, yOrderBottomUp, yTickVals, yTickText, rowCount } = plotData;

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + 24 * 3600000);

  // Dynamic height: ~26px per row + margins
  const ROW_PX    = 26;
  const chartH    = Math.max(300, rowCount * ROW_PX + 120);
  const containerH = Math.min(chartH, 580); // viewport window height

  return (
    <div
      style={{ height: containerH, overflowY: 'auto', overflowX: 'hidden' }}
      className="border border-gray-100 rounded-lg bg-gray-50"
    >
      <Plot
        data={traces}
        layout={{
          height: chartH,
          barmode: 'overlay',
          bargap: 0.15,
          showlegend: true,
          margin: { l: 210, r: 16, t: 8, b: 50 },
          xaxis: {
            type: 'date',
            range: [dateObj.getTime(), nextDay.getTime()],
            tickformat: '%H:%M',
            dtick: 3600000 * 2,
            gridcolor: '#E5E7EB',
            fixedrange: false,   // allow horizontal zoom/scroll
          },
          yaxis: {
            categoryarray: yOrderBottomUp,   // bottom→top so first employee appears at top
            categoryorder: 'array',
            tickvals: yTickVals,
            ticktext: yTickText,
            tickfont: { size: 11 },
            automargin: false,
            gridcolor: '#F3F4F6',
          },
          legend: {
            orientation: 'h',
            y: -0.08,
            yanchor: 'top',
            font: { size: 11 },
          },
          hoverlabel: { font: { size: 12 }, namelength: -1 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: '#FAFAFA',
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
  );
}
