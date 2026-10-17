import { mutedColor } from '../utils/uiFormat';

// One compact line above a chart: "■ code (n)  ■ code (n) … ■ Прочие (n)".
// Replaces Plotly's own legend, which wrapped into several rows.
export default function QualLegend({ items, isDark, label = 'Допуск:' }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 12px', marginBottom: 6, fontSize: 12, color: isDark ? '#d4d4d4' : '#444' }}>
      <span style={{ color: mutedColor(isDark) }}>{label}</span>
      {items.map(it => (
        <span key={it.label} title={it.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: 'inline-block', border: `1px solid ${isDark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)'}` }} />
          {it.label}{it.count != null && <span style={{ color: mutedColor(isDark) }}> ({it.count})</span>}
        </span>
      ))}
    </div>
  );
}
