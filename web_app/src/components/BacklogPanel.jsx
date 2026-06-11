import { useState, useMemo } from 'react';
import { Table, Select, Button, Empty, Tag, Space } from 'antd';
import Plot from 'react-plotly.js';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function BacklogPanel({ tasks, staffList, selectedDate, colorMap, onAssign, isDark }) {
  const [selections, setSelections] = useState({});

  const unassigned = useMemo(
    () => tasks.filter(t => t.date === selectedDate && t.employee === 'Не назначено'),
    [tasks, selectedDate]
  );

  const dateObj = new Date(selectedDate + 'T00:00:00');
  const nextDay = new Date(dateObj.getTime() + 24 * 3600000);

  const ganttTraces = useMemo(() => {
    const byFlight = {};
    for (const t of unassigned) {
      if (!byFlight[t.flight]) byFlight[t.flight] = [];
      byFlight[t.flight].push(t);
    }
    return Object.entries(byFlight).map(([flight, list]) => ({
      type: 'bar',
      orientation: 'h',
      name: flight,
      x: list.map(t => t.end - t.start),
      base: list.map(t => t.start.getTime()),
      y: list.map(() => flight),
      text: list.map(t => `${t.name} (${fmt(t.start)}–${fmt(t.end)})`),
      hoverinfo: 'text',
      marker: { color: list.map(t => colorMap[t.name] || '#888') },
    }));
  }, [unassigned, colorMap]);

  if (unassigned.length === 0) {
    return <Empty description="Бэклог пуст — все задачи распределены" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const fontColor = isDark ? '#d4d4d4' : '#444';
  const plotBg = isDark ? '#1a1a2e' : '#FFF7ED';
  const gridColor = isDark ? '#2d2d2d' : '#e5e7eb';

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
              onClick={() => {
                if (sel) {
                  onAssign(task.id, sel, true);
                  setSelections(prev => { const n = { ...prev }; delete n[task.id]; return n; });
                }
              }}
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
      <div style={{ marginBottom: 16 }}>
        <Plot
          data={ganttTraces}
          layout={{
            height: 280,
            barmode: 'overlay',
            showlegend: false,
            margin: { l: 120, r: 20, t: 10, b: 40 },
            xaxis: {
              type: 'date',
              range: [dateObj.getTime(), nextDay.getTime()],
              tickformat: '%H:%M',
              dtick: 3600000 * 3,
              tickfont: { color: fontColor },
              gridcolor: gridColor,
            },
            yaxis: { automargin: true, tickfont: { color: fontColor } },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: plotBg,
            font: { color: fontColor },
          }}
          config={{ responsive: true, displayModeBar: false }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </div>

      <Table
        dataSource={unassigned}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false, showTotal: total => `Всего: ${total}` }}
        scroll={{ x: 600 }}
      />
    </div>
  );
}
