// "Не назначено и почему": one compact card under the metrics tiles, shown after
// a calculation. It answers the dispatcher's first question — how many tasks of
// the selected day have no one, and why — with the same number the "Не назначено"
// tile and the badges show, and a way to the next step for each cause.
import { Button, Card, Tag, Typography } from 'antd';
import { fmtDM, dayStart } from '../utils/tz';
import { mutedColor, statusColor } from '../utils/uiFormat';

const { Text } = Typography;

// Qualifications that nobody on shift holds, with how many tasks each blocks.
function noQualList(byQual, limit = 4) {
  const rows = Object.entries(byQual)
    .filter(([, v]) => v.NO_QUAL > 0)
    .sort((a, b) => b[1].NO_QUAL - a[1].NO_QUAL);
  const shown = rows.slice(0, limit).map(([q, v]) => `${q}: ${v.NO_QUAL}`);
  return shown.join(', ') + (rows.length > limit ? ` и ещё ${rows.length - limit}` : '');
}

export default function UnassignedWhy({
  isDark, selectedDate, total, open, reasons, lowerBound, onShowTasks, onShowPlan,
}) {
  const muted = mutedColor(isDark);
  const day = fmtDM(dayStart(selectedDate));
  if (total === 0) return null;
  if (open === 0) {
    return (
      <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
        <Text style={{ color: statusColor(isDark, 'success') }}>Не назначено за {day}: 0 из {total} — все задачи дня распределены.</Text>
      </Card>
    );
  }
  // reasons is counted by the same rule as the tile; if the two ever differ
  // (the schedule changed after the reasons were computed) show no breakdown
  // rather than one that does not add up.
  const consistent = reasons && reasons.total === open;
  const lines = consistent ? [
    {
      key: 'NO_QUAL', n: reasons.byReason.NO_QUAL,
      text: <>нет допуска ни у кого на смене <Text type="secondary">({noQualList(reasons.byQual)})</Text></>,
      hint: 'пока допуска нет в справочнике, помогает только «Правила → Назначать без допуска»',
    },
    {
      key: 'NO_SHIFT_AT_TIME', n: reasons.byReason.NO_SHIFT_AT_TIME,
      text: <>допуск есть, но нет смены в это время</>,
      action: ['План вызова', onShowPlan],
    },
    {
      key: 'BUSY', n: reasons.byReason.BUSY,
      text: <>все с нужным допуском заняты</>,
      action: ['План вызова', onShowPlan],
    },
  ].filter(l => l.n > 0) : [];

  return (
    <Card size="small" styles={{ body: { padding: '10px 12px' } }} role="region" aria-label="Не назначено и почему">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text strong style={{ color: statusColor(isDark, 'danger'), fontSize: 15 }}>Не назначено за {day}: {open} из {total}</Text>
        {lowerBound != null && <Tag style={{ margin: 0 }}>лучше нельзя: {lowerBound}</Tag>}
        <Button size="small" onClick={onShowTasks}>Показать задачи</Button>
      </div>
      {lines.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {lines.map(l => (
            <li key={l.key} style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
              <b style={{ minWidth: 28, textAlign: 'right' }}>{l.n}</b>
              <span>{l.text}</span>
              {l.action && <Button type="link" size="small" style={{ padding: 0, height: 'auto' }} onClick={l.action[1]}>{l.action[0]} ›</Button>}
              {l.hint && <span style={{ fontSize: 12, color: muted }}>— {l.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
