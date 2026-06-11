import { useState, useMemo } from 'react';
import { Table, Input, InputNumber, Button, Space } from 'antd';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function TaskDelayPanel({ tasks, selectedDate, onApplyDelays }) {
  const [delays, setDelays] = useState({});
  const [filter, setFilter] = useState('');

  const dayTasks = useMemo(
    () => tasks.filter(t => t.date === selectedDate),
    [tasks, selectedDate]
  );

  const filtered = useMemo(() => {
    if (!filter.trim()) return dayTasks;
    const q = filter.toLowerCase();
    return dayTasks.filter(
      t => t.name.toLowerCase().includes(q) || t.flight.toLowerCase().includes(q)
    );
  }, [dayTasks, filter]);

  const columns = [
    {
      title: 'Задача',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
    },
    {
      title: 'Рейс',
      dataIndex: 'flight',
      key: 'flight',
      width: 120,
    },
    {
      title: 'POS',
      dataIndex: 'pos',
      key: 'pos',
      width: 80,
    },
    {
      title: 'Старт',
      key: 'start',
      width: 80,
      render: (_, t) => fmt(t.baseStart),
    },
    {
      title: 'Сдвиг (мин)',
      key: 'delay',
      width: 130,
      render: (_, t) => (
        <InputNumber
          min={0}
          max={300}
          step={5}
          value={delays[t.id] ?? 0}
          onChange={val => setDelays(prev => ({ ...prev, [t.id]: Math.max(0, Math.min(300, Number(val) || 0)) }))}
          size="small"
          style={{ width: 90 }}
        />
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Input.Search
          placeholder="Фильтр по рейсу или задаче…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: 260 }}
          allowClear
        />
        <Button type="primary" onClick={() => onApplyDelays(delays)}>
          🔄 Применить задержки
        </Button>
        <Button onClick={() => setDelays({})}>
          ↺ Сбросить всё
        </Button>
      </Space>

      <Table
        dataSource={filtered}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 25, showSizeChanger: false, showTotal: total => `Всего: ${total}` }}
        scroll={{ x: 600 }}
      />
    </div>
  );
}
