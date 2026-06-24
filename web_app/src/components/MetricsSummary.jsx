import { Row, Col, Card, Statistic } from 'antd';

export default function MetricsSummary({ tasks, staffList, selectedDate }) {
  const dayTasks = tasks.filter(t => t.date === selectedDate);
  const assigned = dayTasks.filter(t => t.employee !== 'Не назначено').length;
  const backlog = dayTasks.length - assigned;
  const pct = dayTasks.length > 0 ? Math.round((assigned / dayTasks.length) * 100) : 0;

  const tiles = [
    {
      title: 'Задач дня',
      value: dayTasks.length,
      prefix: '📋',
      valueStyle: {},
    },
    {
      title: 'Распределено',
      value: assigned,
      suffix: ` (${pct}%)`,
      prefix: '✅',
      valueStyle: { color: '#52c41a' },
    },
    {
      title: 'Бэклог',
      value: backlog,
      prefix: '⚠️',
      valueStyle: { color: backlog > 0 ? '#ff4d4f' : '#52c41a' },
    },
    {
      title: 'Доступно смены',
      value: staffList.length,
      prefix: '👥',
      valueStyle: { color: '#1677ff' },
    },
  ];

  return (
    <Row gutter={[12, 12]}>
      {tiles.map(tile => (
        <Col xs={12} sm={6} key={tile.title}>
          <Card size="small" style={{ textAlign: 'center' }} styles={{ body: { padding: '12px 8px' } }}>
            <Statistic
              title={tile.title}
              value={tile.value}
              prefix={tile.prefix}
              suffix={tile.suffix}
              valueStyle={{ fontSize: 22, ...tile.valueStyle }}
            />
          </Card>
        </Col>
      ))}
    </Row>
  );
}
