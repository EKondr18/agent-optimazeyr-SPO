import { useMemo, useState } from 'react';
import { Typography, Empty, Alert, Segmented } from 'antd';
import Plot from 'react-plotly.js';
import { computeStaffingGaps, planCallIns } from '../utils/staffingGap';
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

// Mini Gantt for the call-in plan: one row per real named employee who'd be
// called in, bars = the backlog task(s) they'd cover, colored by required
// qualification — answers "фамилия и какую квалификацию он закроет и
// когда" directly, instead of a flat list of eligible names.
function CallInGantt({ callIns, windowStart, windowDays, isDark }) {
  const [visibleRange, setVisibleRange] = useState(null);
  const dateObj = new Date(windowStart + 'T00:00:00');
  const nextDay = new Date(dateObj.getTime() + windowDays * 24 * 3600000);
  const range = visibleRange || [dateObj.getTime(), nextDay.getTime()];

  const names = callIns.map(c => c.person.name);

  const traces = useMemo(() => callIns.map(c => ({
    type: 'bar',
    orientation: 'h',
    name: c.person.name,
    x: c.tasks.map(t => t.end - t.start),
    base: c.tasks.map(t => t.start.getTime()),
    y: c.tasks.map(() => c.person.name),
    marker: { color: c.tasks.map(t => qualColor(t.reqType || '?')), opacity: 0.9 },
    customdata: c.tasks.map(t => ({
      qual: t.reqType,
      flight: t.flight,
      pos: t.pos,
      start: fmtT(t.start),
      end: fmtT(t.end),
    })),
    hovertemplate:
      `<b>${c.person.name}</b><br>` +
      'Квалификация: %{customdata.qual}<br>' +
      'Рейс: %{customdata.flight}  |  POS: %{customdata.pos}<br>' +
      'Время: %{customdata.start} – %{customdata.end}' +
      '<extra></extra>',
    showlegend: false,
  })), [callIns]);

  const ROW_PX = 28;
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
          {names.map(name => (
            <div
              key={name}
              title={name}
              style={{
                height: ROW_PX, display: 'flex', alignItems: 'center',
                paddingLeft: 12, paddingRight: 8, fontSize: 12, color: fontColor,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              {name}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Plot
            data={traces}
            layout={{
              height: chartH,
              barmode: 'overlay',
              bargap: 0.25,
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
  );
}

export default function StaffingGapPanel({
  tasks, windowDates, windowStart, windowDays, fullRoster, scheduledNames, allShiftsByPerson, isDark,
}) {
  const [granularity, setGranularity] = useState(60);

  const backlogTasks = useMemo(
    () => tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено'),
    [tasks, windowDates]
  );

  const gaps = useMemo(() => computeStaffingGaps({
    backlogTasks, windowStart, windowDays, granularityMin: granularity,
  }), [backlogTasks, windowStart, windowDays, granularity]);

  const { callIns, unresolved } = useMemo(() => planCallIns(
    backlogTasks, fullRoster, allShiftsByPerson, scheduledNames
  ), [backlogTasks, fullRoster, allShiftsByPerson, scheduledNames]);

  if (backlogTasks.length === 0) {
    return <Empty description="Бэклог пуст — нехватки персонала нет" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  const cardBg = isDark ? '#1a1a2e' : '#fafafa';
  const borderClr = isDark ? '#2d2d2d' : '#f0f0f0';
  const fontColor = isDark ? '#d4d4d4' : '#444';

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

      {fullRoster.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Text strong style={{ display: 'block', marginBottom: 4 }}>
            План вызова на подработку {callIns.length > 0 && `(${callIns.length} чел.)`}
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
            Не в смене и без смены за 12 ч. до/после — вызываются по минимуму: сначала догружаем уже
            вызванного (до 6 ч. занятости), и только потом зовём следующего.
          </Text>
          {callIns.length > 0 ? (
            <CallInGantt callIns={callIns} windowStart={windowStart} windowDays={windowDays} isDark={isDark} />
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>Подходящих кандидатов на вызов не нашлось.</Text>
          )}

          {Object.keys(unresolvedByQual).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text type="warning" style={{ fontSize: 12 }}>
                Не удалось закрыть даже вызовом на подработку:
              </Text>
              <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                {Object.entries(unresolvedByQual).map(([qual, list]) => (
                  <li key={qual} style={{ fontSize: 13 }}>{qual}: {list.length} задач(и)</li>
                ))}
              </ul>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Для квалификаций по типу ВС это не всегда означает, что реально некого позвать — такие
                допуски фиксируются в системе только на уровне конкретной смены, поэтому для несменных
                сотрудников их не видно.
              </Text>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
