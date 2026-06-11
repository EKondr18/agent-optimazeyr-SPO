import { useState, useMemo } from 'react';
import { Table, Select, Button, Empty, Tag, Space, Modal, Alert, Typography } from 'antd';
import Plot from 'react-plotly.js';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Check whether assigning `task` to `employeeName` creates a time conflict.
// Returns array of conflicting tasks (empty = no conflict).
function getConflicts(employeeName, task, tasks, selectedDate) {
  const empTasks = tasks.filter(t =>
    t.date === selectedDate &&
    t.employee === employeeName &&
    t.id !== task.id
  );
  const result = [];
  for (const et of empTasks) {
    // Complementary roles on same flight → overlap allowed
    if (et.flight === task.flight && et.flight !== 'Рейс не указ.' && et.name !== task.name) continue;
    if (et.start < task.end && task.start < et.end) result.push(et);
  }
  return result;
}

// Replicates GanttChart visual style for unassigned tasks
function BacklogGantt({ unassigned, colorMap, selectedDate, isDark }) {
  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay  = new Date(dateObj.getTime() + 24 * 3600000);

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
  const containerH = Math.min(chartH, 420);

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg    = isDark ? '#1a1a2e' : '#FFF7ED';

  return (
    <div
      style={{
        height: containerH,
        overflowY: 'auto',
        overflowX: 'hidden',
        border: `1px solid ${isDark ? '#2d2d2d' : '#f0f0f0'}`,
        borderRadius: 8,
        marginBottom: 16,
      }}
    >
      <Plot
        data={traces}
        layout={{
          height: chartH,
          barmode: 'overlay',
          bargap: 0.15,
          showlegend: true,
          margin: { l: 140, r: 16, t: 52, b: 50 },
          xaxis: {
            type: 'date',
            range: [dateObj.getTime(), nextDay.getTime()],
            tickformat: '%H:%M',
            dtick: 3600000 * 2,
            gridcolor: gridColor,
            tickfont: { color: fontColor },
            mirror: 'allticks',  // time labels at top AND bottom → top stays visible on scroll
            showline: true,
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
            y: -0.08,
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
  );
}

export default function BacklogPanel({ tasks, staffList, selectedDate, colorMap, onAssign, isDark }) {
  const [selections, setSelections] = useState({});
  const [conflictInfo, setConflictInfo] = useState(null);

  const unassigned = useMemo(
    () => tasks.filter(t => t.date === selectedDate && t.employee === 'Не назначено'),
    [tasks, selectedDate]
  );

  if (unassigned.length === 0) {
    return <Empty description="Бэклог пуст — все задачи распределены" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  function handleAssignClick(task, sel) {
    const conflicts = getConflicts(sel, task, tasks, selectedDate);
    if (conflicts.length === 0) {
      onAssign(task.id, sel, true);
      setSelections(prev => { const n = { ...prev }; delete n[task.id]; return n; });
    } else {
      // Build list of alternatives: qualified, in shift, no conflict
      const alternatives = staffList.filter(s =>
        s.name !== sel &&
        s.quals.includes(task.reqType) &&
        s.shiftStart <= task.start &&
        task.end <= s.shiftEnd &&
        getConflicts(s.name, task, tasks, selectedDate).length === 0
      );
      setConflictInfo({ task, sel, conflicts, alternatives });
    }
  }

  const columns = [
    {
      title: 'Время',
      key: 'time',
      width: 120,
      render: (_, t) => `${fmt(t.start)}–${fmt(t.end)}`,
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
          <Tag color={t.reqType === 'SV' ? 'blue' : 'green'} size="small">{t.reqType}</Tag>
        </Space>
      ),
    },
    {
      title: 'Назначить',
      key: 'assign',
      width: 240,
      render: (_, task) => {
        const eligible = staffList.filter(s =>
          s.quals.includes(task.reqType) &&
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
        selectedDate={selectedDate}
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
