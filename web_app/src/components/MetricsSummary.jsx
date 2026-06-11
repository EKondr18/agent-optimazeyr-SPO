export default function MetricsSummary({ tasks, staffList, selectedDate }) {
  const dayTasks = tasks.filter(t => t.date === selectedDate);
  const assigned = dayTasks.filter(t => t.employee !== 'Не назначено').length;
  const backlog = dayTasks.length - assigned;

  const tiles = [
    { label: 'Задач дня', value: dayTasks.length, color: 'text-gray-800' },
    { label: 'Распределено', value: assigned, color: 'text-green-600' },
    { label: 'Бэклог', value: backlog, color: 'text-red-500' },
    { label: 'Доступно смены', value: staffList.length, color: 'text-blue-600' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      {tiles.map(({ label, value, color }) => (
        <div key={label} className="bg-white rounded-lg shadow-sm border border-gray-100 p-4 text-center">
          <p className="text-xs text-gray-400 mb-1">{label}</p>
          <p className={`text-3xl font-bold ${color}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}
