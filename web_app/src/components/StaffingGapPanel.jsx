import { useMemo } from 'react';
import { Typography, Tag, Empty, Alert } from 'antd';
import { computeStaffingGaps } from '../utils/staffingGap';

const { Text } = Typography;

function fmtDT(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function StaffingGapPanel({ tasks, windowDates, windowStart, windowDays, fullRoster, scheduledNames, isDark }) {
  const backlogTasks = useMemo(
    () => tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено'),
    [tasks, windowDates]
  );

  const gaps = useMemo(() => computeStaffingGaps({
    backlogTasks, windowStart, windowDays, fullRoster, scheduledNames,
  }), [backlogTasks, windowStart, windowDays, fullRoster, scheduledNames]);

  if (backlogTasks.length === 0) {
    return <Empty description="Бэклог пуст — нехватки персонала нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const cardBg = isDark ? '#1a1a2e' : '#fafafa';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';

  return (
    <div>
      {fullRoster.length === 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Список кандидатов на подработку недоступен"
          description="Загрузите полный набор (tb_resources + tb_relation_resource_qualification), чтобы видеть, кого можно вызвать на смену — сейчас известны только задачи и требуемые квалификации."
        />
      )}

      {gaps.map(g => (
        <div
          key={g.reqTypeLabel}
          style={{ marginBottom: 12, padding: 12, border: `1px solid ${borderClr}`, borderRadius: 8, background: cardBg }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 14 }}>{g.reqTypeLabel}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {g.taskCount} задач(и) без исполнителя · пик потребности {g.peak} чел. одновременно
            </Text>
          </div>

          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            {g.intervals.map((iv, idx) => (
              <li key={idx} style={{ fontSize: 13 }}>
                нужно ещё <b>{iv.count}</b> чел. — {fmtDT(iv.start)}–{fmtDT(iv.end)}
              </li>
            ))}
          </ul>

          {fullRoster.length > 0 && (
            g.candidates.length > 0 ? (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Не в смене, но есть квалификация — можно вызвать:
                </Text>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {g.candidates.map(c => <Tag key={c.name}>{c.name}</Tag>)}
                </div>
              </div>
            ) : (
              <Text type="warning" style={{ fontSize: 12 }}>
                По личным данным сотрудников (вне контекста смены) подходящих не нашлось — но для квалификаций по типу ВС это не всегда означает, что реально некого позвать: такие допуски в системе фиксируются только на уровне конкретной смены, поэтому для несменных сотрудников их не видно.
              </Text>
            )
          )}
        </div>
      ))}
    </div>
  );
}
