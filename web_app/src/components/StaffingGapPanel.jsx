import { useMemo, useState } from 'react';
import { Typography, Empty, Alert, Segmented, Tag } from 'antd';
import Plot from 'react-plotly.js';
import { computeStaffingGaps, resolveStaffingWithCallIns } from '../utils/staffingGap';
import { GRANULARITY_OPTIONS } from '../utils/staffDemand';
import { qualColor } from '../utils/qualColors';
import { ganttXAxisConfig, GANTT_LABEL_WIDTH, parseRelayoutXRange } from '../utils/ganttAxis';

const { Text } = Typography;

function fmtDT(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtT(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtHours(ms) {
  const h = ms / 3600000;
  return Number.isInteger(h) ? `${h}` : h.toFixed(1);
}

// Every proposal is tagged with which RELAX_TIERS level found it (see
// utils/staffingGap.js) — "normal" fits the tidy 2h/12h defaults, "tight"
// and "forced" mean the rules had to bend to guarantee someone is proposed
// at all, and the color/label makes that visible so the dispatcher knows
// which picks to double-check rather than accept blindly.
const TIER_INFO = {
  normal: { color: null, label: '' },
  tight: { color: 'orange', label: 'сжато' },
  forced: { color: 'red', label: 'крайний случай' },
};

// Tasks to actually show for one proposed action: a fresh call-in shows
// their whole engagement window; an extended shift shows only the tasks
// that landed in the newly-added time (before/after their original shift)
// — their pre-existing shift is already visible in the main Gantt, what
// matters here is what the extension specifically bought.
function actionTasks(action, finalTasks) {
  if (action.type === 'callin') {
    return finalTasks.filter(t => t.employee === action.name);
  }
  return finalTasks.filter(t =>
    t.employee === action.name && (t.start < action.originalStart || t.end > action.originalEnd)
  );
}

// Mini Gantt for the resolution plan: one row per real named employee
// proposed for a call-in or shift extension, bars = the task(s) they'd
// cover, colored by required qualification, with the qual/flight/time
// labeled directly on wide-enough bars (not hover-only) plus a color
// legend, so the plan reads at a glance instead of needing to hover every
// bar — answers "фамилия и какую квалификацию он закроет и когда" directly.
function CallInGantt({ actions, finalTasks, windowStart, windowDays, isDark }) {
  const [visibleRange, setVisibleRange] = useState(null);
  const dateObj = new Date(windowStart + 'T00:00:00');
  const nextDay = new Date(dateObj.getTime() + windowDays * 24 * 3600000);
  const range = visibleRange || [dateObj.getTime(), nextDay.getTime()];

  const rows = useMemo(() => actions.map(a => ({ action: a, tasks: actionTasks(a, finalTasks) })), [actions, finalTasks]);
  const names = rows.map(r => r.action.name);

  const usedQuals = useMemo(() => {
    const set = new Set();
    for (const r of rows) for (const t of r.tasks) set.add(t.reqType || '?');
    return [...set];
  }, [rows]);

  const traces = useMemo(() => rows.map(({ action, tasks }) => ({
    type: 'bar',
    orientation: 'h',
    name: action.name,
    x: tasks.map(t => t.end - t.start),
    base: tasks.map(t => t.start.getTime()),
    y: tasks.map(() => action.name),
    marker: { color: tasks.map(t => qualColor(t.reqType || '?')), opacity: 0.9, line: { color: isDark ? '#000' : '#fff', width: 1 } },
    text: tasks.map(t => {
      const mins = Math.round((t.end - t.start) / 60000);
      return mins >= 18 ? (t.reqType || '') : '';
    }),
    textposition: 'inside',
    insidetextanchor: 'middle',
    textfont: { size: 10, color: '#fff' },
    customdata: tasks.map(t => ({
      qual: t.reqType, flight: t.flight, pos: t.pos, start: fmtT(t.start), end: fmtT(t.end),
    })),
    hovertemplate:
      `<b>${action.name}</b><br>` +
      'Квалификация: %{customdata.qual}<br>' +
      'Рейс: %{customdata.flight}  |  POS: %{customdata.pos}<br>' +
      'Время: %{customdata.start} – %{customdata.end}' +
      '<extra></extra>',
    showlegend: false,
  })), [rows, isDark]);

  const ROW_PX = 32;
  const MARGIN_T = 4, MARGIN_B = 8;
  const chartH = Math.max(120, names.length * ROW_PX + MARGIN_T + MARGIN_B);
  const fontColor = isDark ? '#d4d4d4' : '#444';
  const gridColor = isDark ? '#2d2d2d' : '#E5E7EB';
  const plotBg = isDark ? '#1a1a2e' : '#FFF7ED';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const labelBg = isDark ? '#1a1a2e' : '#FFF7ED';
  const ML = GANTT_LABEL_WIDTH;

  function handleRelayout(ev) {
    const r = parseRelayoutXRange(ev);
    if (r !== undefined) setVisibleRange(r);
  }

  return (
    <div>
      <div style={{ border: `1px solid ${borderClr}`, borderRadius: 8, overflow: 'hidden', marginTop: 8 }}>
        <div style={{ background: plotBg, borderBottom: `1px solid ${borderClr}` }}>
          <Plot
            data={[]}
            layout={{
              height: 40,
              margin: { l: ML, r: 16, t: 4, b: 26 },
              xaxis: ganttXAxisConfig(range, fontColor, gridColor, true),
              yaxis: { visible: false, fixedrange: true },
              paper_bgcolor: 'rgba(0,0,0,0)',
              plot_bgcolor: 'rgba(0,0,0,0)',
              showlegend: false,
            }}
            config={{ responsive: true, displayModeBar: false, staticPlot: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </div>
        <div style={{ display: 'flex' }}>
          <div style={{ width: ML, flexShrink: 0, background: labelBg, paddingTop: MARGIN_T, paddingBottom: MARGIN_B, boxSizing: 'border-box' }}>
            {rows.map(({ action }) => (
              <div
                key={action.name}
                title={action.name}
                style={{
                  height: ROW_PX, display: 'flex', alignItems: 'center', gap: 6,
                  paddingLeft: 12, paddingRight: 8, fontSize: 13, color: fontColor,
                  whiteSpace: 'nowrap', overflow: 'hidden',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{action.name}</span>
                {action.type === 'callin' ? (
                  <Tag color={TIER_INFO[action.tier]?.color || 'blue'} style={{ fontSize: 10, lineHeight: '16px', margin: 0, flexShrink: 0 }}>
                    вызов {fmtT(action.shiftStart)}–{fmtT(action.shiftEnd)}
                  </Tag>
                ) : (
                  // A repeatedly-extended person can end up stretched on
                  // both ends across separate tasks — show whichever
                  // side(s) actually moved instead of assuming just one.
                  <>
                    {action.shiftEnd > action.originalEnd && (
                      <Tag color={TIER_INFO[action.tier]?.color || 'purple'} style={{ fontSize: 10, lineHeight: '16px', margin: 0, flexShrink: 0 }}>
                        +{fmtHours(action.shiftEnd - action.originalEnd)}ч позже
                      </Tag>
                    )}
                    {action.shiftStart < action.originalStart && (
                      <Tag color={TIER_INFO[action.tier]?.color || 'purple'} style={{ fontSize: 10, lineHeight: '16px', margin: 0, flexShrink: 0 }}>
                        +{fmtHours(action.originalStart - action.shiftStart)}ч раньше
                      </Tag>
                    )}
                  </>
                )}
                {TIER_INFO[action.tier]?.label && (
                  <Tag color={TIER_INFO[action.tier].color} style={{ fontSize: 10, lineHeight: '16px', margin: 0, flexShrink: 0 }}>
                    {TIER_INFO[action.tier].label}
                  </Tag>
                )}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Plot
              data={traces}
              layout={{
                height: chartH,
                barmode: 'overlay',
                bargap: 0.2,
                showlegend: false,
                margin: { l: 0, r: 16, t: MARGIN_T, b: MARGIN_B },
                xaxis: { ...ganttXAxisConfig(range, fontColor, gridColor, false), showgrid: true, fixedrange: false },
                yaxis: {
                  categoryarray: [...names].reverse(),
                  categoryorder: 'array',
                  showticklabels: false,
                  automargin: false,
                  gridcolor: isDark ? '#2a2a3e' : '#F3F4F6',
                },
                dragmode: 'zoom',
                hoverlabel: { font: { size: 12 }, namelength: -1 },
                paper_bgcolor: 'rgba(0,0,0,0)',
                plot_bgcolor: plotBg,
                font: { color: fontColor },
              }}
              config={{ responsive: true, displayModeBar: false, scrollZoom: false }}
              onRelayout={handleRelayout}
              style={{ width: '100%' }}
              useResizeHandler
            />
          </div>
        </div>
      </div>
      {usedQuals.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
          {usedQuals.map(q => (
            <span key={q} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: fontColor }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: qualColor(q), display: 'inline-block' }} />
              {q}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StaffingGapPanel({
  tasks, staffDB, targetDate, windowDates, windowStart, windowDays,
  fullRoster, allShiftsByPerson, distanceResolver, isDark,
  resolution: providedResolution,
}) {
  const [granularity, setGranularity] = useState(60);

  const backlogTasks = useMemo(
    () => tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено'),
    [tasks, windowDates]
  );

  const gaps = useMemo(() => computeStaffingGaps({
    backlogTasks, windowStart, windowDays, granularityMin: granularity,
  }), [backlogTasks, windowStart, windowDays, granularity]);

  // Builds the actual proposal: extend an already-scheduled shift by up to
  // 2h where possible (cheaper than a fresh call-in), otherwise call in an
  // off-duty roster employee for a 6h window — re-running the optimizer
  // after each addition so the whole day/window gets reshuffled, not just
  // the literal backlog task that triggered the proposal. See
  // utils/staffingGap.js. A caller that already computed this itself (the
  // strategic-planning tab, so its headline charts can reuse the same
  // result instead of resolving twice) passes it in via `resolution` —
  // this only computes its own when that's absent.
  const computedResolution = useMemo(() => {
    if (providedResolution || !targetDate || !staffDB) return null;
    return resolveStaffingWithCallIns({
      tasksDB: tasks, staffDB, targetDate, windowDates, fullRoster, allShiftsByPerson, distanceResolver,
    });
  }, [providedResolution, tasks, staffDB, targetDate, windowDates, fullRoster, allShiftsByPerson, distanceResolver]);
  const resolution = providedResolution ?? computedResolution;

  if (backlogTasks.length === 0) {
    return <Empty description="Бэклог пуст — нехватки персонала нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const cardBg = isDark ? '#1a1a2e' : '#fafafa';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const fontColor = isDark ? '#d4d4d4' : '#444';

  const unresolved = resolution?.unresolved ?? [];
  const unresolvedByQual = {};
  for (const t of unresolved) {
    const key = t.reqType || '(без квалификации)';
    (unresolvedByQual[key] ??= []).push(t);
  }

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

      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: fontColor }}>Гранулярность:</span>
        <Segmented size="small" value={granularity} onChange={setGranularity} options={GRANULARITY_OPTIONS} />
      </div>

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
        </div>
      ))}

      {fullRoster.length > 0 && resolution && (
        <div style={{ marginTop: 20 }}>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            План вызова на подработку {resolution.actions.length > 0 && `(${resolution.actions.length} чел.)`}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            Сначала предлагаем продлить кому-то уже идущую смену (это дешевле, чем вызывать нового
            человека), и только если это невозможно — вызвать свободного человека. Правила по умолчанию:
            продление до 2 ч., у свежего вызова — минимум 12 ч. отдыха от других смен. Если так никого
            не находится, требования постепенно смягчаются (до 4 ч. продления/4 ч. отдыха, затем до 8 ч./
            без требования к отдыху — только без реального пересечения по времени) — так что кто-то
            предлагается почти всегда, а не только когда идеально подходит по умолчаниям; такие
            «сжатые» и «крайние» варианты помечены отдельным цветом — их стоит перепроверить вручную.
            После каждого добавления пересчитываем распределение по всем задачам дня — освободившиеся у
            других задачи тоже могут перейти вызванному, поэтому реально нужных людей может быть меньше,
            чем кажется по одному бэклогу.
          </Text>
          {resolution.actions.length > 0 ? (
            <CallInGantt
              actions={resolution.actions}
              finalTasks={resolution.tasks}
              windowStart={windowStart}
              windowDays={windowDays}
              isDark={isDark}
            />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>Подходящих кандидатов на вызов или продление смены не нашлось.</Text>
          )}

          {Object.keys(unresolvedByQual).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="warning" style={{ fontSize: 12 }}>
                Не удалось закрыть даже с учётом смягчённых правил вызова:
              </Text>
              <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                {Object.entries(unresolvedByQual).map(([qual, list]) => (
                  <li key={qual} style={{ fontSize: 13 }}>{qual}: {list.length} задач(и)</li>
                ))}
              </ul>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Это значит, что абсолютно ни у кого в загруженных данных — ни на смене, ни в полном
                ростере, даже без требований к отдыху — нет этой квалификации без реального пересечения
                по времени с чем-то ещё. Правило качества данных сюда не отменяется: если
                tb_relation_resource_qualification загружена не полностью, кандидат может существовать
                в реальности, просто его квалификация не попала в загруженный набор.
              </Text>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
