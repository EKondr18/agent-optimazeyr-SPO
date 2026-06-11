import { useState, useMemo } from 'react';

function fmt(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function TaskDelayPanel({ tasks, selectedDate, onApplyDelays }) {
  const [delays, setDelays] = useState({});
  const [filter, setFilter] = useState('');

  const dayTasks = useMemo(
    () => tasks.filter(t => t.date === selectedDate),
    [tasks, selectedDate]
  );

  const filtered = useMemo(() => {
    if (!filter.trim()) return dayTasks;
    const q = filter.toLowerCase();
    return dayTasks.filter(
      t => t.name.toLowerCase().includes(q) || t.flight.toLowerCase().includes(q)
    );
  }, [dayTasks, filter]);

  const handleChange = (id, val) => {
    setDelays(prev => ({ ...prev, [id]: Math.max(0, Math.min(300, Number(val) || 0)) }));
  };

  return (
    <div>
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Фильтр по рейсу или задаче…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm"
        />
        <button
          onClick={() => onApplyDelays(delays)}
          className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
        >
          🔄 Применить задержки
        </button>
        <button
          onClick={() => setDelays({})}
          className="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
        >
          ⟳ Сбросить всё
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="sticky top-0 bg-gray-100 text-gray-600 text-left">
              <th className="px-3 py-2 border-b">Задача</th>
              <th className="px-3 py-2 border-b">Рейс</th>
              <th className="px-3 py-2 border-b">POS</th>
              <th className="px-3 py-2 border-b">Старт</th>
              <th className="px-3 py-2 border-b">Сдвиг (мин)</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t, i) => (
              <tr key={t.id} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                <td className="px-3 py-2 border-b text-gray-800">{t.name}</td>
                <td className="px-3 py-2 border-b text-gray-600">{t.flight}</td>
                <td className="px-3 py-2 border-b text-gray-600">{t.pos}</td>
                <td className="px-3 py-2 border-b text-gray-600">{fmt(t.baseStart)}</td>
                <td className="px-3 py-2 border-b">
                  <input
                    type="number"
                    min={0}
                    max={300}
                    step={5}
                    value={delays[t.id] ?? 0}
                    onChange={e => handleChange(t.id, e.target.value)}
                    className="w-20 border border-gray-300 rounded px-2 py-1 text-center"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
