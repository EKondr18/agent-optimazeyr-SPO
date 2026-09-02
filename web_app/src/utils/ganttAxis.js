// Shared x-axis config for every Gantt-style Plotly chart in the app (main
// chart, backlog mini-chart). Both must use the exact same function — a
// divergent copy is what caused their time rulers to render at different
// tick positions even when showing the same window.
//
// Tick spacing/format now adapts to how much time is actually visible
// (range), not a fixed value tied to the original window — so zooming in
// shows finer ticks and zooming back out shows coarser ones, instead of
// the same fixed 2h/4h grid regardless of what's on screen.
export function ganttXAxisConfig(range, fontColor, gridColor, showLabels) {
  const spanHours = (range[1] - range[0]) / 3600000;
  let dtick, tickformat;
  if (spanHours <= 3) {
    dtick = 15 * 60000;
    tickformat = '%H:%M';
  } else if (spanHours <= 8) {
    dtick = 3600000;
    tickformat = '%H:%M';
  } else if (spanHours <= 30) {
    dtick = 2 * 3600000;
    // Break onto a second line with the date only once the visible range
    // actually crosses a day boundary — Plotly renders that second line
    // only where the coarser unit changes, so it reads as a day separator.
    tickformat = spanHours > 24 ? '%H:%M\n%d.%m' : '%H:%M';
  } else {
    dtick = 4 * 3600000;
    tickformat = '%H:%M\n%d.%m';
  }
  return {
    type: 'date',
    range,
    tickformat,
    dtick,
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

// Reads a Plotly relayout event for an x-axis zoom/pan change. Returns:
//   [startMs, endMs]  — the user zoomed/panned to this range
//   null              — the user reset to autorange (e.g. double-click, Home button)
//   undefined         — this event isn't an x-axis range change (ignore it)
export function parseRelayoutXRange(ev) {
  if (ev['xaxis.range[0]'] !== undefined && ev['xaxis.range[1]'] !== undefined) {
    return [new Date(ev['xaxis.range[0]']).getTime(), new Date(ev['xaxis.range[1]']).getTime()];
  }
  if (ev['xaxis.autorange']) return null;
  return undefined;
}
