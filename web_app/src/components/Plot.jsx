// The single place that imports Plotly. Every chart imports this wrapper, and
// every chart is loaded lazily (App.jsx), so the multi-megabyte Plotly bundle
// is only fetched once there is something to draw. Also switches Plotly's own
// texts (toolbar, hints) to Russian.
import PlotlyPlot from 'react-plotly.js';
import Plotly from 'plotly.js/dist/plotly';
import ru from 'plotly.js/lib/locales/ru';

Plotly.register(ru);

export default function Plot({ config, ...props }) {
  return <PlotlyPlot {...props} config={{ locale: 'ru', ...config }} />;
}
