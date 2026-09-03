import Plot from 'react-plotly.js';
import { useMemo, useState } from 'react';
import { Modal, Button, Typography } from 'antd';
import { ganttXAxisConfig, GANTT_LABEL_WIDTH, parseRelayoutXRange } from '../utils/ganttAxis';
import { hasAllQuals } from '../optimizer';
import { getPosDistance } from '../utils/posDistance';

function fmt(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// Local-time <input type="datetime-local"> value <-> Date, consistent with
// how the rest of the app already reads/writes times via local getters
// (fmt() above), so this doesn't introduce a second timezone convention.
function toDatetimeLocalValue(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromDatetimeLocalValue(s) {
  const [datePart, timePart] = s.split('T');
  const [y, m, day] = datePart.split('-').map(Number);
  const [h, min] = timePart.split(':').map(Number);
  return new Date(y, m - 1, day, h, min);
}

const SEP = '—';
const TRAVEL_KEY = '__TRAVEL__';
const ROW_PX = 30;

export default function GanttChart({
  tasks, staffShifts = [], windowDays = 1, windowStart, colorMap, selectedDate,
  filterTypes, filterFlight, isDark, distanceResolver,
  draggingTask, onDropAssign, onEditTaskTime, onUnassignTask,
  visibleRange, onVisibleRangeChange,
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [editingTask, setEditingTask] = useState(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  // Which employees hold every qualification the currently-dragged backlog
  // task requires — used to highlight matching shifts and dim the rest.
  const qualifyingEmployees = useMemo(() => {
    if (!draggingTask) return null;
    const quals = {};
    for (const s of staffShifts) {
      if (!quals[s.name]) quals[s.name] = new Set();
      for (const q of s.quals || []) quals[s.name].add(q);
    }
    const set = new Set();
    for (const [name, qualSet] of Object.entries(quals)) {
      if (hasAllQuals([...qualSet], draggingTask)) set.add(name);
    }
    return set;
  }, [draggingTask, staffShifts]);

  const plotData = useMemo(() => {
    const filtered = tasks.filter(t =>
      t.employee !== 'Не назначено' &&
      filterTypes.includes(t.name) &&
      (filterFlight === '' ||
        t.flight.toLowerCase().includes(filterFlight.toLowerCase()))
    );

    const empTypesMap = {};
    for (const t of filtered) {
      if (!empTypesMap[t.employee]) empTypesMap[t.employee] = new Set();
      empTypesMap[t.employee].add(t.reqType);
    }

    // The row label/expand-arrow shows what an employee is currently doing
    // (their assigned tasks' types) when they have any — but for someone
    // with zero tasks assigned yet, that set is empty, which made their row
    // look "unqualified" even though they hold real quals. Fall back to
    // their actual held qualifications (from the shift data) in that case.
    const empRealQuals = {};
    for (const s of staffShifts) {
      if (!empRealQuals[s.name]) empRealQuals[s.name] = new Set();
      for (const q of s.quals || []) empRealQuals[s.name].add(q);
    }

    // How late an employee's day has run relative to how it was originally
    // scheduled — the biggest delay among their tasks (baseStart is the
    // original imported time; start is where it landed after a delay was
    // applied). Shown as a badge next to their name. This is a DIFFERENT
    // thing from overtime below: a task can be delayed and still finish
    // inside the shift, or never be delayed at all and still run past
    // shift end — the two badges track separate conditions on purpose.
    const empDelayMinutes = {};
    for (const t of filtered) {
      if (t.baseStart && t.start > t.baseStart) {
        const mins = Math.round((t.start - t.baseStart) / 60000);
        if (mins > 0) empDelayMinutes[t.employee] = Math.max(empDelayMinutes[t.employee] || 0, mins);
      }
    }

    // How many minutes past their shift's actual end an employee's day
    // runs — same "Задержаны после смены" condition MetricsSummary counts,
    // just surfaced per-employee here instead of only as a total count.
    const shiftByName = new Map(staffShifts.map(s => [s.name, s]));
    const empOvertimeMinutes = {};
    for (const [emp, empTaskList] of Object.entries(
      filtered.reduce((acc, t) => { (acc[t.employee] ??= []).push(t); return acc; }, {})
    )) {
      const shift = shiftByName.get(emp);
      if (!shift) continue;
      const latestEnd = new Date(Math.max(...empTaskList.map(t => t.end.getTime())));
      if (latestEnd > shift.shiftEnd) {
        empOvertimeMinutes[emp] = Math.round((latestEnd - shift.shiftEnd) / 60000);
      }
    }

    // Every employee with a shift in the window gets a row even before any
    // task is assigned to them — so the chart is ready to drag tasks onto
    // as soon as data loads, not just after the optimizer has run.
    const employees = [...new Set([
      ...Object.keys(empTypesMap),
      ...staffShifts.map(s => s.name),
    ])].sort((a, b) => a.localeCompare(b, 'ru'));

    if (employees.length === 0) return null;

    // Row list (top-down order) + a lookup telling each task which category
    // (yVal) it belongs to. An employee expands (via the arrow) into one
    // sub-row per qualification they hold — even just one — plus a
    // dedicated "Время перехода" sub-row showing the gaps between their
    // tasks as bars. Only an employee with zero known qualifications at all
    // gets no arrow, since there's nothing to expand into.
    // empRowRange tracks each employee's contiguous row block (top-down
    // indices) so the shift-shading rect can span every sub-row when expanded.
    const yRowsTopDown = [];
    const empYVal = {}; // employee -> yVal to use when collapsed / single-qual
    const empRowRange = {}; // employee -> [startIdx, endIdx] (top-down, inclusive)

    for (const emp of employees) {
      const assignedTypes = empTypesMap[emp];
      const types = assignedTypes && assignedTypes.size > 0
        ? [...assignedTypes].sort()
        : [...(empRealQuals[emp] || [])].sort();
      const hasArrow = types.length >= 1;
      const isExpanded = hasArrow && expanded.has(emp);
      const startIdx = yRowsTopDown.length;
      const delayMin = empDelayMinutes[emp];
      const overtimeMin = empOvertimeMinutes[emp];

      if (!hasArrow) {
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: false, emp, indent: 0, delayMin, overtimeMin });
      } else if (!isExpanded) {
        const label = types.length === 1 ? `${emp} (${types[0]})` : emp;
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label, isEmployee: true, hasArrow: true, arrowOpen: false, emp, indent: 0, delayMin, overtimeMin });
      } else {
        empYVal[emp] = null; // per-task, resolved via reqType below
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: true, arrowOpen: true, emp, indent: 0, delayMin, overtimeMin });
        [...types].reverse().forEach(reqType => {
          yRowsTopDown.push({ yVal: `${emp}${SEP}${reqType}`, label: reqType, isEmployee: false, hasArrow: false, emp, indent: 1 });
        });
        yRowsTopDown.push({ yVal: `${emp}${SEP}${TRAVEL_KEY}`, label: 'Время перехода', isEmployee: false, hasArrow: false, emp, indent: 1, isTravelRow: true });
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
          id:     t.id,
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
          'Клик — изменить время' +
          '<extra>%{customdata.emp}</extra>',
        marker: { color, opacity: 0.9 },
      };
    });

    // Travel-time bars: one per real gap between two consecutive tasks of
    // an expanded employee, drawn on their dedicated "Время перехода" row —
    // the same exit/entry points and required-time logic the optimizer
    // itself uses (see optimizer.js's hasInsufficientGap), just surfaced
    // visually instead of only affecting assignment decisions. Red where
    // the gap doesn't actually cover the needed travel time, muted grey
    // where it comfortably does.
    const travelX = [], travelBase = [], travelY = [], travelColor = [], travelCustom = [];
    for (const emp of employees) {
      if (!expanded.has(emp)) continue;
      const empTasksSorted = filtered.filter(t => t.employee === emp).sort((a, b) => a.start - b.start);
      for (let i = 1; i < empTasksSorted.length; i++) {
        const prev = empTasksSorted[i - 1];
        const cur = empTasksSorted[i];
        if (cur.start <= prev.end) continue; // overlapping (complementary-task exemption) — nothing to walk
        const exitPos = prev.exitPos ?? prev.pos;
        const entryPos = cur.entryPos ?? cur.pos;
        const gapMs = cur.start - prev.end;
        const neededSeconds = distanceResolver ? distanceResolver.secondsBetween(exitPos, entryPos) : null;
        const insufficient = neededSeconds != null
          ? gapMs < neededSeconds * 1000
          : (gapMs < 5 * 60000 && getPosDistance(exitPos, entryPos) >= 5);
        travelX.push(gapMs);
        travelBase.push(prev.end.getTime());
        travelY.push(`${emp}${SEP}${TRAVEL_KEY}`);
        travelColor.push(insufficient ? '#ff4d4f' : (isDark ? '#5a6b8c' : '#a8b5cc'));
        const neededMin = neededSeconds != null ? Math.round(neededSeconds / 60) : null;
        travelCustom.push({
          from: exitPos,
          to: entryPos,
          gapMin: Math.round(gapMs / 60000),
          // Pre-formatted in JS since Plotly's hovertemplate has no
          // conditional syntax to only show this when neededMin is known.
          neededText: neededMin != null ? ` (нужно: ${neededMin} мин)` : '',
          status: insufficient ? '⚠️ Не хватает времени' : 'В пределах нормы',
        });
      }
    }
    if (travelX.length > 0) {
      traces.push({
        type: 'bar',
        orientation: 'h',
        name: 'Время перехода',
        x: travelX,
        base: travelBase,
        y: travelY,
        customdata: travelCustom,
        hovertemplate:
          '<b>Переход</b>: %{customdata.from} → %{customdata.to}<br>' +
          'Разрыв: %{customdata.gapMin} мин%{customdata.neededText}<br>' +
          '%{customdata.status}' +
          '<extra></extra>',
        marker: { color: travelColor, opacity: 0.85 },
        showlegend: false,
      });
    }

    // Shift-duty shading — one rect per shift, spanning the employee's whole
    // row block (so it still covers every sub-row once expanded). While a
    // backlog task is being dragged, shifts of employees who qualify for it
    // are highlighted; everyone else fades out.
    const shiftShapes = staffShifts
      .filter(s => empRowRangeBU[s.name])
      .map(s => {
        const [y0, y1] = empRowRangeBU[s.name];
        let fillcolor = isDark ? 'rgba(90,140,255,0.10)' : 'rgba(30,80,200,0.06)';
        if (qualifyingEmployees) {
          fillcolor = qualifyingEmployees.has(s.name)
            ? (isDark ? 'rgba(82,196,26,0.30)' : 'rgba(82,196,26,0.22)')
            : (isDark ? 'rgba(90,90,100,0.04)' : 'rgba(90,90,100,0.03)');
        }
        return {
          type: 'rect',
          xref: 'x',
          yref: 'y',
          x0: s.shiftStart.getTime(),
          x1: s.shiftEnd.getTime(),
          y0: y0 - 0.42,
          y1: y1 + 0.42,
          fillcolor,
          line: { width: 0 },
          layer: 'below',
        };
      });

    return { traces, yOrderBottomUp, rowsTopDown: yRowsTopDown, rowCount, shiftShapes };
  }, [tasks, staffShifts, colorMap, filterTypes, filterFlight, expanded, isDark, qualifyingEmployees, distanceResolver]);

  function toggleEmployee(emp) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(emp)) next.delete(emp); else next.add(emp);
      return next;
    });
  }

  function openTimeEditor(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    setEditingTask(task);
    setEditStart(toDatetimeLocalValue(task.start));
    setEditEnd(toDatetimeLocalValue(task.end));
  }

  function saveTimeEdit() {
    const newStart = fromDatetimeLocalValue(editStart);
    const newEnd = fromDatetimeLocalValue(editEnd);
    if (newEnd <= newStart) return;
    onEditTaskTime?.(editingTask.id, newStart, newEnd);
    setEditingTask(null);
  }

  function handleRelayout(ev) {
    const r = parseRelayoutXRange(ev);
    if (r !== undefined) onVisibleRangeChange?.(r);
  }

  if (!plotData) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 128, color: '#9ca3af', fontSize: 14 }}>
        Нет данных — загрузите смены сотрудников на эту дату
      </div>
    );
  }

  const { traces, yOrderBottomUp, rowsTopDown, rowCount, shiftShapes } = plotData;

  const dateObj = new Date((windowStart || selectedDate) + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + windowDays * 24 * 3600000);
  // The visible time range is shared/controlled from above (App.jsx) so
  // zooming this chart also updates the backlog chart's ruler and vice
  // versa — falls back to the full window when nothing's zoomed yet.
  const range = visibleRange || [dateObj.getTime(), nextDay.getTime()];

  // Dashed separators at each midnight boundary inside the full window (not
  // just the zoomed-in range), so multi-day bars are still easy to read as
  // "day 1 / day 2 / day 3" regardless of zoom level.
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
  // Now that every on-shift employee gets a row (not just ones with tasks
  // already assigned), the chart can run to hundreds of rows — a taller
  // viewport means far less scrolling to reach a given time/employee.
  const containerH = Math.min(chartH, 780);
  // When the row list overflows, its container grows a native scrollbar
  // that the (never-scrolling) ruler above it doesn't — silently shrinking
  // the content plot's width relative to the ruler's and desyncing their
  // ticks. Reserve the same width on the ruler's right margin so both stay
  // the same width whether or not the scrollbar is actually showing.
  const SCROLLBAR_W = 16;
  const rulerExtraMargin = chartH > containerH ? SCROLLBAR_W : 0;

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FAFAFA';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const labelBg   = isDark ? '#1a1a2e' : '#FAFAFA';
  const subColor  = isDark ? '#a0a0b8' : '#666';

  // Left label column width — must match the top ruler's left margin (and
  // the backlog mini-chart's) so gridlines / time ticks line up everywhere.
  const ML = GANTT_LABEL_WIDTH;

  return (
    <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden' }}>

      {/* ── Sticky time ruler ── stays visible while scrolling the bars ─────── */}
      <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
        <Plot
          data={[]}
          layout={{
            height: 52,
            margin: { l: ML, r: 16 + rulerExtraMargin, t: 6, b: 36, autoexpand: false },
            xaxis: ganttXAxisConfig(range, fontColor, gridColor, true),
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
          {rowsTopDown.map(row => {
            const isQualifying = qualifyingEmployees && qualifyingEmployees.has(row.emp);
            const isDimmed = qualifyingEmployees && !isQualifying;
            return (
              <div
                key={row.yVal}
                onClick={row.hasArrow ? () => toggleEmployee(row.emp) : undefined}
                onDragOver={onDropAssign ? e => e.preventDefault() : undefined}
                onDrop={onDropAssign ? e => {
                  e.preventDefault();
                  const taskId = e.dataTransfer.getData('text/plain');
                  if (taskId) onDropAssign(taskId, row.emp);
                } : undefined}
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
                  color: row.isTravelRow ? subColor : (row.isEmployee ? fontColor : subColor),
                  fontStyle: row.isTravelRow ? 'italic' : 'normal',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  userSelect: 'none',
                  opacity: isDimmed ? 0.35 : 1,
                  background: isQualifying ? (isDark ? 'rgba(82,196,26,0.15)' : 'rgba(82,196,26,0.10)') : 'transparent',
                  transition: 'opacity 0.15s, background 0.15s',
                }}
              >
                {row.hasArrow && (
                  <span style={{ display: 'inline-block', width: 14, marginRight: 4, fontSize: 11, color: subColor }}>
                    {row.arrowOpen ? '▼' : '▶'}
                  </span>
                )}
                {!row.isEmployee && <span style={{ marginRight: 4, color: subColor }}>└</span>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</span>
                {row.delayMin > 0 && (
                  <span
                    title={`Задержка ~${row.delayMin} мин относительно исходного времени`}
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#fff',
                      background: row.delayMin > 30 ? '#ff4d4f' : '#faad14',
                      borderRadius: 4,
                      padding: '1px 5px',
                      flexShrink: 0,
                    }}
                  >
                    ⏱️+{row.delayMin}
                  </span>
                )}
                {row.overtimeMin > 0 && (
                  <span
                    title={`Переработка ~${row.overtimeMin} мин после конца смены (метрика «Задержаны после смены»)`}
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      color: '#fff',
                      background: row.overtimeMin > 30 ? '#ff4d4f' : '#faad14',
                      borderRadius: 4,
                      padding: '1px 5px',
                      flexShrink: 0,
                    }}
                  >
                    🕒+{row.overtimeMin}
                  </span>
                )}
              </div>
            );
          })}
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
                ...ganttXAxisConfig(range, fontColor, gridColor, false),
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
              dragmode: 'zoom', // click-drag over the timeline to zoom into a time range; double-click or the "Home" toolbar button resets
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
            onClick={ev => {
              const id = ev?.points?.[0]?.customdata?.id;
              if (id != null) openTimeEditor(id);
            }}
            onRelayout={handleRelayout}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </div>
      </div>

      <Modal
        title="Задача"
        open={!!editingTask}
        onCancel={() => setEditingTask(null)}
        footer={[
          <Button
            key="unassign"
            danger
            disabled={editingTask?.employee === 'Не назначено'}
            onClick={() => { onUnassignTask?.(editingTask.id); setEditingTask(null); }}
            style={{ float: 'left' }}
          >
            Вернуть в бэклог
          </Button>,
          <Button key="cancel" onClick={() => setEditingTask(null)}>Отмена</Button>,
          <Button key="save" type="primary" onClick={saveTimeEdit}>Сохранить время</Button>,
        ]}
      >
        {editingTask && (
          <div>
            <Typography.Text strong>{editingTask.name}</Typography.Text>
            <div style={{ fontSize: 12, color: subColor, marginBottom: 12 }}>
              Рейс {editingTask.flight} · POS {editingTask.pos} · {editingTask.employee}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                Начало
                <input
                  type="datetime-local"
                  value={editStart}
                  onChange={e => setEditStart(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    background: isDark ? '#1f1f1f' : '#fff',
                    color: isDark ? '#d4d4d4' : '#333',
                    border: `1px solid ${isDark ? '#444' : '#d9d9d9'}`,
                    borderRadius: 6,
                    colorScheme: isDark ? 'dark' : 'light',
                  }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                Окончание
                <input
                  type="datetime-local"
                  value={editEnd}
                  onChange={e => setEditEnd(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    background: isDark ? '#1f1f1f' : '#fff',
                    color: isDark ? '#d4d4d4' : '#333',
                    border: `1px solid ${isDark ? '#444' : '#d9d9d9'}`,
                    borderRadius: 6,
                    colorScheme: isDark ? 'dark' : 'light',
                  }}
                />
              </label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
