import { useState, useMemo, useRef, useEffect } from 'react';
import {
  ConfigProvider, Layout, Button, Select, Switch, Input,
  Checkbox, Space, Drawer, Collapse, Typography, Alert,
  Spin, Empty, theme as antdTheme, Badge, Divider, message, Modal,
} from 'antd';
import {
  UploadOutlined, ThunderboltOutlined, ClearOutlined,
  MenuOutlined, BulbOutlined, BulbFilled, BarChartOutlined,
  UnorderedListOutlined, ClockCircleOutlined, RiseOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { parseCSV, parseJsonExport, parseCsvCollections } from './utils/dataParser';
import { createDistanceResolver } from './utils/travelGraph';
import { runOptimizer, reassignDelayedConflicts, findConflicts, hasAllQuals } from './optimizer';
import MetricsSummary from './components/MetricsSummary';
import GanttChart from './components/GanttChart';
import BacklogPanel from './components/BacklogPanel';
import TaskDelayPanel from './components/TaskDelayPanel';
import HourlyLoadChart from './components/HourlyLoadChart';
import StaffingGapPanel from './components/StaffingGapPanel';

const { Sider, Content, Header } = Layout;
const { darkAlgorithm, defaultAlgorithm } = antdTheme;
const { Text } = Typography;

const GANTT_WINDOW_DAYS = 3;

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function shiftYMD(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Slot key -> the parseJsonExport argument name it feeds, and the label shown
// next to its own upload input. csvArg is the matching parseCsvCollections
// argument name for the CSV upload flow.
const JSON_FILE_SLOTS = [
  { key: 'orders', label: 'tb_sub_orders', csvArg: 'ordersCsv' },
  { key: 'shifts', label: 'tb_shifts', csvArg: 'shiftsCsv' },
  { key: 'resources', label: 'tb_resources', csvArg: 'resourcesCsv' },
  { key: 'resQual', label: 'tb_res_qual', csvArg: 'resQualCsv' },
  { key: 'resourceQualifications', label: 'tb_relation_resource_qualification', csvArg: 'resourceQualificationsCsv' },
  { key: 'shiftQualifications', label: 'tb_relation_shift_qualification', csvArg: 'shiftQualificationsCsv' },
];

// A single drag-and-drop upload target: click or drop a .csv/.txt file,
// reporting the raw text back to the caller. Keeps its own drag-hover state
// locally so drag events don't need to be plumbed through the parent.
function FileDropzone({ label, isDark, status, onFile }) {
  const [isOver, setIsOver] = useState(false);
  const inputRef = useRef();

  function readFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => onFile(file.name, ev.target.result);
    reader.onerror = () => onFile(file.name, null, 'не удалось прочитать файл');
    reader.readAsText(file, 'UTF-8');
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: isDark ? '#888' : '#999', marginBottom: 2 }}>{label}</div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setIsOver(true); }}
        onDragLeave={() => setIsOver(false)}
        onDrop={e => {
          e.preventDefault();
          setIsOver(false);
          readFile(e.dataTransfer.files[0]);
        }}
        style={{
          border: `1px dashed ${isOver ? '#1677ff' : (isDark ? '#444' : '#ccc')}`,
          borderRadius: 6,
          padding: '6px 8px',
          textAlign: 'center',
          fontSize: 11,
          cursor: 'pointer',
          background: isOver ? (isDark ? '#112' : '#f0f7ff') : 'transparent',
          color: isDark ? '#888' : '#999',
        }}
      >
        {status?.error ? (
          <span style={{ color: '#ff4d4f' }}>Ошибка: {status.error}</span>
        ) : status?.filename ? (
          <span style={{ color: '#52c41a' }}>✓ {status.filename} ({status.rowCount})</span>
        ) : (
          'перетащите файл или нажмите'
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,.json"
        onChange={e => { readFile(e.target.files[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
    </div>
  );
}

// Same drag-and-drop UX as FileDropzone, but for the two auxiliary
// location/travel-graph files: these can arrive as .csv, .json, or .xlsx
// (the real VKO_TRANSPORT export is xlsx), so this always resolves to a
// parsed array of row objects via onRows, regardless of source format.
function AuxDataDropzone({ label, isDark, status, onRows }) {
  const [isOver, setIsOver] = useState(false);
  const inputRef = useRef();

  function readFile(file) {
    if (!file) return;
    const isXlsx = /\.xlsx?$/i.test(file.name);
    const reader = new FileReader();
    reader.onerror = () => onRows(file.name, null, 'не удалось прочитать файл');
    if (isXlsx) {
      reader.onload = ev => {
        try {
          const wb = XLSX.read(ev.target.result, { type: 'array' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
          onRows(file.name, rows, null);
        } catch (err) {
          onRows(file.name, null, err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = ev => {
        try {
          const text = ev.target.result.trim();
          const rows = text.startsWith('[') || text.startsWith('{')
            ? JSON.parse(text)
            : (() => {
                const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
                if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
                return parsed.data;
              })();
          onRows(file.name, rows, null);
        } catch (err) {
          onRows(file.name, null, err.message);
        }
      };
      reader.readAsText(file, 'UTF-8');
    }
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: isDark ? '#888' : '#999', marginBottom: 2 }}>{label}</div>
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setIsOver(true); }}
        onDragLeave={() => setIsOver(false)}
        onDrop={e => {
          e.preventDefault();
          setIsOver(false);
          readFile(e.dataTransfer.files[0]);
        }}
        style={{
          border: `1px dashed ${isOver ? '#1677ff' : (isDark ? '#444' : '#ccc')}`,
          borderRadius: 6,
          padding: '6px 8px',
          textAlign: 'center',
          fontSize: 11,
          cursor: 'pointer',
          background: isOver ? (isDark ? '#112' : '#f0f7ff') : 'transparent',
          color: isDark ? '#888' : '#999',
        }}
      >
        {status?.error ? (
          <span style={{ color: '#ff4d4f' }}>Ошибка: {status.error}</span>
        ) : status?.filename ? (
          <span style={{ color: '#52c41a' }}>✓ {status.filename} ({status.rows.length})</span>
        ) : (
          'перетащите файл (csv/json/xlsx) или нажмите'
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.txt,.json,.xlsx,.xls"
        onChange={e => { readFile(e.target.files[0]); e.target.value = ''; }}
        style={{ display: 'none' }}
      />
    </div>
  );
}

function SidebarContent({
  isDark, hasData, fileRef, handleFileUpload, handleDemoLoad, handleDemoLoadJson,
  manualFiles, handleManualFileChange, handleManualJsonLoad, handleManualJsonClear, manualAllReady,
  csvFiles, handleCsvFileSelect, handleCsvLoad, handleCsvClear, csvAllReady,
  locationsFile, handleLocationsRows, travelGraphFile, handleTravelGraphRows,
  availableDates, selectedDate, setSelectedDate, setOptimizerRan,
  handleRunOptimizer, handleResetBacklog,
  filterTypes, allTaskTypes, colorMap, toggleType, setFilterTypes,
  onClose,
}) {
  return (
    <div style={{ padding: '0 12px 16px', height: '100%', overflowY: 'auto' }}>
      {/* Logo */}
      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${isDark ? '#2d2d2d' : '#f0f0f0'}`, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🛫</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3 }}>Пульт КК — Внуково</div>
            <div style={{ fontSize: 11, color: isDark ? '#888' : '#999' }}>SPO оптимизатор SV+GH</div>
          </div>
        </div>
      </div>

      {/* Data loading */}
      <div style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: isDark ? '#666' : '#aaa', display: 'block', marginBottom: 8 }}>Данные</Text>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={e => { handleFileUpload(e); onClose?.(); }} style={{ display: 'none' }} />
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button icon={<UploadOutlined />} block onClick={() => fileRef.current?.click()}>
            Загрузить CSV
          </Button>
          <Button block onClick={() => { handleDemoLoad(); onClose?.(); }}>
            🎬 Демо-данные (CSV)
          </Button>
          <Button block onClick={() => { handleDemoLoadJson(); onClose?.(); }}>
            🗂️ Демо-данные (полный набор)
          </Button>
        </Space>

        <Collapse
          ghost
          size="small"
          style={{ marginTop: 8 }}
          items={[{
            key: 'manual-json',
            label: <span style={{ fontSize: 12 }}>📦 Загрузить JSON вручную (6 файлов)</span>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {JSON_FILE_SLOTS.map(({ key, label }) => {
                  const slot = manualFiles[key];
                  return (
                    <div key={key}>
                      <div style={{ fontSize: 11, color: isDark ? '#888' : '#999', marginBottom: 2 }}>{label}</div>
                      <input
                        type="file"
                        accept=".json,.txt"
                        onChange={e => handleManualFileChange(key, e)}
                        style={{ fontSize: 11, width: '100%' }}
                      />
                      {slot?.error && (
                        <div style={{ fontSize: 11, color: '#ff4d4f' }}>Ошибка: {slot.error}</div>
                      )}
                      {slot?.data && !slot.error && (
                        <div style={{ fontSize: 11, color: '#52c41a' }}>✓ {slot.filename} ({slot.data.length})</div>
                      )}
                    </div>
                  );
                })}
                <Space style={{ width: '100%' }}>
                  <Button
                    size="small"
                    type="primary"
                    disabled={!manualAllReady}
                    onClick={() => { handleManualJsonLoad(); onClose?.(); }}
                  >
                    Загрузить
                  </Button>
                  <Button size="small" onClick={handleManualJsonClear}>
                    Очистить
                  </Button>
                </Space>
              </Space>
            ),
          }, {
            key: 'manual-csv',
            label: <span style={{ fontSize: 12 }}>📄 Загрузить CSV вручную (6 файлов)</span>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                {JSON_FILE_SLOTS.map(({ key, label }) => (
                  <FileDropzone
                    key={key}
                    label={label}
                    isDark={isDark}
                    status={csvFiles[key]}
                    onFile={(filename, text, readError) => handleCsvFileSelect(key, filename, text, readError)}
                  />
                ))}
                <Space style={{ width: '100%' }}>
                  <Button
                    size="small"
                    type="primary"
                    disabled={!csvAllReady}
                    onClick={() => { handleCsvLoad(); onClose?.(); }}
                  >
                    Загрузить
                  </Button>
                  <Button size="small" onClick={handleCsvClear}>
                    Очистить
                  </Button>
                </Space>
              </Space>
            ),
          }, {
            key: 'locations',
            label: <span style={{ fontSize: 12 }}>🗺️ Локации и сеть перемещений (опционально)</span>,
            children: (
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <AuxDataDropzone
                  label="tb_location (csv/json)"
                  isDark={isDark}
                  status={locationsFile}
                  onRows={handleLocationsRows}
                />
                <AuxDataDropzone
                  label="VKO_TRANSPORT (xlsx/csv) — граф перемещений"
                  isDark={isDark}
                  status={travelGraphFile}
                  onRows={handleTravelGraphRows}
                />
                <Text style={{ fontSize: 11, color: isDark ? '#666' : '#999' }}>
                  Улучшает расчёт расстояний/времени перехода между стоянками в оптимизаторе. Без этих файлов используется упрощённая эвристика по коду стоянки.
                </Text>
              </Space>
            ),
          }]}
        />
      </div>

      {hasData && (
        <>
          <Divider style={{ margin: '8px 0' }} />

          {/* Date selector */}
          <div style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: isDark ? '#666' : '#aaa', display: 'block', marginBottom: 8 }}>Дата смены</Text>
            <Select
              value={selectedDate}
              onChange={val => { setSelectedDate(val); setOptimizerRan(false); }}
              style={{ width: '100%' }}
              options={availableDates.map(d => ({ value: d, label: d }))}
            />
          </div>

          {/* Optimizer */}
          <div style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: isDark ? '#666' : '#aaa', display: 'block', marginBottom: 8 }}>Оптимизация</Text>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                block
                onClick={() => { handleRunOptimizer(); onClose?.(); }}
              >
                Запустить оптимизатор
              </Button>
              <Button
                icon={<ClearOutlined />}
                block
                onClick={() => { handleResetBacklog(); onClose?.(); }}
              >
                Сбросить в бэклог
              </Button>
            </Space>
          </div>

          <Divider style={{ margin: '8px 0' }} />

          {/* Task type filter */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: isDark ? '#666' : '#aaa' }}>Типы задач</Text>
              <Button
                type="link"
                size="small"
                style={{ padding: 0, fontSize: 11 }}
                onClick={() => setFilterTypes(
                  filterTypes.length === allTaskTypes.length ? [] : [...allTaskTypes]
                )}
              >
                {filterTypes.length === allTaskTypes.length ? 'Снять все' : 'Выбрать все'}
              </Button>
            </div>
            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {allTaskTypes.map(name => (
                <Checkbox
                  key={name}
                  checked={filterTypes.includes(name)}
                  onChange={() => toggleType(name)}
                  style={{ marginInlineStart: 0 }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: '50%', background: colorMap[name] || '#888', display: 'inline-block', flexShrink: 0 }} />
                    <span style={{ fontSize: 12 }} title={name}>{name}</span>
                  </span>
                </Checkbox>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function App() {
  const [tasksDB, setTasksDB] = useState([]);
  const [staffDB, setStaffDB] = useState({});
  const [colorMap, setColorMap] = useState({});
  const [fullRoster, setFullRoster] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [optimizerRan, setOptimizerRan] = useState(false);
  const [filterTypes, setFilterTypes] = useState([]);
  const [filterFlight, setFilterFlight] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isDark, setIsDark] = useState(false);
  const [mobileBroken, setMobileBroken] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [manualFiles, setManualFiles] = useState({});
  const [csvFiles, setCsvFiles] = useState({});
  const [locationsFile, setLocationsFile] = useState(null);
  const [travelGraphFile, setTravelGraphFile] = useState(null);
  const [conflictInfo, setConflictInfo] = useState(null);
  const [draggingTask, setDraggingTask] = useState(null);
  const fileRef = useRef();

  const manualAllReady = JSON_FILE_SLOTS.every(s => manualFiles[s.key]?.data && !manualFiles[s.key]?.error);
  const csvAllReady = JSON_FILE_SLOTS.every(s => csvFiles[s.key]?.text && !csvFiles[s.key]?.error);

  // Real physical-distance resolver for the optimizer's travel-time logic —
  // active as soon as either auxiliary file is loaded (each dataset alone is
  // still useful: locations without the graph gives same-stand detection,
  // the graph without locations resolves nothing but is harmless). Falls
  // back to the plain string heuristic everywhere when neither is loaded.
  const distanceResolver = useMemo(() => {
    if (!locationsFile?.rows && !travelGraphFile?.rows) return null;
    return createDistanceResolver({
      locations: locationsFile?.rows || [],
      travelEdges: travelGraphFile?.rows || [],
    });
  }, [locationsFile, travelGraphFile]);

  useEffect(() => {
    document.body.style.background = isDark ? '#0d0d0d' : '#f5f5f5';
    document.body.style.margin = '0';
  }, [isDark]);

  const availableDates = useMemo(
    () => [...new Set(tasksDB.map(t => t.date))].sort(),
    [tasksDB]
  );
  const currentTasks = useMemo(
    () => tasksDB.filter(t => t.date === selectedDate),
    [tasksDB, selectedDate]
  );
  const currentStaff = useMemo(
    () => staffDB[selectedDate] ?? [],
    [staffDB, selectedDate]
  );

  // The Gantt view alone looks a few days ahead of selectedDate — shifts and
  // tasks routinely cross midnight, so a strict single-day window used to
  // cut them off mid-bar. Optimizer/backlog logic stays anchored to the
  // single selectedDate; only the chart's own data feed is widened.
  const windowDates = useMemo(() => {
    if (!selectedDate) return [];
    // Centered on selectedDate: one day back, the date itself, one day forward.
    return Array.from({ length: GANTT_WINDOW_DAYS }, (_, i) => shiftYMD(selectedDate, i - 1));
  }, [selectedDate]);
  const ganttTasks = useMemo(
    () => tasksDB.filter(t => windowDates.includes(t.date)),
    [tasksDB, windowDates]
  );
  const ganttStaff = useMemo(() => {
    const seen = new Map();
    for (const d of windowDates) {
      for (const s of (staffDB[d] || [])) {
        const key = `${s.name}__${s.shiftStart.getTime()}`;
        if (!seen.has(key)) seen.set(key, s);
      }
    }
    return [...seen.values()];
  }, [staffDB, windowDates]);
  const allTaskTypes = useMemo(
    () => [...new Set(tasksDB.map(t => t.name))].sort(),
    [tasksDB]
  );
  const backlogCount = ganttTasks.filter(t => t.employee === 'Не назначено').length;
  // Anyone with a shift anywhere in the window counts as "already
  // scheduled" for staffing-gap purposes — a call-in candidate must be off
  // in the whole 3-day window, not just the exact selected date.
  const scheduledNames = useMemo(
    () => new Set(ganttStaff.map(s => s.name)),
    [ganttStaff]
  );
  const backlogTasksAll = useMemo(
    () => tasksDB.filter(t => t.employee === 'Не назначено'),
    [tasksDB]
  );

  function applyParsedData({ tasks, staffDB: db, colorMap: cm, fullRoster: roster }) {
    const dates = [...new Set(tasks.map(t => t.date))].sort();
    const types = [...new Set(tasks.map(t => t.name))];
    setTasksDB(tasks);
    setStaffDB(db);
    setColorMap(cm);
    setFullRoster(roster || []);
    setSelectedDate(dates[0]);
    setFilterTypes(types);
    setFilterFlight('');
    setOptimizerRan(false);
  }

  function loadData(text) {
    setIsLoading(true);
    setError(null);
    try {
      const parsed = parseCSV(text);
      if (parsed.tasks.length === 0) throw new Error('CSV не содержит корректных данных');
      applyParsedData(parsed);
    } catch (e) {
      setError(`Ошибка загрузки: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadData(ev.target.result);
    reader.onerror = () => setError('Не удалось прочитать файл');
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  }

  function handleDemoLoad() {
    setIsLoading(true);
    fetch('./sample_data.csv')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
      .then(loadData)
      .catch(e => { setError(`Демо-данные недоступны: ${e.message}`); setIsLoading(false); });
  }

  function handleDemoLoadJson() {
    setIsLoading(true);
    setError(null);
    const files = [
      'tb_sub_orders', 'tb_shifts', 'tb_resources',
      'tb_res_qual', 'tb_relation_resource_qualification', 'tb_relation_shift_qualification',
    ];
    Promise.all(files.map(name =>
      fetch(`./demo/${name}.json`).then(r => {
        if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
        return r.json();
      })
    ))
      .then(([orders, shifts, resources, resQual, resourceQualifications, shiftQualifications]) => {
        const parsed = parseJsonExport({ orders, shifts, resources, resQual, resourceQualifications, shiftQualifications });
        if (parsed.tasks.length === 0) throw new Error('Демо-данные не содержат задач');
        applyParsedData(parsed);
      })
      .catch(e => setError(`Демо-данные недоступны: ${e.message}`))
      .finally(() => setIsLoading(false));
  }

  function handleManualFileChange(key, e) {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-selecting the same file after a fix
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!Array.isArray(data)) throw new Error('ожидался JSON-массив');
        setManualFiles(prev => ({ ...prev, [key]: { filename: file.name, data, error: null } }));
      } catch (err) {
        setManualFiles(prev => ({ ...prev, [key]: { filename: file.name, data: null, error: err.message } }));
      }
    };
    reader.onerror = () => setManualFiles(prev => ({ ...prev, [key]: { filename: file.name, data: null, error: 'не удалось прочитать файл' } }));
    reader.readAsText(file, 'UTF-8');
  }

  function handleManualJsonLoad() {
    setIsLoading(true);
    setError(null);
    try {
      const args = {};
      for (const { key } of JSON_FILE_SLOTS) args[key] = manualFiles[key]?.data;
      const parsed = parseJsonExport(args);
      if (parsed.tasks.length === 0) throw new Error('Загруженные файлы не содержат задач');
      applyParsedData(parsed);
    } catch (e) {
      setError(`Ошибка загрузки: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleManualJsonClear() {
    setManualFiles({});
  }

  function handleCsvFileSelect(key, filename, text, readError) {
    if (readError) {
      setCsvFiles(prev => ({ ...prev, [key]: { filename, text: null, rowCount: 0, error: readError } }));
      return;
    }
    try {
      const rows = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
      if (rows.errors.length > 0) throw new Error(rows.errors[0].message);
      setCsvFiles(prev => ({ ...prev, [key]: { filename, text, rowCount: rows.data.length, error: null } }));
    } catch (err) {
      setCsvFiles(prev => ({ ...prev, [key]: { filename, text: null, rowCount: 0, error: err.message } }));
    }
  }

  function handleCsvLoad() {
    setIsLoading(true);
    setError(null);
    try {
      const args = {};
      for (const { key, csvArg } of JSON_FILE_SLOTS) args[csvArg] = csvFiles[key]?.text;
      const parsed = parseCsvCollections(args);
      if (parsed.tasks.length === 0) throw new Error('Загруженные файлы не содержат задач');
      applyParsedData(parsed);
    } catch (e) {
      setError(`Ошибка загрузки: ${e.message}`);
    } finally {
      setIsLoading(false);
    }
  }

  function handleCsvClear() {
    setCsvFiles({});
  }

  function handleLocationsRows(filename, rows, error) {
    setLocationsFile(error ? { filename, rows: null, error } : { filename, rows, error: null });
  }

  function handleTravelGraphRows(filename, rows, error) {
    setTravelGraphFile(error ? { filename, rows: null, error } : { filename, rows, error: null });
  }

  function handleRunOptimizer() {
    const updated = runOptimizer(tasksDB, staffDB, selectedDate, distanceResolver, windowDates);
    setTasksDB(updated);
    setOptimizerRan(true);
  }

  function handleResetBacklog() {
    setTasksDB(prev =>
      prev.map(t =>
        t.date === selectedDate
          ? { ...t, employee: 'Не назначено', isLocked: false }
          : t
      )
    );
    setOptimizerRan(false);
  }

  function handleApplyDelays(delayMap) {
    const delayedIds = Object.keys(delayMap).filter(id => (delayMap[id] ?? 0) > 0);
    let updated = tasksDB.map(t => {
      const minutes = delayMap[t.id] ?? 0;
      return {
        ...t,
        start: new Date(t.baseStart.getTime() + minutes * 60000),
        end: new Date(t.baseEnd.getTime() + minutes * 60000),
      };
    });

    const { tasks: resolved, changes } = reassignDelayedConflicts(updated, staffDB, selectedDate, delayedIds, distanceResolver, windowDates);
    updated = resolved;
    for (const c of changes) {
      if (c.backlog) {
        message.warning(`«${c.taskName}» (${c.from}): из-за задержки конфликтует с другой закреплённой задачей — свободных сотрудников нет, задача возвращена в бэклог`);
      } else {
        message.info(`«${c.taskName}»: из-за задержки переназначена с ${c.from} на ${c.to} (конфликт с закреплённой задачей)`);
      }
    }

    if (optimizerRan) updated = runOptimizer(updated, staffDB, selectedDate, distanceResolver, windowDates);
    setTasksDB(updated);
  }

  function handleAssign(taskId, employeeName, lock) {
    setTasksDB(prev =>
      prev.map(t => t.id === taskId ? { ...t, employee: employeeName, isLocked: lock } : t)
    );
  }

  // Shared "try to assign, warn on conflict" entry point for every manual
  // assignment path (backlog select+button, Gantt drag-and-drop) — one copy
  // of the conflict check instead of each path keeping its own, which has
  // already caused a real double-booking bug once when they drifted apart.
  function attemptAssign(task, employeeName, staffPool) {
    const conflicts = findConflicts(employeeName, task, tasksDB, distanceResolver);
    if (conflicts.length === 0) {
      handleAssign(task.id, employeeName, true);
      return;
    }
    const alternatives = staffPool.filter(s =>
      s.name !== employeeName &&
      hasAllQuals(s.quals, task) &&
      s.shiftStart <= task.start &&
      task.end <= s.shiftEnd &&
      findConflicts(s.name, task, tasksDB, distanceResolver).length === 0
    );
    setConflictInfo({ task, sel: employeeName, conflicts, alternatives });
  }

  // Drop target for dragging a backlog task onto an employee's row in the
  // main Gantt chart — resolves the dragged task id back to the task object
  // and routes through the same conflict-checking path as manual assignment.
  function handleDropAssign(taskId, employeeName) {
    const task = tasksDB.find(t => t.id === taskId);
    if (!task) return;
    attemptAssign(task, employeeName, ganttStaff);
  }

  // Inline time edit from clicking a bar on the main Gantt chart.
  function handleEditTaskTime(taskId, newStart, newEnd) {
    setTasksDB(prev =>
      prev.map(t => t.id === taskId ? { ...t, start: newStart, end: newEnd } : t)
    );
  }

  function toggleType(name) {
    setFilterTypes(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const hasData = tasksDB.length > 0;

  const sidebarProps = {
    isDark, hasData, fileRef, handleFileUpload, handleDemoLoad, handleDemoLoadJson,
    manualFiles, handleManualFileChange, handleManualJsonLoad, handleManualJsonClear, manualAllReady,
    csvFiles, handleCsvFileSelect, handleCsvLoad, handleCsvClear, csvAllReady,
    locationsFile, handleLocationsRows, travelGraphFile, handleTravelGraphRows,
    availableDates, selectedDate, setSelectedDate, setOptimizerRan,
    handleRunOptimizer, handleResetBacklog,
    filterTypes, allTaskTypes, colorMap, toggleType, setFilterTypes,
  };

  const headerBg = isDark ? '#001529' : '#1677ff';
  const contentBg = isDark ? '#0d0d0d' : '#f5f5f5';

  const collapseItems = hasData && !isLoading ? [
    {
      key: 'gantt',
      label: (
        <span style={{ fontWeight: 600 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />
          Оперативный план-график ({ganttTasks.length} задач, ±1 сутки от даты)
        </span>
      ),
      children: (
        <div>
          <Input
            placeholder="Фильтр по рейсу…"
            value={filterFlight}
            onChange={e => setFilterFlight(e.target.value)}
            allowClear
            style={{ width: 220, marginBottom: 12 }}
          />
          <GanttChart
            tasks={ganttTasks}
            staffShifts={ganttStaff}
            windowDays={GANTT_WINDOW_DAYS}
            windowStart={windowDates[0]}
            colorMap={colorMap}
            selectedDate={selectedDate}
            filterTypes={filterTypes}
            filterFlight={filterFlight}
            isDark={isDark}
            draggingTask={draggingTask}
            onDropAssign={handleDropAssign}
            onEditTaskTime={handleEditTaskTime}
            onUnassignTask={taskId => handleAssign(taskId, 'Не назначено', false)}
          />
        </div>
      ),
    },
    {
      key: 'backlog',
      label: (
        <span style={{ fontWeight: 600 }}>
          <UnorderedListOutlined style={{ marginRight: 8 }} />
          Нераспределённые задачи
          {backlogCount > 0 && <Badge count={backlogCount} style={{ marginLeft: 8 }} />}
        </span>
      ),
      children: (
        <BacklogPanel
          tasks={tasksDB}
          staffList={ganttStaff}
          windowDates={windowDates}
          windowStart={windowDates[0]}
          windowDays={GANTT_WINDOW_DAYS}
          colorMap={colorMap}
          onAssign={handleAssign}
          isDark={isDark}
          distanceResolver={distanceResolver}
          onAssignAttempt={attemptAssign}
          onDragTaskChange={setDraggingTask}
        />
      ),
    },
    {
      key: 'delays',
      label: (
        <span style={{ fontWeight: 600 }}>
          <ClockCircleOutlined style={{ marginRight: 8 }} />
          Модуль задержки задач
        </span>
      ),
      children: (
        <TaskDelayPanel
          tasks={tasksDB}
          selectedDate={selectedDate}
          onApplyDelays={handleApplyDelays}
        />
      ),
    },
    {
      key: 'load',
      label: (
        <span style={{ fontWeight: 600 }}>
          <RiseOutlined style={{ marginRight: 8 }} />
          График нагрузки и потребности штата
        </span>
      ),
      children: (
        <div>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Все задачи</Text>
          <HourlyLoadChart
            tasks={tasksDB}
            selectedDate={selectedDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
          />
          <Divider style={{ margin: '20px 0' }} />
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Нераспределённые задачи (бэклог)</Text>
          <HourlyLoadChart
            tasks={backlogTasksAll}
            selectedDate={selectedDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
          />
        </div>
      ),
    },
    {
      key: 'staffing-gap',
      label: (
        <span style={{ fontWeight: 600 }}>
          <TeamOutlined style={{ marginRight: 8 }} />
          Нехватка персонала
          {backlogCount > 0 && <Badge count={backlogCount} style={{ marginLeft: 8 }} />}
        </span>
      ),
      children: (
        <StaffingGapPanel
          tasks={tasksDB}
          windowDates={windowDates}
          windowStart={windowDates[0]}
          windowDays={GANTT_WINDOW_DAYS}
          fullRoster={fullRoster}
          scheduledNames={scheduledNames}
          isDark={isDark}
        />
      ),
    },
  ] : [];

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? darkAlgorithm : defaultAlgorithm,
        token: { colorPrimary: '#1677ff', borderRadius: 8 },
      }}
    >
      <Layout style={{ height: '100vh', background: contentBg }}>
        {/* Desktop Sidebar */}
        <Sider
          width={260}
          breakpoint="md"
          collapsedWidth={0}
          onBreakpoint={broken => setMobileBroken(broken)}
          trigger={null}
          style={{
            background: isDark ? '#141414' : '#ffffff',
            borderRight: `1px solid ${isDark ? '#2d2d2d' : '#f0f0f0'}`,
            overflow: 'hidden',
            height: '100vh',
            position: 'sticky',
            top: 0,
          }}
        >
          <SidebarContent {...sidebarProps} onClose={null} />
        </Sider>

        <Layout style={{ background: contentBg }}>
          {/* Header */}
          <Header
            style={{
              background: headerBg,
              padding: '0 16px',
              height: 56,
              lineHeight: '56px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              position: 'sticky',
              top: 0,
              zIndex: 100,
              boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {mobileBroken && (
                <Button
                  icon={<MenuOutlined />}
                  onClick={() => setDrawerOpen(true)}
                  style={{ background: 'transparent', border: 'none', color: '#fff', boxShadow: 'none' }}
                />
              )}
              <div>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 14, lineHeight: 1.2 }}>
                  Глобальный пульт КК — Внуково
                </div>
                {!mobileBroken && (
                  <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, lineHeight: 1.2 }}>
                    Оптимизация совмещения задач SV+GH
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {hasData && selectedDate && !mobileBroken && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: 'rgba(255,255,255,0.65)', fontSize: 11, lineHeight: 1.1 }}>Дата</div>
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, lineHeight: 1.1 }}>{selectedDate}</div>
                </div>
              )}
              <Switch
                checkedChildren={<BulbFilled />}
                unCheckedChildren={<BulbOutlined />}
                checked={isDark}
                onChange={setIsDark}
                title="Переключить тему"
              />
            </div>
          </Header>

          {/* Main content */}
          <Content
            style={{
              overflow: 'auto',
              padding: '16px',
              background: contentBg,
            }}
          >
            {error && (
              <Alert
                message={error}
                type="error"
                showIcon
                closable
                onClose={() => setError(null)}
                style={{ marginBottom: 16 }}
              />
            )}

            {isLoading && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
                <Spin size="large" tip="Загрузка данных…" />
              </div>
            )}

            {!hasData && !isLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 300 }}>
                <Empty
                  image={<span style={{ fontSize: 64 }}>📋</span>}
                  description={
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
                        Загрузите данные для начала работы
                      </div>
                      <div style={{ fontSize: 13, color: isDark ? '#666' : '#aaa' }}>
                        Используйте кнопки на боковой панели
                      </div>
                    </div>
                  }
                />
              </div>
            )}

            {hasData && !isLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <MetricsSummary
                  tasks={tasksDB}
                  staffList={currentStaff}
                  selectedDate={selectedDate}
                  distanceResolver={distanceResolver}
                />
                <Collapse
                  items={collapseItems}
                  defaultActiveKey={['gantt', 'load']}
                  style={{ background: 'transparent' }}
                />
              </div>
            )}
          </Content>
        </Layout>

        {/* Mobile Drawer */}
        <Drawer
          placement="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={280}
          styles={{ body: { padding: 0 }, header: { display: 'none' } }}
        >
          <SidebarContent {...sidebarProps} onClose={() => setDrawerOpen(false)} />
        </Drawer>

        {/* Conflict warning modal — shared by the backlog's select+button
            assignment and the Gantt chart's drag-and-drop assignment. */}
        <Modal
          title={<span style={{ color: '#ff4d4f' }}>⚠️ Конфликт расписания</span>}
          open={!!conflictInfo}
          onCancel={() => setConflictInfo(null)}
          footer={[
            <Button key="cancel" onClick={() => setConflictInfo(null)}>
              Отмена
            </Button>,
            <Button
              key="force"
              type="primary"
              danger
              onClick={() => {
                handleAssign(conflictInfo.task.id, conflictInfo.sel, true);
                setConflictInfo(null);
              }}
            >
              Назначить принудительно
            </Button>,
          ]}
        >
          <Alert
            type="error"
            showIcon
            message={`Сотрудник ${conflictInfo?.sel} занят в это время`}
            description={
              <ul style={{ marginTop: 4, paddingLeft: 16, marginBottom: 0 }}>
                {conflictInfo?.conflicts.map(c => (
                  <li key={c.id}>
                    <b>{c.name}</b> · {fmtTime(c.start)}–{fmtTime(c.end)} · рейс {c.flight}
                  </li>
                ))}
              </ul>
            }
            style={{ marginBottom: 16 }}
          />

          {conflictInfo?.alternatives.length > 0 ? (
            <div>
              <Text strong>Свободные сотрудники с нужной квалификацией:</Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {conflictInfo.alternatives.map(alt => (
                  <Button
                    key={alt.name}
                    size="small"
                    onClick={() => {
                      handleAssign(conflictInfo.task.id, alt.name, true);
                      setConflictInfo(null);
                    }}
                  >
                    {alt.name}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <Alert
              type="warning"
              showIcon
              message="Нет свободных альтернатив"
              description="Все квалифицированные сотрудники заняты в это время. Можно назначить принудительно."
            />
          )}
        </Modal>
      </Layout>
    </ConfigProvider>
  );
}
