import Plot from 'react-plotly.js';
import { useMemo, useState } from 'react';

function fmt(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

const SEP = '—';
const ROW_PX = 30;

// Shared x-axis config used in both the header ruler and the main chart
function xAxisConfig(dateObj, nextDay, fontColor, gridColor, showLabels, windowDays) {
  return {
    type: 'date',
    range: [dateObj.getTime(), nextDay.getTime()],
    // With more than one day on screen, break the tick label onto a second
    // line showing the date — Plotly only renders that second line where
    // the coarser unit (the day) actually changes, so it reads as a day
    // separator rather than clutter on every tick.
    tickformat: windowDays > 1 ? '%H:%M\n%d.%m' : '%H:%M',
    dtick: 3600000 * (windowDays > 1 ? 4 : 2),
    gridcolor: gridColor,
    tickfont: { color: fontColor, size: 13 },
    showticklabels: showLabels,
    showgrid: showLabels ? false : true,   // gridlines only in main chart
    zeroline: false,
    fixedrange: true,
  };
}

export default function GanttChart({ tasks, staffShifts = [], windowDays = 1, colorMap, selectedDate, filterTypes, filterFlight, isDark }) {
  const [expanded, setExpanded] = useState(() => new Set());

  const plotData = useMemo(() => {
    const filtered = tasks.filter(t =>
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

    // Row list (top-down order) + a lookup telling each task which category
    // (yVal) it belongs to: employees with a single qualification, or
    // collapsed multi-qual employees, get ONE row carrying all their tasks;
    // an employee is only split into per-qualification sub-rows once the
    // user expands them via the arrow. empRowRange tracks each employee's
    // contiguous row block (top-down indices) so the shift-shading rect can
    // span every sub-row when expanded.
    const yRowsTopDown = [];
    const empYVal = {}; // employee -> yVal to use when collapsed / single-qual
    const empRowRange = {}; // employee -> [startIdx, endIdx] (top-down, inclusive)

    for (const emp of employees) {
      const types = [...empTypesMap[emp]].sort();
      const splittable = types.length > 1;
      const isExpanded = splittable && expanded.has(emp);
      const startIdx = yRowsTopDown.length;

      if (!splittable) {
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: `${emp} (${types[0]})`, isEmployee: true, hasArrow: false, indent: 0 });
      } else if (!isExpanded) {
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: true, arrowOpen: false, emp, indent: 0 });
      } else {
        empYVal[emp] = null; // per-task, resolved via reqType below
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: true, arrowOpen: true, emp, indent: 0 });
        [...types].reverse().forEach(reqType => {
          yRowsTopDown.push({ yVal: `${emp}${SEP}${reqType}`, label: reqType, isEmployee: false, hasArrow: false, indent: 1 });
        });
      }

      empRowRange[emp] = [startIdx, yRowsTopDown.length - 1];
    }

    const taskYVal = t => {
      const y = empYVal[t.employee];
      return y !== null && y !== undefined ? y : `${t.employee}${SEP}${t.reqType}`;
    };

    const yOrder = yRowsTopDown.map(r => r.yVal);
    const yOrderBottomUp = [...yOrder].reverse();
    const rowCount = yOrder.length;

    // Convert each employee's top-down row block into the bottom-up numeric
    // y-range Plotly's category axis actually uses (category i sits at
    // numeric position i within categoryarray order).
    const empRowRangeBU = {};
    for (const [emp, [start, end]] of Object.entries(empRowRange)) {
      empRowRangeBU[emp] = [rowCount - 1 - end, rowCount - 1 - start];
    }

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
        y: taskList.map(taskYVal),
        text: taskList.map(t => {
          const mins = Math.round((t.end - t.start) / 60000);
          return mins >= 30 ? t.flight.trim() : '';
        }),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 10, color: '#fff' },
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

    const legendEntries = orderedEntries.map(([name]) => ({ name, color: colorMap[name] || '#888' }));

    // Shift-duty shading — one faint rect per shift, spanning the employee's
    // whole row block (so it still covers every sub-row once expanded).
    const shiftShapes = staffShifts
      .filter(s => empRowRangeBU[s.name])
      .map(s => {
        const [y0, y1] = empRowRangeBU[s.name];
        return {
          type: 'rect',
          xref: 'x',
          yref: 'y',
          x0: s.shiftStart.getTime(),
          x1: s.shiftEnd.getTime(),
          y0: y0 - 0.42,
          y1: y1 + 0.42,
          fillcolor: isDark ? 'rgba(90,140,255,0.10)' : 'rgba(30,80,200,0.06)',
          line: { width: 0 },
          layer: 'below',
        };
      });

    return { traces, yOrderBottomUp, rowsTopDown: yRowsTopDown, rowCount, legendEntries, shiftShapes };
  }, [tasks, staffShifts, colorMap, filterTypes, filterFlight, expanded, isDark]);

  function toggleEmployee(emp) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(emp)) next.delete(emp); else next.add(emp);
      return next;
    });
  }

  if (!plotData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 128, color: '#9ca3af', fontSize: 14 }}>
        Нет назначений — запустите оптимизатор
      </div>
    );
  }

  const { traces, yOrderBottomUp, rowsTopDown, rowCount, legendEntries, shiftShapes } = plotData;

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + windowDays * 24 * 3600000);

  // Dashed separators at each midnight boundary inside the visible window,
  // so multi-day bars are still easy to read as "day 1 / day 2 / day 3".
  const dayBoundaryShapes = Array.from({ length: windowDays - 1 }, (_, i) => ({
    type: 'line',
    xref: 'x',
    yref: 'paper',
    x0: dateObj.getTime() + (i + 1) * 24 * 3600000,
    x1: dateObj.getTime() + (i + 1) * 24 * 3600000,
    y0: 0,
    y1: 1,
    line: { color: isDark ? '#444' : '#ccc', width: 1, dash: 'dot' },
  }));

  const MARGIN_T = 4;
  const MARGIN_B = 8;
  const chartH     = Math.max(300, rowCount * ROW_PX + MARGIN_T + MARGIN_B);
  const containerH = Math.min(chartH, 560);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FAFAFA';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const labelBg   = isDark ? '#1a1a2e' : '#FAFAFA';
  const subColor  = isDark ? '#a0a0b8' : '#666';

  // Left label column width — must match the top ruler's left margin so
  // gridlines / time ticks line up with the bars rendered to its right.
  const ML = 220;

  return (
    <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden' }}>

      {/* ── Sticky time ruler ── stays visible while scrolling the bars ─────── */}
      <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
        <Plot
          data={[]}
          layout={{
            height: 52,
            margin: { l: ML, r: 16, t: 6, b: 36, autoexpand: false },
            xaxis: xAxisConfig(dateObj, nextDay, fontColor, gridColor, true, windowDays),
            yaxis: { visible: false, fixedrange: true },
            shapes: dayBoundaryShapes,
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            showlegend: false,
          }}
          config={{ responsive: true, displayModeBar: false, staticPlot: true }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </div>

      {/* ── Scrollable rows: custom label column + bars ───────────────────── */}
      <div style={{ height: containerH, overflowY: 'auto', overflowX: 'hidden', display: 'flex' }}>
        <div
          style={{
            width: ML,
            flexShrink: 0,
            background: labelBg,
            paddingTop: MARGIN_T,
            paddingBottom: MARGIN_B,
            boxSizing: 'border-box',
          }}
        >
          {rowsTopDown.map(row => (
            <div
              key={row.yVal}
              onClick={row.hasArrow ? () => toggleEmployee(row.emp) : undefined}
              title={row.isEmployee ? row.label : undefined}
              style={{
                height: ROW_PX,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 12 + row.indent * 18,
                paddingRight: 8,
                cursor: row.hasArrow ? 'pointer' : 'default',
                fontSize: row.isEmployee ? 14 : 13,
                fontWeight: row.isEmployee ? 600 : 400,
                color: row.isEmployee ? fontColor : subColor,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                userSelect: 'none',
              }}
            >
              {row.hasArrow && (
                <span style={{ display: 'inline-block', width: 14, marginRight: 4, fontSize: 11, color: subColor }}>
                  {row.arrowOpen ? '▼' : '▶'}
                </span>
              )}
              {!row.isEmployee && <span style={{ marginRight: 4, color: subColor }}>└</span>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</span>
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Plot
            data={traces}
            layout={{
              height: chartH,
              barmode: 'overlay',
              bargap: 0.15,
              showlegend: false,
              margin: { l: 0, r: 16, t: MARGIN_T, b: MARGIN_B, autoexpand: false },
              xaxis: {
                ...xAxisConfig(dateObj, nextDay, fontColor, gridColor, false, windowDays),
                showgrid: true,
                fixedrange: false,   // allow zoom/pan in main chart
              },
              yaxis: {
                categoryarray: yOrderBottomUp,
                categoryorder: 'array',
                showticklabels: false,
                automargin: false,
                gridcolor: isDark ? '#2a2a3e' : '#F3F4F6',
              },
              shapes: [...dayBoundaryShapes, ...shiftShapes],
              hovermode: 'closest',
              hoverdistance: 2,
              hoverlabel: { font: { size: 13 }, namelength: -1 },
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

      {/* ── Custom legend — rendered as plain HTML, outside Plotly's layout
             system entirely, so a long task-type list can never blow up
             Plotly's auto-margin and desync the label column from the bars
             (that's what happened when this used Plotly's built-in legend). */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 16px',
          padding: '10px 16px',
          borderTop: `1px solid ${borderClr}`,
          background: plotBg,
        }}
      >
        {legendEntries.map(({ name, color }) => (
          <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: fontColor }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
