// Deterministic hex color per qualification code, shared by every chart
// that groups by qualification (HourlyLoadChart, the call-in Gantt) so the
// same code always renders in the same color across the app.
const QUAL_COLOR_PALETTE = [
  '#1F77B4', '#FF7F0E', '#2CA02C', '#D62728', '#9467BD',
  '#8C564B', '#E377C2', '#7F7F7F', '#BCBD22', '#17BECF',
  '#AEC7E8', '#FFBB78', '#98DF8A', '#FF9896', '#C5B0D5',
];

export function qualColor(qual) {
  let hash = 0;
  for (let i = 0; i < qual.length; i++) hash = (hash * 31 + qual.charCodeAt(i)) | 0;
  return QUAL_COLOR_PALETTE[Math.abs(hash) % QUAL_COLOR_PALETTE.length];
}
