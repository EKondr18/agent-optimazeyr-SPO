// Shared x-axis config for every Gantt-style Plotly chart in the app (main
// chart, backlog mini-chart). Both must use the exact same function — a
// divergent copy is what caused their time rulers to render at different
// tick positions even when showing the same window.
export function ganttXAxisConfig(dateObj, nextDay, fontColor, gridColor, showLabels, windowDays) {
  return {
    type: 'date',
    range: [dateObj.getTime(), nextDay.getTime()],
    // With more than one day on screen, break the tick label onto a second
    // line showing the date — Plotly only renders that second line where
    // the coarser unit (the day) actually changes, so it reads as a day
    // separator rather than clutter on every tick.
    tickformat: windowDays > 1 ? '%H:%M\n%d.%m' : '%H:%M',
    dtick: 3600000 * (windowDays > 1 ? 4 : 2),
    gridcolor: gridColor,
    tickfont: { color: fontColor, size: 13 },
    showticklabels: showLabels,
    showgrid: showLabels ? false : true,   // gridlines only in main chart
    zeroline: false,
    fixedrange: true,
  };
}

// Left label-column width shared by every Gantt chart so their time axes
// line up on screen when shown one above the other.
export const GANTT_LABEL_WIDTH = 220;
