import Plot from 'react-plotly.js';
import { useMemo, useState } from 'react';
import { Modal, Button, Typography } from 'antd';
import { ganttXAxisConfig, GANTT_LABEL_WIDTH } from '../utils/ganttAxis';
import { hasAllQuals } from '../optimizer';

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
const ROW_PX = 30;

export default function GanttChart({
  tasks, staffShifts = [], windowDays = 1, windowStart, colorMap, selectedDate,
  filterTypes, filterFlight, isDark,
  draggingTask, onDropAssign, onEditTaskTime, onUnassignTask,
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

    // Every employee with a shift in the window gets a row even before any
    // task is assigned to them — so the chart is ready to drag tasks onto
    // as soon as data loads, not just after the optimizer has run.
    const employees = [...new Set([
      ...Object.keys(empTypesMap),
      ...staffShifts.map(s => s.name),
    ])].sort((a, b) => a.localeCompare(b, 'ru'));

    if (employees.length === 0) return null;

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
      const assignedTypes = empTypesMap[emp];
      const types = assignedTypes && assignedTypes.size > 0
        ? [...assignedTypes].sort()
        : [...(empRealQuals[emp] || [])].sort();
      const splittable = types.length > 1;
      const isExpanded = splittable && expanded.has(emp);
      const startIdx = yRowsTopDown.length;

      if (types.length === 0) {
        // On shift, nothing assigned yet.
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: false, emp, indent: 0 });
      } else if (!splittable) {
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: `${emp} (${types[0]})`, isEmployee: true, hasArrow: false, emp, indent: 0 });
      } else if (!isExpanded) {
        empYVal[emp] = emp;
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: true, arrowOpen: false, emp, indent: 0 });
      } else {
        empYVal[emp] = null; // per-task, resolved via reqType below
        yRowsTopDown.push({ yVal: emp, label: emp, isEmployee: true, hasArrow: true, arrowOpen: true, emp, indent: 0 });
        [...types].reverse().forEach(reqType => {
          yRowsTopDown.push({ yVal: `${emp}${SEP}${reqType}`, label: reqType, isEmployee: false, hasArrow: false, emp, indent: 1 });
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
  }, [tasks, staffShifts, colorMap, filterTypes, filterFlight, expanded, isDark, qualifyingEmployees]);

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
            xaxis: ganttXAxisConfig(dateObj, nextDay, fontColor, gridColor, true, windowDays),
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
                  color: row.isEmployee ? fontColor : subColor,
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
                ...ganttXAxisConfig(dateObj, nextDay, fontColor, gridColor, false, windowDays),
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
