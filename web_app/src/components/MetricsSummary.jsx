import { useMemo } from 'react';
import { Row, Col, Card, Statistic } from 'antd';
import { getPosDistance } from '../utils/posDistance';

export default function MetricsSummary({ tasks, staffList, selectedDate, distanceResolver }) {
  const dayTasks = tasks.filter(t => t.date === selectedDate);
  const assignedTasks = dayTasks.filter(t => t.employee !== 'Не назначено');
  const backlog = dayTasks.length - assignedTasks.length;
  const pct = dayTasks.length > 0 ? Math.round((assignedTasks.length / dayTasks.length) * 100) : 0;

  // Quality metrics — computed from the final assignment, not the
  // optimizer's internal passes, so they apply the same way whether the
  // schedule came from the optimizer or manual/drag-and-drop assignment.
  const quality = useMemo(() => {
    const shiftByName = new Map(staffList.map(s => [s.name, s]));
    const byEmployee = {};
    for (const t of assignedTasks) {
      if (!byEmployee[t.employee]) byEmployee[t.employee] = [];
      byEmployee[t.employee].push(t);
    }
    const loads = Object.values(byEmployee).map(list => list.length);
    const avgLoad = loads.length > 0 ? loads.reduce((s, v) => s + v, 0) / loads.length : 0;
    const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;

    // For each employee whose day runs past shift end, how late they
    // actually leave — the latest task's end time vs shiftEnd, not a sum
    // across every late task (what matters operationally is when they
    // clock out, not how many individual tasks happened to run late).
    let overtimeCount = 0;
    let overtimeMinutesSum = 0;
    for (const [name, list] of Object.entries(byEmployee)) {
      const shift = shiftByName.get(name);
      if (!shift) continue;
      const latestEnd = new Date(Math.max(...list.map(t => t.end.getTime())));
      if (latestEnd > shift.shiftEnd) {
        overtimeCount++;
        overtimeMinutesSum += (latestEnd - shift.shiftEnd) / 60000;
      }
    }
    const avgOvertimeMinutes = overtimeCount > 0 ? overtimeMinutesSum / overtimeCount : null;

    // Average distance an employee has to cover between two consecutive
    // (non-overlapping) tasks of their own — exit point of the earlier task
    // to entry point of the later one, same reference points the optimizer
    // itself uses. Real meters when the travel-network files are loaded;
    // otherwise the plain string heuristic's arbitrary units (still useful
    // for relative comparison between two runs, just not a real distance).
    let gapSum = 0, gapCount = 0;
    for (const list of Object.values(byEmployee)) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        if (cur.start < prev.end) continue; // overlapping (complementary-task exemption) — no travel needed
        const exitPos = prev.exitPos ?? prev.pos;
        const entryPos = cur.entryPos ?? cur.pos;
        const meters = distanceResolver ? distanceResolver.metersBetween(exitPos, entryPos) : null;
        const dist = meters != null ? meters : getPosDistance(exitPos, entryPos);
        gapSum += dist;
        gapCount++;
      }
    }
    const avgGap = gapCount > 0 ? gapSum / gapCount : null;

    return { avgLoad, maxLoad, overtimeCount, avgOvertimeMinutes, avgGap, hasRealDistance: !!distanceResolver };
  }, [assignedTasks, staffList, distanceResolver]);

  const tiles = [
    {
      title: 'Задач дня',
      value: dayTasks.length,
      prefix: '📋',
      valueStyle: {},
    },
    {
      title: 'Распределено',
      value: assignedTasks.length,
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
    {
      title: 'Ср. нагрузка на чел.',
      value: quality.avgLoad,
      precision: 1,
      prefix: '⚖️',
      valueStyle: {},
    },
    {
      title: 'Макс. нагрузка на 1 чел.',
      value: quality.maxLoad,
      prefix: '📈',
      valueStyle: quality.maxLoad > 0 && quality.maxLoad > quality.avgLoad * 1.5 ? { color: '#faad14' } : {},
    },
    {
      title: 'Задержаны после смены',
      value: quality.overtimeCount,
      prefix: '🕒',
      valueStyle: { color: quality.overtimeCount > 0 ? '#faad14' : '#52c41a' },
    },
    {
      title: 'Ср. переработка, мин',
      value: quality.avgOvertimeMinutes != null ? quality.avgOvertimeMinutes : '—',
      precision: quality.avgOvertimeMinutes != null ? 0 : undefined,
      prefix: '⏱️',
      valueStyle: quality.avgOvertimeMinutes > 30 ? { color: '#ff4d4f' } : {},
    },
    {
      title: quality.hasRealDistance ? 'Ср. переход между задачами, м' : 'Ср. переход между задачами (усл. ед.)',
      value: quality.avgGap != null ? quality.avgGap : '—',
      precision: quality.avgGap != null ? 0 : undefined,
      prefix: '🚶',
      valueStyle: {},
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
              precision={tile.precision}
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
