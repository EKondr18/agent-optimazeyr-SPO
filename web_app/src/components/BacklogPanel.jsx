import { useState, useMemo } from 'react';
import { Table, Select, Button, Empty, Tag, Space, Modal, Alert, Typography } from 'antd';
import Plot from 'react-plotly.js';
import { hasAllQuals, conflictsWith } from '../optimizer';

const QUAL_TAG_COLORS = ['blue', 'geekblue', 'purple', 'magenta', 'volcano', 'orange', 'gold', 'green', 'cyan'];

// Deterministic color per qualification code, since the corporate SPO_-prefixed
// codes aren't a fixed 2-value set (SV/GH) — any number of distinct codes can
// appear, so the color is derived from the string itself rather than hardcoded.
function qualTagColor(qual) {
  let hash = 0;
  for (let i = 0; i < qual.length; i++) hash = (hash * 31 + qual.charCodeAt(i)) | 0;
  return QUAL_TAG_COLORS[Math.abs(hash) % QUAL_TAG_COLORS.length];
}

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Check whether assigning `task` to `employeeName` creates a time conflict.
// Returns array of conflicting tasks (empty = no conflict). Uses the exact
// same conflictsWith the optimizer uses (including the travel-gap check),
// instead of a separate copy — an earlier duplicate of this logic drifted
// out of sync with the optimizer's and caused a real double-booking bug.
// Deliberately not filtered by date: the backlog spans a 3-day window, and
// a task can be bucketed under one day's date while its actual time
// overlaps a task bucketed under the next (a shift/task crossing midnight).
function getConflicts(employeeName, task, tasks, resolver) {
  const empTasks = tasks.filter(t =>
    t.employee === employeeName &&
    t.id !== task.id
  );
  return empTasks.filter(et => conflictsWith(et, task, resolver));
}

function xAxisCfg(dateObj, nextDay, fontColor, gridColor, showLabels, windowDays) {
  return {
    type: 'date',
    range: [dateObj.getTime(), nextDay.getTime()],
    tickformat: windowDays > 1 ? '%H:%M\n%d.%m' : '%H:%M',
    dtick: 3600000 * (windowDays > 1 ? 4 : 2),
    gridcolor: gridColor,
    tickfont: { color: fontColor, size: 11 },
    showticklabels: showLabels,
    showgrid: !showLabels,
    zeroline: false,
    fixedrange: true,
  };
}

// Replicates GanttChart visual style for unassigned tasks
function BacklogGantt({ unassigned, colorMap, windowStart, windowDays, isDark }) {
  const dateObj = new Date(windowStart + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + windowDays * 24 * 3600000);

  const { traces, yOrderBottomUp, rowCount } = useMemo(() => {
    const flightSet = [...new Set(unassigned.map(t => t.flight))].sort();

    const byName = {};
    for (const t of unassigned) {
      if (!byName[t.name]) byName[t.name] = [];
      byName[t.name].push(t);
    }

    const traces = Object.entries(byName).map(([name, list]) => {
      const color = colorMap[name] || '#888';
      return {
        type: 'bar',
        orientation: 'h',
        name,
        x: list.map(t => t.end - t.start),
        base: list.map(t => t.start.getTime()),
        y: list.map(t => t.flight),
        text: list.map(t => {
          const mins = Math.round((t.end - t.start) / 60000);
          return mins >= 30 ? name.substring(0, 12) : '';
        }),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 9, color: '#fff' },
        customdata: list.map(t => ({
          desc:   t.name,
          flight: t.flight,
          pos:    t.pos,
          qual:   t.reqType,
          start:  fmt(t.start),
          end:    fmt(t.end),
          dur:    `${Math.round((t.end - t.start) / 60000)} мин`,
        })),
        hovertemplate:
          '<b>%{customdata.desc}</b><br>' +
          'Рейс: <b>%{customdata.flight}</b>  |  POS: %{customdata.pos}<br>' +
          'Время: %{customdata.start} – %{customdata.end}  (%{customdata.dur})<br>' +
          'Квалификация: %{customdata.qual}<br>' +
          '<extra>⚠ Не назначено</extra>',
        marker: { color, opacity: 0.9 },
      };
    });

    return {
      traces,
      yOrderBottomUp: [...flightSet].reverse(),
      rowCount: flightSet.length,
    };
  }, [unassigned, colorMap]);

  const ROW_PX     = 26;
  const chartH     = Math.max(200, rowCount * ROW_PX + 110);
  const containerH = Math.min(chartH, 380);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FFF7ED';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';

  const ML = 140;

  return (
    <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>

      {/* Sticky time ruler */}
      <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
        <Plot
          data={[]}
          layout={{
            height: 44,
            margin: { l: ML, r: 16, t: 6, b: 28 },
            xaxis: xAxisCfg(dateObj, nextDay, fontColor, gridColor, true, windowDays),
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

      {/* Scrollable bars */}
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
              ...xAxisCfg(dateObj, nextDay, fontColor, gridColor, false, windowDays),
              showgrid: true,
              fixedrange: false,
            },
            yaxis: {
              categoryarray: yOrderBottomUp,
              categoryorder: 'array',
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
            hoverlabel: { font: { size: 12 }, namelength: -1 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: plotBg,
            font: { color: fontColor },
          }}
          config={{
            responsive: true,
            displayModeBar: true,
            modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
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

export default function BacklogPanel({ tasks, staffList, windowDates, windowStart, windowDays, colorMap, onAssign, isDark, distanceResolver }) {
  const [selections, setSelections] = useState({});
  const [conflictInfo, setConflictInfo] = useState(null);

  const unassigned = useMemo(
    () => tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено'),
    [tasks, windowDates]
  );

  if (unassigned.length === 0) {
    return <Empty description="Бэклог пуст — все задачи распределены" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  function handleAssignClick(task, sel) {
    const conflicts = getConflicts(sel, task, tasks, distanceResolver);
    if (conflicts.length === 0) {
      onAssign(task.id, sel, true);
      setSelections(prev => { const n = { ...prev }; delete n[task.id]; return n; });
    } else {
      // Build list of alternatives: qualified, in shift, no conflict
      const alternatives = staffList.filter(s =>
        s.name !== sel &&
        hasAllQuals(s.quals, task) &&
        s.shiftStart <= task.start &&
        task.end <= s.shiftEnd &&
        getConflicts(s.name, task, tasks, distanceResolver).length === 0
      );
      setConflictInfo({ task, sel, conflicts, alternatives });
    }
  }

  const columns = [
    {
      title: 'Дата / Время',
      key: 'time',
      width: 150,
      render: (_, t) => `${t.date} ${fmt(t.start)}–${fmt(t.end)}`,
      sorter: (a, b) => a.start - b.start,
    },
    {
      title: 'Тип задачи',
      key: 'name',
      render: (_, t) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: colorMap[t.name] || '#888', display: 'inline-block', flexShrink: 0 }} />
          {t.name}
        </span>
      ),
    },
    {
      title: 'Рейс / POS',
      key: 'flight',
      render: (_, t) => (
        <Space size={4}>
          <span>{t.flight}</span>
          <Tag size="small">{t.pos}</Tag>
          {(t.reqTypes && t.reqTypes.length > 0 ? t.reqTypes : [t.reqType]).map(q => (
            <Tag key={q} color={qualTagColor(q)} size="small">{q}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: 'Назначить',
      key: 'assign',
      width: 240,
      render: (_, task) => {
        const eligible = staffList.filter(s =>
          hasAllQuals(s.quals, task) &&
          s.shiftStart <= task.start &&
          task.end <= s.shiftEnd
        );
        const sel = selections[task.id] || null;
        return (
          <Space>
            <Select
              value={sel}
              onChange={val => setSelections(prev => ({ ...prev, [task.id]: val }))}
              placeholder="Выбрать…"
              style={{ width: 150 }}
              size="small"
              options={eligible.map(s => ({ value: s.name, label: s.name }))}
            />
            <Button
              type="primary"
              size="small"
              disabled={!sel}
              onClick={() => sel && handleAssignClick(task, sel)}
            >
              Назначить
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div>
      <BacklogGantt
        unassigned={unassigned}
        colorMap={colorMap}
        windowStart={windowStart}
        windowDays={windowDays}
        isDark={isDark}
      />

      <Table
        dataSource={unassigned}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `Всего: ${total}` }}
        scroll={{ x: 600 }}
      />

      {/* Conflict warning modal */}
      <Modal
        title={<span style={{ color: '#ff4d4f' }}>⚠️ Конфликт расписания</span>}
        open={!!conflictInfo}
        onCancel={() => setConflictInfo(null)}
        footer={[
          <Button key="cancel" onClick={() => setConflictInfo(null)}>
            Отмена
          </Button>,
          <Button
            key="force"
            type="primary"
            danger
            onClick={() => {
              onAssign(conflictInfo.task.id, conflictInfo.sel, true);
              setSelections(prev => { const n = { ...prev }; delete n[conflictInfo.task.id]; return n; });
              setConflictInfo(null);
            }}
          >
            Назначить принудительно
          </Button>,
        ]}
      >
        <Alert
          type="error"
          showIcon
          message={`Сотрудник ${conflictInfo?.sel} занят в это время`}
          description={
            <ul style={{ marginTop: 4, paddingLeft: 16, marginBottom: 0 }}>
              {conflictInfo?.conflicts.map(c => (
                <li key={c.id}>
                  <b>{c.name}</b> · {fmt(c.start)}–{fmt(c.end)} · рейс {c.flight}
                </li>
              ))}
            </ul>
          }
          style={{ marginBottom: 16 }}
        />

        {conflictInfo?.alternatives.length > 0 ? (
          <div>
            <Typography.Text strong>Свободные сотрудники с нужной квалификацией:</Typography.Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              {conflictInfo.alternatives.map(alt => (
                <Button
                  key={alt.name}
                  size="small"
                  onClick={() => {
                    onAssign(conflictInfo.task.id, alt.name, true);
                    setSelections(prev => { const n = { ...prev }; delete n[conflictInfo.task.id]; return n; });
                    setConflictInfo(null);
                  }}
                >
                  {alt.name}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <Alert
            type="warning"
            showIcon
            message="Нет свободных альтернатив"
            description="Все квалифицированные сотрудники заняты в это время. Можно назначить принудительно."
          />
        )}
      </Modal>
    </div>
  );
}
