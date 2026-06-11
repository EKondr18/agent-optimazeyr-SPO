export default function MetricsSummary({ tasks, staffList, selectedDate }) {
  const dayTasks = tasks.filter(t => t.date === selectedDate);
  const assigned = dayTasks.filter(t => t.employee !== 'Не назначено').length;
  const backlog = dayTasks.length - assigned;
  const pct = dayTasks.length > 0 ? Math.round((assigned / dayTasks.length) * 100) : 0;

  const tiles = [
    { icon: '📋', label: 'Задач дня', value: dayTasks.length,
      bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-800' },
    { icon: '✅', label: 'Распределено', value: `${assigned} (${pct}%)`,
      bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700' },
    { icon: '⚠️', label: 'Бэклог',
      value: backlog,
      bg: backlog > 0 ? 'bg-red-50' : 'bg-green-50',
      border: backlog > 0 ? 'border-red-200' : 'border-green-200',
      text: backlog > 0 ? 'text-red-600' : 'text-green-600' },
    { icon: '👥', label: 'Доступно смены', value: staffList.length,
      bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {tiles.map(({ icon, label, value, bg, border, text }) => (
        <div key={label} className={`${bg} border ${border} rounded-xl p-4 text-center`}>
          <div className="text-lg mb-1">{icon}</div>
          <p className="text-xs text-gray-500 mb-1 font-medium">{label}</p>
          <p className={`text-2xl font-bold ${text}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}
