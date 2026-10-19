// Two short reports under the metrics:
//  • data problems that make tasks unassignable however good the search is
//    (no shifts on a date, a qualification nobody holds, staff with no
//    qualifications, suspicious task durations) — from dataQualityReport;
//  • what the last optimizer run achieved and how far that is from the best
//    possible (the lower bound on open tasks), plus the independent check.
import { Alert, Collapse, Tag, Typography } from 'antd';
import { fmtDMHM } from '../utils/tz';
import { countRu } from '../utils/uiFormat';

const { Text } = Typography;

const fmtDT = d => fmtDMHM(new Date(d));
const sec = ms => `${(ms / 1000).toFixed(1)} с`;

const VIOLATION_LABELS = {
  NO_SHIFT: 'нет смены',
  QUAL_MISSING: 'нет допуска',
  OUT_OF_SHIFT: 'вне смены',
  START_TRAVEL: 'не успеть дойти к началу',
  OVERLAP: 'пересечение задач',
  TRAVEL: 'не успеть перейти',
};

// Why a day's window is incomplete (reason codes of dataQualityReport).
const WINDOW_REASONS = {
  NO_SHIFTS_DAY: 'нет смен в этот день',
  NO_SHIFTS_PREV: 'нет смен накануне',
  NO_SHIFTS_NEXT: 'нет смен на следующие сутки',
  FEW_PEOPLE: 'людей меньше половины обычного',
};
// Why a task took no part in the calculation (reason codes of the core).
const INVALID_REASONS = {
  NO_ID: 'нет id',
  DUPLICATE_ID: 'повтор id',
  NOT_AN_OBJECT: 'не задача',
  BAD_START: 'нечитаемое начало',
  BAD_END: 'нечитаемое окончание',
  END_NOT_AFTER_START: 'конец не позже начала',
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
  if (q.loadSkipped && q.loadSkipped.warnings.length) {
    const n = q.loadSkipped.skippedTotal;
    rows.push([n > 0 ? `При загрузке пропущено строк: ${n}` : `Замечания при загрузке (${q.loadSkipped.warnings.length})`,
      <details key="w" style={{ display: 'inline' }}>
        <summary style={{ cursor: 'pointer', display: 'inline' }}>показать, что и почему</summary>
        <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{q.loadSkipped.warnings.map(w => <li key={w}>{w}</li>)}</ul>
      </details>,
      'пропущенные строки не участвуют в расчёте — проверьте выгрузку']);
  }
  if (q.datesWithoutShifts.length) {
    rows.push(['Нет ни одной смены на датах', <List key="d" items={q.datesWithoutShifts} render={d => <b key={d}>{d}</b>} />,
      'задачи этих дат назначить некому']);
  }
  if (q.qualsNobodyHolds.length) {
    rows.push(['Допуск, которого нет ни у кого на смене', <List key="q" items={q.qualsNobodyHolds} limit={6}
      render={x => <span key={x.qual}><b>{x.qual}</b> — {countRu(x.tasks, 'задача', 'задачи', 'задач')} за {countRu(x.days, 'день', 'дня', 'дней')}</span>} />,
      'эти задачи останутся не назначенными, пока допуска нет у людей на смене']);
  }
  if (q.incompleteWindowDays.length) {
    rows.push(['Дни с неполным окном (нет смен соседних суток)', <List key="i" items={q.incompleteWindowDays} limit={6}
      render={x => <span key={x.date}><b>{x.date}</b> ({x.reasons.map(r => WINDOW_REASONS[r] || r).join(', ')})</span>} />,
      'на краях такого окна не хватает людей из соседних суток — не назначенных задач там больше, чем будет в работе']);
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

function StatsBody({ s, open, stale }) {
  const lb = s.lowerBound;
  const reachable = lb?.bound != null ? Math.max(0, open - lb.bound) : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      {stale && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          После расчёта расписание изменили (вручную или планом вызова); ниже — итог самого расчёта, не нынешнее состояние.
        </Text>
      )}
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          По всему окну (±1 день; на краях окна не хватает смен соседних дней, поэтому там больше не назначено):
          после сборки {s.open.build} → после улучшения {s.open.improve} → после доп. поиска {s.open.lns}
          {s.open.final !== s.open.lns && <> → после проверки {s.open.final}</>}
        </Text>
      </div>
      {lb?.bound != null ? (
        <div>
          <Text strong>Лучший возможный результат за день:</Text> при любом распределении останется не назначено не меньше <b>{lb.bound}</b>{' '}
          {lb.noEligible > 0 && <>({lb.noEligible} — задачи, которые некому выполнить вообще: нет смены с нужным допуском) </>}
          {!stale && <>— значит, улучшить можно не больше чем на <b>{reachable}</b>.</>}
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
        <div><Text strong>Лучший возможный результат:</Text> <Text type="secondary">не считается, пока разрешены параллельные задачи одного рейса</Text></div>
      )}
      <div>
        <Text strong>Проверка плана:</Text>{' '}
        {s.violations.length === 0
          ? <Tag color="green">нарушений нет</Tag>
          : <>
              <Tag color="red">{s.violations.length} нарушений у закреплённых вручную задач</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                (назначены принудительно; оптимизатор их не меняет и «Применить план» из-за них не отказывает){' '}
              </Text>
              <List items={s.violations} limit={5} render={v => (
                <span key={v.taskId + v.code}>{v.employee}: {VIOLATION_LABELS[v.code] || v.code}</span>
              )} />
            </>}
        {s.reopenedByCheck > 0 && <Text type="secondary"> (снято при проверке: {s.reopenedByCheck})</Text>}
        {s.waived > 0 && <Tag color="orange" style={{ marginLeft: 6 }}>{s.waived} назначено без допуска (по правилу)</Tag>}
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Время: сборка {sec(s.ms.build)}, улучшение {sec(s.ms.improve)}
        {s.improveTermination === 'deadline' ? ' (остановлено по времени)' : ''}, доп. поиск {sec(s.ms.lns)}
        {' '}({s.lns.iterations} попыток, принято {s.lns.accepted}), проверка {sec(s.ms.check)}
      </Text>
    </div>
  );
}

// `current`: { open, total } of the selected day as it is NOW. The stats are
// those of the last optimizer run; after a manual assignment or an applied call-in
// plan they describe an older schedule, so they are not shown as today's figure.
export default function PlanReport({ quality, stats, isDark, current }) {
  const items = [];
  const extra = (quality?.incompleteWindowDays?.length ?? 0) + (quality?.loadSkipped?.warnings?.length ?? 0);
  const problems = quality ? quality.issueCount + extra : 0;
  if (quality && problems > 0) {
    items.push({
      key: 'quality',
      label: <span>Проблемы в данных <Tag color="orange" style={{ marginLeft: 6 }}>{problems}</Tag></span>,
      children: <QualityBody q={quality} />,
    });
  }
  const stale = stats && current && current.open !== stats.openDay;
  if (stats) {
    const bound = stats.lowerBound?.bound;
    items.push({
      key: 'stats',
      label: <span>Результат оптимизации <Tag color={stats.violations.length ? 'red' : undefined} style={{ marginLeft: 6 }}>
        {stale
          ? 'расписание менялось после расчёта'
          : `не назначено за день ${stats.openDay}${bound != null ? ` · лучше нельзя ${bound}` : ''}`}
      </Tag></span>,
      children: <StatsBody s={stats} open={current ? current.open : stats.openDay} stale={stale} />,
    });
  }
  const invalid = stats?.invalid;
  const cut = stats && (stats.timeCut || stats.terminationReason === 'deadline');
  if (items.length === 0 && !cut && !(invalid?.count > 0)) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {cut && (
        <Alert
          type="warning" showIcon
          message="Расчёт остановлен по времени — результат может отличаться при повторном запуске."
          description="Сработал предохранитель по времени (машина оказалась медленной или занятой). Запустите оптимизатор ещё раз: при обычной скорости результат всегда один и тот же."
        />
      )}
      {invalid?.count > 0 && (
        <Alert
          type="warning" showIcon
          message={`Исключено из расчёта ${countRu(invalid.count, 'задача', 'задачи', 'задач')} (дубли, некорректное время)`}
          description={Object.entries(invalid.reasons).map(([r, n]) => `${INVALID_REASONS[r] || r} — ${n}`).join('; ')
            + '. Такие задачи остаются в списке «Не назначено» и в расчёте не участвуют.'}
        />
      )}
      {items.length > 0 && (
        <Collapse
          size="small"
          items={items}
          defaultActiveKey={[]}
          style={{ background: isDark ? '#141414' : '#fff' }}
        />
      )}
    </div>
  );
}
