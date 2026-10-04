// Two short reports under the metrics:
//  • data problems that make tasks unassignable however good the search is
//    (no shifts on a date, a qualification nobody holds, staff with no
//    qualifications, suspicious task durations) — from dataQualityReport;
//  • what the last optimizer run achieved and how far that is from the best
//    possible (the lower bound on open tasks), plus the independent check.
import { Collapse, Tag, Typography } from 'antd';

const { Text } = Typography;

const pad = n => String(n).padStart(2, '0');
const fmtDT = d => {
  const x = new Date(d);
  return `${pad(x.getDate())}.${pad(x.getMonth() + 1)} ${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
const sec = ms => `${(ms / 1000).toFixed(1)} с`;

const VIOLATION_LABELS = {
  NO_SHIFT: 'нет смены',
  QUAL_MISSING: 'нет допуска',
  OUT_OF_SHIFT: 'вне смены',
  START_TRAVEL: 'не успеть дойти к началу',
  OVERLAP: 'пересечение задач',
  TRAVEL: 'не успеть перейти',
};

function List({ items, limit = 8, render }) {
  const shown = items.slice(0, limit);
  return (
    <span>
      {shown.map(render).reduce((acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [])}
      {items.length > limit && <Text type="secondary"> и ещё {items.length - limit}</Text>}
    </span>
  );
}

function QualityBody({ q }) {
  const rows = [];
  if (q.datesWithoutShifts.length) {
    rows.push(['Нет ни одной смены на датах', <List key="d" items={q.datesWithoutShifts} render={d => <b key={d}>{d}</b>} />,
      'задачи этих дат назначить некому']);
  }
  if (q.qualsNobodyHolds.length) {
    rows.push(['Допуски, которых нет ни у кого', <List key="q" items={q.qualsNobodyHolds}
      render={x => <span key={x.qual}><b>{x.qual}</b> ({x.tasks} задач)</span>} />, 'эти задачи останутся в бэклоге']);
  }
  if (q.staffWithoutQuals.length) {
    rows.push([`Сотрудники на сменах без единого допуска (${q.staffWithoutQuals.length})`,
      <List key="s" items={q.staffWithoutQuals} render={n => <span key={n}>{n}</span>} />,
      'проверьте tb_relation_resource_qualification']);
  }
  if (q.longTasks.length) {
    rows.push([`Задачи длиннее 12 часов (${q.longTasks.length})`, <List key="l" items={q.longTasks} limit={5}
      render={t => <span key={t.id}>{t.name} {fmtDT(t.start)} — <b>{t.hours} ч</b></span>} />,
      'похоже на ошибку времени в данных; задача не обрезается, а остаётся как есть']);
  }
  if (q.badIntervals.length) {
    rows.push([`Окончание не позже начала (${q.badIntervals.length})`, <List key="b" items={q.badIntervals}
      render={t => <span key={t.id}>{t.name} {fmtDT(t.start)}</span>} />, '']);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      {rows.map(([title, body, hint]) => (
        <div key={title}>
          <div><Text strong>{title}:</Text> {body}</div>
          {hint && <Text type="secondary" style={{ fontSize: 12 }}>{hint}</Text>}
        </div>
      ))}
    </div>
  );
}

function StatsBody({ s }) {
  const lb = s.lowerBound;
  const reachable = lb?.bound != null ? Math.max(0, s.openDay - lb.bound) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <div>
        <Text strong>За {s.selectedDate}:</Text> нераспределено <b>{s.openDay}</b> из {s.tasksDay} задач
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          По всему окну (±1 день; на краях окна не хватает смен соседних дней, поэтому там больше):
          после сборки {s.open.build} → после улучшения {s.open.improve} → после LNS {s.open.lns}
          {s.open.final !== s.open.lns && <> → после проверки {s.open.final}</>}
        </Text>
      </div>
      {lb?.bound != null ? (
        <div>
          <Text strong>Нижняя граница за день:</Text> при любом распределении останется не меньше <b>{lb.bound}</b>{' '}
          {lb.noEligible > 0 && <>({lb.noEligible} — задачи, которые некому выполнить вообще: нет смены с нужным допуском) </>}
          — значит, улучшить можно не больше чем на <b>{reachable}</b>.
          {lb.bottlenecks?.length > 0 && (
            <div style={{ marginTop: 2 }}>
              Где людей не хватает в принципе:{' '}
              <List items={lb.bottlenecks} limit={6} render={m => (
                <span key={String(m.at)}><b>{fmtDT(m.at)}</b> — {m.active} задач одновременно, людей хватает на {m.coverable}</span>
              )} />
            </div>
          )}
        </div>
      ) : (
        <div><Text strong>Нижняя граница:</Text> <Text type="secondary">не считается, пока разрешены параллельные задачи одного рейса</Text></div>
      )}
      <div>
        <Text strong>Проверка плана:</Text>{' '}
        {s.violations.length === 0
          ? <Tag color="green">нарушений нет</Tag>
          : <>
              <Tag color="red">{s.violations.length} нарушений у закреплённых вручную задач</Tag>
              <List items={s.violations} limit={5} render={v => (
                <span key={v.taskId + v.code}>{v.employee}: {VIOLATION_LABELS[v.code] || v.code}</span>
              )} />
            </>}
        {s.reopenedByCheck > 0 && <Text type="secondary"> (снято при проверке: {s.reopenedByCheck})</Text>}
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Время: сборка {sec(s.ms.build)}{s.construction ? ` (${s.construction === 'bestfit' ? 'плотная упаковка' : 'regret'})` : ''}, улучшение {sec(s.ms.improve)}
        {s.improveTermination === 'deadline' ? ' (остановлено по времени)' : ''}, LNS {sec(s.ms.lns)}
        {' '}({s.lns.iterations} попыток, принято {s.lns.accepted}), проверка {sec(s.ms.check)}
      </Text>
    </div>
  );
}

export default function PlanReport({ quality, stats, isDark }) {
  const items = [];
  if (quality && quality.issueCount > 0) {
    items.push({
      key: 'quality',
      label: <span>Проблемы в данных <Tag color="orange" style={{ marginLeft: 6 }}>{quality.issueCount}</Tag></span>,
      children: <QualityBody q={quality} />,
    });
  }
  if (stats) {
    items.push({
      key: 'stats',
      label: <span>Результат оптимизации <Tag color={stats.violations.length ? 'red' : 'green'} style={{ marginLeft: 6 }}>
        нераспределено за день {stats.openDay}{stats.lowerBound?.bound != null ? ` · минимум ${stats.lowerBound.bound}` : ''}
      </Tag></span>,
      children: <StatsBody s={stats} />,
    });
  }
  if (items.length === 0) return null;
  return (
    <Collapse
      size="small"
      items={items}
      defaultActiveKey={[]}
      style={{ background: isDark ? '#141414' : '#fff' }}
    />
  );
}
