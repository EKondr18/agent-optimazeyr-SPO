import { useState, useMemo } from 'react';
import { Table, Select, Button, Empty, Tag, Space } from 'antd';
import Plot from 'react-plotly.js';
import { hasAllQuals } from '../optimizer';
import { ganttXAxisConfig, GANTT_LABEL_WIDTH, parseRelayoutXRange } from '../utils/ganttAxis';

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

// Replicates GanttChart visual style for unassigned tasks
function BacklogGantt({ unassigned, colorMap, windowStart, windowDays, isDark, visibleRange, onVisibleRangeChange }) {
  const dateObj = new Date(windowStart + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + windowDays * 24 * 3600000);
  const range = visibleRange || [dateObj.getTime(), nextDay.getTime()];

  const { traces, yOrderBottomUp, rowLabels, rowCount } = useMemo(() => {
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
      rowLabels: flightSet, // top-down order, same as flightSet
      rowCount: flightSet.length,
    };
  }, [unassigned, colorMap]);

  const ROW_PX     = 26;
  const MARGIN_T   = 4;
  const MARGIN_B   = 8;
  const chartH     = Math.max(200, rowCount * ROW_PX + MARGIN_T + MARGIN_B);
  const containerH = Math.min(chartH, 380);
  // Same fix as the main Gantt chart: the scrollable row container below
  // grows a native scrollbar that this never-scrolling ruler doesn't,
  // which shrinks the content plot's width and desyncs its ticks from the
  // ruler's unless the ruler reserves the same width itself.
  const SCROLLBAR_W = 16;
  const rulerExtraMargin = chartH > containerH ? SCROLLBAR_W : 0;

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FFF7ED';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const labelBg   = isDark ? '#1a1a2e' : '#FFF7ED';

  // Shared with the main Gantt chart so the two time rulers line up.
  const ML = GANTT_LABEL_WIDTH;

  function handleRelayout(ev) {
    const r = parseRelayoutXRange(ev);
    if (r !== undefined) onVisibleRangeChange?.(r);
  }

  return (
    <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>

      {/* Sticky time ruler */}
      <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
        <Plot
          data={[]}
          layout={{
            height: 44,
            margin: { l: ML, r: 16 + rulerExtraMargin, t: 6, b: 28 },
            xaxis: ganttXAxisConfig(range, fontColor, gridColor, true),
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

      {/* Scrollable rows: custom label column (proper ellipsis + hover-title
          instead of Plotly's own y-axis labels getting cropped mid-character
          with no way to see the full flight ref) + bars */}
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
          {rowLabels.map(label => (
            <div
              key={label}
              title={label}
              style={{
                height: ROW_PX,
                display: 'flex',
                alignItems: 'center',
                paddingLeft: 12,
                paddingRight: 8,
                fontSize: 12,
                color: fontColor,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                userSelect: 'none',
              }}
            >
              {label}
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
              margin: { l: 0, r: 16, t: MARGIN_T, b: MARGIN_B },
              xaxis: {
                ...ganttXAxisConfig(range, fontColor, gridColor, false),
                showgrid: true,
                fixedrange: false,
              },
              yaxis: {
                categoryarray: yOrderBottomUp,
                categoryorder: 'array',
                showticklabels: false,
                automargin: false,
                gridcolor: isDark ? '#2a2a3e' : '#F3F4F6',
              },
              dragmode: 'zoom',
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
            onRelayout={handleRelayout}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </div>
      </div>
    </div>
  );
}

export default function BacklogPanel({
  tasks, staffList, windowDates, windowStart, windowDays, colorMap, onAssign, isDark,
  onAssignAttempt, onDragTaskChange, visibleRange, onVisibleRangeChange,
}) {
  const [selections, setSelections] = useState({});

  const unassigned = useMemo(
    () => tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено'),
    [tasks, windowDates]
  );

  const dateFilters = useMemo(
    () => windowDates.map(d => ({ text: d, value: d })),
    [windowDates]
  );
  const nameFilters = useMemo(
    () => [...new Set(unassigned.map(t => t.name))].sort().map(n => ({ text: n, value: n })),
    [unassigned]
  );

  if (unassigned.length === 0) {
    return <Empty description="Бэклог пуст — все задачи распределены" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  function handleAssignClick(task, sel) {
    onAssignAttempt(task, sel, staffList);
    setSelections(prev => { const n = { ...prev }; delete n[task.id]; return n; });
  }

  const columns = [
    {
      title: 'Дата / Время',
      key: 'time',
      width: 150,
      render: (_, t) => `${t.date} ${fmt(t.start)}–${fmt(t.end)}`,
      sorter: (a, b) => a.start - b.start,
      filters: dateFilters,
      onFilter: (value, record) => record.date === value,
    },
    {
      title: 'Тип задачи',
      key: 'name',
      filters: nameFilters,
      onFilter: (value, record) => record.name === value,
      filterSearch: true,
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
        visibleRange={visibleRange}
        onVisibleRangeChange={onVisibleRangeChange}
      />

      <Table
        dataSource={unassigned}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `Всего: ${total}` }}
        scroll={{ x: 600 }}
        onRow={record => ({
          draggable: true,
          onDragStart: e => {
            e.dataTransfer.setData('text/plain', record.id);
            e.dataTransfer.effectAllowed = 'move';
            onDragTaskChange?.(record);
          },
          onDragEnd: () => onDragTaskChange?.(null),
          style: { cursor: 'grab' },
        })}
      />
    </div>
  );
}
