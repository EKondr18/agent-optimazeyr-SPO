import { useMemo } from 'react';
import { Row, Col, Card, Statistic, Typography } from 'antd';
import { getPosDistance } from '../utils/posDistance';
import { mutedColor, statusColor } from '../utils/uiFormat';
import { overtimeByShift } from '../utils/overtime';

// `calculated`: the optimizer has been run for this date. Before that nothing
// is assigned and "Распределено 0 / Бэклог 609" would read like a failure
// instead of "not done yet", so those tiles show a grey dash.
export default function MetricsSummary({ tasks, staffList, selectedDate, distanceResolver, isDark = false, calculated = true, running = false }) {
  const dayTasks = tasks.filter(t => t.date === selectedDate);
  const assignedTasks = dayTasks.filter(t => t.employee !== 'Не назначено');
  const backlog = dayTasks.length - assignedTasks.length;
  const pct = dayTasks.length > 0 ? Math.round((assignedTasks.length / dayTasks.length) * 100) : 0;
  const notCalculated = !calculated && assignedTasks.length === 0 && dayTasks.length > 0;
  const ok = statusColor(isDark, 'success');
  const warn = statusColor(isDark, 'warning');
  const bad = statusColor(isDark, 'danger');

  // Quality metrics — computed from the final assignment, not the
  // optimizer's internal passes, so they apply the same way whether the
  // schedule came from the optimizer or manual/drag-and-drop assignment.
  const quality = useMemo(() => {
    const byEmployee = {};
    for (const t of assignedTasks) {
      if (!byEmployee[t.employee]) byEmployee[t.employee] = [];
      byEmployee[t.employee].push(t);
    }
    const loads = Object.values(byEmployee).map(list => list.length);
    const avgLoad = loads.length > 0 ? loads.reduce((s, v) => s + v, 0) / loads.length : 0;
    const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;

    // How late each person-shift actually ends (see utils/overtime.js): once per
    // shift, against that shift's own end — not a sum across late tasks and not
    // against another shift of the same person.
    const overtime = overtimeByShift(assignedTasks, staffList);
    const overtimeCount = overtime.length;
    const avgOvertimeMinutes = overtimeCount > 0 ? overtime.reduce((s, o) => s + o.minutes, 0) / overtimeCount : null;

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

  const grey = { color: mutedColor(isDark) };
  const DASH = '—';
  const tiles = [
    {
      title: 'Задач дня',
      value: dayTasks.length,
      prefix: '📋',
      valueStyle: {},
    },
    {
      title: 'Распределено',
      value: notCalculated ? DASH : assignedTasks.length,
      suffix: notCalculated ? undefined : ` (${pct}%)`,
      prefix: '✅',
      valueStyle: notCalculated ? grey : { color: ok },
    },
    {
      title: 'Не назначено',
      value: notCalculated ? DASH : backlog,
      prefix: '⚠️',
      valueStyle: notCalculated ? grey : { color: backlog > 0 ? bad : ok },
    },
    {
      title: 'Доступно смены',
      value: staffList.length,
      prefix: '👥',
      valueStyle: { color: statusColor(isDark, 'info') },
    },
    {
      title: 'Ср. нагрузка на чел.',
      value: notCalculated ? DASH : quality.avgLoad,
      precision: notCalculated ? undefined : 1,
      prefix: '⚖️',
      valueStyle: notCalculated ? grey : {},
    },
    {
      title: 'Макс. нагрузка на 1 чел.',
      value: notCalculated ? DASH : quality.maxLoad,
      prefix: '📈',
      valueStyle: notCalculated ? grey : (quality.maxLoad > 0 && quality.maxLoad > quality.avgLoad * 1.5 ? { color: warn } : {}),
    },
    {
      title: 'Задержаны после смены',
      value: notCalculated ? DASH : quality.overtimeCount,
      prefix: '🕒',
      valueStyle: notCalculated ? grey : { color: quality.overtimeCount > 0 ? warn : ok },
    },
    {
      title: 'Ср. переработка, мин',
      note: 'на человека, у которого она есть',
      value: !notCalculated && quality.avgOvertimeMinutes != null ? quality.avgOvertimeMinutes : DASH,
      precision: !notCalculated && quality.avgOvertimeMinutes != null ? 0 : undefined,
      prefix: '⏱️',
      valueStyle: notCalculated ? grey : (quality.avgOvertimeMinutes > 30 ? { color: bad } : {}),
    },
    {
      title: quality.hasRealDistance ? 'Ср. переход между задачами, м' : 'Ср. переход между задачами (усл. ед.)',
      value: !notCalculated && quality.avgGap != null ? quality.avgGap : DASH,
      precision: !notCalculated && quality.avgGap != null ? 0 : undefined,
      prefix: '🚶',
      valueStyle: {},
    },
  ];

  return (
    <div>
      {notCalculated && !running && staffList.length > 0 && (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          Распределение ещё не рассчитано. Нажмите «Запустить оптимизатор» на боковой панели.
        </Typography.Text>
      )}
      <Row gutter={[12, 12]}>
        {tiles.map(tile => (
          <Col xs={12} sm={6} key={tile.title}>
            <Card size="small" style={{ textAlign: 'center' }} styles={{ body: { padding: '12px 8px' } }}>
              <Statistic
                title={tile.note ? <span>{tile.title}<br /><span style={{ fontSize: 12 }}>{tile.note}</span></span> : tile.title}
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
    </div>
  );
}
