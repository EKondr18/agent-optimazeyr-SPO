import { useState, useMemo, useRef, useEffect, lazy, Suspense } from 'react';
import {
  ConfigProvider, Layout, Button, Select, Switch, Input,
  Checkbox, Space, Drawer, Collapse, Typography, Alert,
  Spin, Empty, theme as antdTheme, Badge, Divider, message, Modal, Slider, InputNumber,
  Progress, Tooltip,
} from 'antd';
import ru_RU from 'antd/locale/ru_RU';
import {
  UploadOutlined, ThunderboltOutlined, ClearOutlined,
  MenuOutlined, BulbOutlined, BulbFilled, BarChartOutlined,
  UnorderedListOutlined, ClockCircleOutlined, RiseOutlined,
  TeamOutlined, ScheduleOutlined,
} from '@ant-design/icons';
import Papa from 'papaparse';
import { parseCSV, parseJsonExport, parseCsvCollections } from './utils/dataParser';
import { createDistanceResolver } from './utils/travelGraph';
import { resolveStaffingWithCallIns } from './utils/staffingGap';
import {
  applyChanges, planWindow, DEFAULT_WEIGHTS, DEFAULT_POLICY, setPolicy, findConflicts, hasAllQuals,
  fitsShift, requiredQuals, validatePlan, DEFAULT_LNS_ITERATIONS,
} from './optimizer';
import { dataQualityReport } from './utils/dataQuality';
import { dayKey, dayStart, addDays, daysBetween, fmtHM, fmtDM } from './utils/tz';
import { rankQuals } from './utils/qualColors';
import { countRu, pluralRu, shortFlight, mutedColor, statusColor } from './utils/uiFormat';
import PlanReport from './components/PlanReport';
import MetricsSummary from './components/MetricsSummary';
import TaskDelayPanel from './components/TaskDelayPanel';

// Everything that draws with Plotly (several MB) is loaded only when the first
// chart is about to be shown, not with the first screen.
const GanttChart = lazy(() => import('./components/GanttChart'));
const BacklogPanel = lazy(() => import('./components/BacklogPanel'));
const HourlyLoadChart = lazy(() => import('./components/HourlyLoadChart'));
const StaffingGapPanel = lazy(() => import('./components/StaffingGapPanel'));

function ChartFallback() {
  return (
    <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 120 }}>
      <Spin size="small" />
      <span>Загружаю диаграмму…</span>
    </div>
  );
}
const Lazy = ({ children }) => <Suspense fallback={<ChartFallback />}>{children}</Suspense>;

const { Sider, Content, Header } = Layout;
const { darkAlgorithm, defaultAlgorithm } = antdTheme;
const { Text } = Typography;

const GANTT_WINDOW_DAYS = 3;

// Identity of a rows array, so the worker can tell "same travel network as
// last time" from "a different file was loaded" by the data itself rather than
// by its name or size.
const rowsIds = new WeakMap();
let rowsIdSeq = 0;
function rowsId(rows) {
  if (!rows) return 0;
  if (!rowsIds.has(rows)) rowsIds.set(rows, ++rowsIdSeq);
  return rowsIds.get(rows);
}
// After a delay, tasks starting within this long of "now" are a stability
// window — only touched if they're actually broken, never reshuffled just
// because a fuller re-optimization would prefer someone else. Beyond it,
// full re-optimization is free to pick whatever's genuinely best.
const DELAY_STABILITY_WINDOW_MS = 3 * 3600000;
// Tasks starting within this long of "now" are hard-frozen for the
// improvement search after a delay (only the conflict repair above may touch
// them, and only when genuinely broken). From here to the stability window's
// end the search works hardest; beyond it, it polishes whatever's left.
const DELAY_FROZEN_WINDOW_MS = 3600000;

// All times are shown in Moscow time (the shift day's timezone), whatever the
// browser's own is — see utils/tz.js.
const fmtTime = fmtHM;
const shiftYMD = addDays;

// Violation identity for "did the plan add any": the task, the kind of
// problem and (for overlaps/walks) the other task of the pair.
const violationKey = v => `${v.taskId}|${v.code}|${v.detail ?? ''}`;

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
      <div style={{ fontSize: 11, color: mutedColor(isDark), marginBottom: 2 }}>{label}</div>
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
          color: mutedColor(isDark),
        }}
      >
        {status?.error ? (
          <span style={{ color: statusColor(isDark, 'danger') }}>Ошибка: {status.error}</span>
        ) : status?.filename ? (
          <span style={{ color: statusColor(isDark, 'success') }}>✓ {status.filename} ({status.rowCount})</span>
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
      reader.onload = async ev => {
        try {
          // The spreadsheet library is large and only this one file kind needs it.
          const XLSX = await import('xlsx');
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
      <div style={{ fontSize: 11, color: mutedColor(isDark), marginBottom: 2 }}>{label}</div>
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
          color: mutedColor(isDark),
        }}
      >
        {status?.error ? (
          <span style={{ color: statusColor(isDark, 'danger') }}>Ошибка: {status.error}</span>
        ) : status?.filename ? (
          <span style={{ color: statusColor(isDark, 'success') }}>✓ {status.filename} ({status.rows.length})</span>
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
  isDark, hasData, fileRef, handleFileUpload,
  manualFiles, handleManualFileChange, handleManualJsonLoad, handleManualJsonClear, manualAllReady,
  csvFiles, handleCsvFileSelect, handleCsvLoad, handleCsvClear, csvAllReady,
  locationsFile, handleLocationsRows, travelGraphFile, handleTravelGraphRows,
  availableDates, datesWithShifts, selectedDate, setSelectedDate,
  handleRunOptimizer, handleResetBacklog, optPriorities, setOptPriorities, busy,
  policy, setPolicyState, lnsIterations, setLnsIterations, qualOptions,
  filterTypes, allTaskTypes, toggleType, setFilterTypes,
  onClose,
}) {
  const { token } = antdTheme.useToken();
  const muted = mutedColor(isDark);
  return (
    <div style={{ padding: '0 12px 16px', height: '100%', overflowY: 'auto' }}>
      {/* Logo */}
      <div style={{ padding: '16px 0 12px', borderBottom: `1px solid ${isDark ? '#2d2d2d' : '#f0f0f0'}`, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🛫</span>
          <div>
            {/* The theme's own text color: without it the title is black on the dark panel. */}
            <div style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.3, color: token.colorText }}>Пульт КК — Внуково</div>
            <div style={{ fontSize: 11, color: muted }}>SPO оптимизатор SV+GH</div>
          </div>
        </div>
      </div>

      {/* Data loading */}
      <div style={{ marginBottom: 16 }}>
        <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: muted, display: 'block', marginBottom: 8 }}>Данные</Text>
        <input ref={fileRef} type="file" accept=".csv,.txt" onChange={e => { handleFileUpload(e); onClose?.(); }} style={{ display: 'none' }} />
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button icon={<UploadOutlined />} block onClick={() => fileRef.current?.click()}>
            Загрузить CSV
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
                      <div style={{ fontSize: 11, color: muted, marginBottom: 2 }}>{label}</div>
                      <input
                        type="file"
                        accept=".json,.txt"
                        onChange={e => handleManualFileChange(key, e)}
                        style={{ fontSize: 11, width: '100%' }}
                      />
                      {slot?.error && (
                        <div style={{ fontSize: 11, color: statusColor(isDark, 'danger') }}>Ошибка: {slot.error}</div>
                      )}
                      {slot?.data && !slot.error && (
                        <div style={{ fontSize: 11, color: statusColor(isDark, 'success') }}>✓ {slot.filename} ({slot.data.length})</div>
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
                <Text style={{ fontSize: 11, color: muted }}>
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
            <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: muted, display: 'block', marginBottom: 8 }}>Дата смены</Text>
            <Select
              value={selectedDate}
              onChange={setSelectedDate}
              style={{ width: '100%' }}
              options={availableDates.map(d => ({ value: d, label: datesWithShifts.has(d) ? d : `${d} (нет смен)` }))}
            />
          </div>

          {/* Optimizer */}
          <div style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: muted, display: 'block', marginBottom: 8 }}>Оптимизация</Text>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                block
                loading={busy}
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

            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontSize: 11, color: muted }}>Приоритеты (1 = по умолчанию)</Text>
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, fontSize: 11 }}
                  onClick={() => setOptPriorities({ load: 1, walk: 1, slack: 1, overtime: 1 })}
                >
                  сбросить
                </Button>
              </div>
              {[
                ['load', 'Ровная нагрузка'],
                ['walk', 'Меньше ходьбы'],
                ['slack', 'Запас по времени'],
                ['overtime', 'Меньше сверхурочных'],
              ].map(([key, label]) => (
                <div key={key} style={{ marginTop: 4 }}>
                  <Text style={{ fontSize: 12 }}>{label}</Text>
                  <Slider
                    min={0}
                    max={3}
                    step={0.5}
                    value={optPriorities[key]}
                    onChange={v => setOptPriorities(prev => ({ ...prev, [key]: v }))}
                    style={{ margin: '2px 6px 0' }}
                  />
                </div>
              ))}
            </div>

            {/* Operating rules: hard limits, not preferences */}
            <div style={{ marginTop: 12 }}>
              <Text style={{ fontSize: 11, color: muted }}>Правила (жёсткие ограничения)</Text>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 8 }}>
                <Text style={{ fontSize: 12 }} title="До скольких минут после конца смены сотрудник может задержаться, чтобы закончить начатую в смену задачу">
                  Допустимая переработка, мин
                </Text>
                <InputNumber
                  size="small" min={0} max={240} step={15} style={{ width: 72 }}
                  value={policy.maxOvertimeMin}
                  onChange={v => setPolicyState(p => ({ ...p, maxOvertimeMin: v ?? 0 }))}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 8 }}>
                <Text style={{ fontSize: 12 }} title="Разрешить одному сотруднику две пересекающиеся по времени задачи одного рейса на одной стоянке с разными названиями (например, OUT_1 и OUT_2)">
                  Параллельные задачи одного рейса
                </Text>
                <Switch
                  size="small"
                  checked={policy.sameFlightOverlap}
                  onChange={v => setPolicyState(p => ({ ...p, sameFlightOverlap: v }))}
                />
              </div>
              <div style={{ marginTop: 6 }}>
                <Text style={{ fontSize: 12 }} title="Задачи с этими допусками будут назначаться и без них — только если так решено (например, ни у кого в справочнике нет допуска). Каждое такое назначение показывается в отчёте">
                  Назначать без допуска
                </Text>
                <Select
                  mode="multiple" size="small" allowClear style={{ width: '100%', marginTop: 2 }}
                  placeholder="нет — все допуски обязательны"
                  value={policy.waivedQuals}
                  onChange={v => setPolicyState(p => ({ ...p, waivedQuals: v }))}
                  options={qualOptions}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, gap: 8 }}>
                <Text style={{ fontSize: 12 }} title="Сколько попыток дополнительного поиска перестановок групп задач (LNS) делать после основного прохода. 0 — не искать. Число попыток, а не секунды: одинаковые данные дают одинаковый план на любом компьютере (≈200 попыток — около 3 секунд)">
                  Доп. поиск (LNS), попыток
                </Text>
                <InputNumber
                  size="small" min={0} max={1000} step={50} style={{ width: 72 }}
                  value={lnsIterations}
                  onChange={v => setLnsIterations(v ?? 0)}
                />
              </div>
            </div>
          </div>

          <Divider style={{ margin: '8px 0' }} />

          {/* Task type filter */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: muted }}>Типы задач</Text>
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
                  <span style={{ fontSize: 12 }} title={name}>{name}</span>
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
  const [fullRoster, setFullRoster] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
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
  // Shared zoom/pan range between the main Gantt and the backlog mini-chart
  // — null means "the selected day" (default); set by either chart's
  // onRelayout so zooming one updates both rulers together.
  const [ganttVisibleRange, setGanttVisibleRange] = useState(null);
  // Panels whose heavy calculations only matter while they're open — the
  // call-in/strategic plans re-solve a whole day, so they must not run in the
  // background on every change to the schedule.
  const [openPanels, setOpenPanels] = useState(['gantt', 'load']);
  // A heavy optimizer job is running in the worker.
  const [busy, setBusy] = useState(false);
  const [modal, modalHolder] = Modal.useModal();
  const workerRef = useRef(null);
  const workerWarned = useRef(false);
  const jobsInFlight = useRef(0);
  const jobSeq = useRef(0);
  // How much each aim matters to the optimizer, as a multiplier on the
  // defaults (1 = default, 0 = ignore it). See DEFAULT_WEIGHTS in optimizer.js.
  const [optPriorities, setOptPriorities] = useState({ load: 1, walk: 1, slack: 1, overtime: 1 });
  const optWeights = useMemo(
    () => Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * optPriorities[k]])),
    [optPriorities]
  );
  // Operating rules (see DEFAULT_POLICY in optimizer.js). Applied on this
  // thread for the manual-assignment checks and sent with every worker job.
  const [policy, setPolicyState] = useState(DEFAULT_POLICY);
  setPolicy(policy);
  const [lnsIterations, setLnsIterations] = useState(DEFAULT_LNS_ITERATIONS);
  // What the last optimizer run reported (open tasks per stage, lower bound,
  // checks) — shown under the metrics.
  const [planStats, setPlanStats] = useState(null);
  // Always the latest tasksDB, for telling whether a job's result is stale: a
  // job computed from an older plan must not overwrite edits made meanwhile.
  const tasksRef = useRef(tasksDB);
  tasksRef.current = tasksDB;
  const staffRef = useRef(staffDB);
  staffRef.current = staffDB;
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
  const datesWithShifts = useMemo(
    () => new Set(availableDates.filter(d => (staffDB[d] || []).length > 0)),
    [availableDates, staffDB]
  );
  // Every qualification the tasks require; the ones nobody holds come first
  // and are marked — those are the candidates for "assign without".
  const qualOptions = useMemo(() => {
    const req = new Map();
    for (const t of tasksDB) for (const q of requiredQuals(t)) req.set(q, (req.get(q) || 0) + 1);
    const held = new Set([...Object.values(staffDB).flat(), ...fullRoster].flatMap(s => s.quals || []));
    return [...req.entries()]
      .sort((a, b) => Number(held.has(a[0])) - Number(held.has(b[0])) || b[1] - a[1])
      .map(([q, n]) => ({ value: q, label: held.has(q) ? `${q} (${n})` : `${q} (${n}) — ни у кого нет` }));
  }, [tasksDB, staffDB, fullRoster]);

  // What in the loaded data makes tasks unassignable regardless of the
  // optimizer. Depends only on the data's shape, not on assignments.
  const dataQuality = useMemo(
    () => (tasksDB.length ? dataQualityReport({ tasks: tasksDB, staffDB, fullRoster }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasksDB.length, staffDB, fullRoster]
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
  // Opens on the selected day (an hour is ~3x wider than on the whole 3-day
  // window); a zoom from an earlier date would show the wrong day.
  const dayRange = useMemo(
    () => (selectedDate ? [dayStart(selectedDate).getTime(), dayStart(addDays(selectedDate, 1)).getTime()] : null),
    [selectedDate]
  );
  const windowRange = useMemo(
    () => (selectedDate ? [dayStart(addDays(selectedDate, -1)).getTime(), dayStart(addDays(selectedDate, 2)).getTime()] : null),
    [selectedDate]
  );
  useEffect(() => { setGanttVisibleRange(null); }, [selectedDate]);
  const allTaskTypes = useMemo(
    () => [...new Set(tasksDB.map(t => t.name))].sort(),
    [tasksDB]
  );
  // Open tasks of the window (±1 day) and of the selected day alone: the badges
  // show the day (it matches the "Бэклог" tile), the tooltip the window.
  const backlogCount = ganttTasks.filter(t => t.employee === 'Не назначено').length;
  const dayBacklogCount = currentTasks.filter(t => t.employee === 'Не назначено').length;
  // Same codes keep the same colors in every chart, in a fixed order; the array
  // identity only changes when the ranking itself does.
  const qualOrderRaw = useMemo(() => rankQuals(tasksDB), [tasksDB]);
  const qualOrderRef = useRef(qualOrderRaw);
  if (qualOrderRef.current.join('\u0001') !== qualOrderRaw.join('\u0001')) qualOrderRef.current = qualOrderRaw;
  const qualOrder = qualOrderRef.current;
  const backlogTasksAll = useMemo(
    () => tasksDB.filter(t => t.employee === 'Не назначено'),
    [tasksDB]
  );

  // Full shift history per employee across every loaded date (not just the
  // Gantt's 3-day window) — the call-in eligibility rule ("no shift within
  // 12h before/after") needs to see shifts that can fall outside it.
  const allShiftsByPerson = useMemo(() => {
    const map = new Map();
    for (const list of Object.values(staffDB)) {
      for (const s of list) {
        if (!map.has(s.name)) map.set(s.name, []);
        map.get(s.name).push({ shiftStart: s.shiftStart, shiftEnd: s.shiftEnd });
      }
    }
    return map;
  }, [staffDB]);

  // Strategic planning: a preview of the NEXT day, built by pre-running the
  // optimizer against that day's own shifts and qualifications, THEN
  // applying the same call-in/shift-extension resolution the staffing-gap
  // panel uses — a strategic plan should already show a fully-staffed day
  // wherever that's achievable at all, not a raw backlog the dispatcher
  // still has to go solve by hand a day in advance. This is a read-only
  // "what-if" (runOptimizer returns fresh clones, never mutates tasksDB) —
  // the operational charts above still reflect the actual current
  // assignment, this reflects a plan for a day not lived yet.
  const futureDate = useMemo(() => (selectedDate ? shiftYMD(selectedDate, 1) : ''), [selectedDate]);
  // The plain optimizer run (existing shifts only) — fed to StaffingGapPanel
  // so its "нужно ещё N чел" interval list still reflects the RAW demand
  // that made a call-in plan necessary in the first place, not the already
  // fixed-up result.
  // The call-in plans re-solve a whole day, so they run in the worker and only
  // while their panel is open. Each keeps the last finished result; a newer
  // request supersedes an older one still in flight.
  const gapOpen = openPanels.includes('staffing-gap');
  const strategicOpen = openPanels.includes('strategic');
  const [gapResolution, setGapResolution] = useState(null);
  const [futureResolution, setFutureResolution] = useState(null);
  const gapReq = useRef(0);
  const futureReq = useRef(0);

  useEffect(() => {
    if (!gapOpen || !selectedDate) return;
    const req = ++gapReq.current;
    setGapResolution(null);
    runJob('gap', { args: {
      tasksDB, staffDB, targetDate: selectedDate, windowDates, fullRoster, allShiftsByPerson,
    } }).then(r => { if (req === gapReq.current) setGapResolution(r); })
      .catch(err => { if (req === gapReq.current) message.error('Не удалось посчитать план вызова: ' + err.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapOpen, tasksDB, staffDB, selectedDate, windowDates, fullRoster, allShiftsByPerson, distanceResolver]);

  useEffect(() => {
    if (!strategicOpen || !futureDate) return;
    const req = ++futureReq.current;
    setFutureResolution(null);
    runJob('gap', { args: {
      tasksDB, staffDB, targetDate: futureDate, windowDates: [futureDate], fullRoster, allShiftsByPerson,
    } }).then(r => { if (req === futureReq.current) setFutureResolution(r); })
      .catch(err => { if (req === futureReq.current) message.error('Не удалось посчитать стратегический план: ' + err.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategicOpen, tasksDB, staffDB, futureDate, fullRoster, allShiftsByPerson, distanceResolver]);

  // Tomorrow as the plain optimizer leaves it (existing shifts only) — what
  // the gap list measures the need against — and with the call-in plan applied.
  const futureDayTasksRaw = useMemo(
    () => (futureResolution ? futureResolution.baselineTasks.filter(t => t.date === futureDate) : []),
    [futureResolution, futureDate]
  );
  const futureDayTasks = useMemo(
    () => (futureResolution ? futureResolution.tasks.filter(t => t.date === futureDate) : []),
    [futureResolution, futureDate]
  );
  // What's left even after call-ins/extensions — should be empty unless
  // nobody in the loaded data holds a given qualification at all.
  const futureBacklogTasks = futureResolution?.unresolved ?? [];

  function applyParsedData({ tasks, staffDB: db, fullRoster: roster }) {
    const dates = [...new Set(tasks.map(t => t.date))].sort();
    const types = [...new Set(tasks.map(t => t.name))];
    setTasksDB(tasks);
    setStaffDB(db);
    setFullRoster(roster || []);
    setPlanStats(null);
    // Open on the first day that has both tasks and shifts — the first task
    // date alone may have nobody on shift, which leaves the optimizer idle.
    setSelectedDate(dates.find(d => (db[d] || []).length > 0) ?? dates[0]);
    setFilterTypes(types);
    setFilterFlight('');
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

  // Runs a job on the page itself — the fallback where the worker is
  // unavailable or died (it freezes the UI for the duration, but still works).
  function runJobHere(kind, payload) {
    try {
      if (kind === 'run') {
        return Promise.resolve(planWindow(payload.tasks, payload.staffDB, payload.selectedDate, distanceResolver, payload.windowDates, { weights: payload.weights, lnsIterations: payload.lnsIterations }));
      }
      if (kind === 'gap') {
        return Promise.resolve(resolveStaffingWithCallIns({ ...payload.args, distanceResolver }));
      }
      return Promise.resolve(applyChanges(payload.tasks, payload.staffDB, payload.selectedDate, distanceResolver, payload.windowDates, payload.changes, payload.options));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // The worker is started when the page opens (below), not at the first job:
  // a page left open across a redeploy would otherwise ask for a worker file
  // the new build no longer has. If it can't be started, or dies, jobs run on
  // the page itself and the user is told once. The usual cause is a stale
  // page: the host answers the old worker's address with index.html, and the
  // worker fails with an empty "worker error". The page's own bundle still
  // holds the optimizer, so nothing is lost; reloading brings the new build.
  function warnWorkerDown() {
    if (workerWarned.current) return;
    workerWarned.current = true;
    message.warning('Фоновый расчёт недоступен (страница, скорее всего, устарела после обновления сайта). Расчёт выполняется на странице — обновите её (Ctrl+F5), чтобы вернуть быструю работу.', 8);
  }
  function startWorker() {
    if (workerRef.current) return workerRef.current;
    try {
      const w = new Worker(new URL('./optimizer.worker.js', import.meta.url), { type: 'module' });
      // A failure with no job waiting (the file could not be loaded) is
      // noticed here; during a job the job's own handler deals with it.
      w.addEventListener('error', () => {
        if (jobsInFlight.current > 0) return;
        if (workerRef.current === w) workerRef.current = null;
        try { w.terminate(); } catch { /* already gone */ }
        warnWorkerDown();
      });
      workerRef.current = w;
    } catch {
      workerRef.current = null;
    }
    return workerRef.current;
  }
  useEffect(() => {
    startWorker();
    return () => {
      const w = workerRef.current;
      workerRef.current = null;
      try { w?.terminate(); } catch { /* already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Runs a heavy optimizer job in the worker and resolves with its result.
  function runJob(kind, payload) {
    const resolverRows = distanceResolver
      ? { locations: locationsFile?.rows || [], travelEdges: travelGraphFile?.rows || [] }
      : null;
    const full = { ...payload, policy, resolverRows, resolverKey: `${rowsId(locationsFile?.rows)}|${rowsId(travelGraphFile?.rows)}` };
    const w = startWorker();
    if (!w) return runJobHere(kind, payload);
    const id = ++jobSeq.current;
    jobsInFlight.current++;
    return new Promise((resolve, reject) => {
      const onMessage = e => {
        if (e.data.id !== id) return;
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        jobsInFlight.current--;
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
      };
      const onError = e => {
        w.removeEventListener('message', onMessage);
        w.removeEventListener('error', onError);
        jobsInFlight.current--;
        if (workerRef.current === w) workerRef.current = null;
        try { w.terminate(); } catch { /* already gone */ }
        // A real calculation error comes back as a message from the worker's
        // own try/catch; an 'error' event is the worker itself failing.
        warnWorkerDown();
        runJobHere(kind, payload).then(resolve, reject);
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', onError);
      w.postMessage({ id, kind, payload: full });
    });
  }

  async function handleRunOptimizer() {
    if (busy) return;
    const windowHasStaff = windowDates.some(d => (staffDB[d] || []).length > 0);
    if (!windowHasStaff) {
      const withStaff = availableDates.filter(d => (staffDB[d] || []).length > 0);
      message.warning(
        `На ${selectedDate} (и соседние дни окна) нет смен — распределять некому.` +
        (withStaff.length ? ` Смены есть на: ${withStaff.join(', ')}. Выберите одну из этих дат.` : ' В загруженных данных вообще нет смен СПО.')
      );
      return;
    }
    setBusy(true);
    const startedFrom = tasksDB;
    try {
      // Construction → local search → bounded LNS → independent check (see
      // planWindow in optimizer.js).
      const { tasks: improved, stats } = await runJob('run', {
        tasks: tasksDB, staffDB, selectedDate, windowDates, weights: optWeights,
        lnsIterations,
      });
      if (tasksRef.current !== startedFrom) {
        message.warning('Пока шёл расчёт, расписание изменили вручную — результат оптимизатора не применён, чтобы не затереть правки. Запустите ещё раз.');
        return;
      }
      setTasksDB(improved);
      setPlanStats({ ...stats, selectedDate });
      const inWin = improved.filter(t => windowDates.includes(t.date));
      const placed = inWin.filter(t => t.employee !== 'Не назначено').length;
      if (placed === 0 && inWin.length > 0) {
        message.warning('Ни одна задача не назначена: ни у кого из сотрудников на смене нет нужных квалификаций. Проверьте квалификации сотрудников (справочники).');
      }
    } catch (err) {
      message.error('Не удалось запустить оптимизатор: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleResetBacklog() {
    setTasksDB(prev =>
      prev.map(t =>
        t.date === selectedDate
          ? { ...t, employee: 'Не назначено', isLocked: false }
          : t
      )
    );
  }

  async function handleApplyDelays(delayMap) {
    if (busy) return;
    const updated = tasksDB.map(t => {
      const minutes = delayMap[t.id] ?? 0;
      return {
        ...t,
        start: new Date(t.baseStart.getTime() + minutes * 60000),
        end: new Date(t.baseEnd.getTime() + minutes * 60000),
      };
    });

    // What actually changed, and the earliest moment it touches: anything that
    // starts before that stays exactly as assigned, whoever it belongs to.
    // TODO: once live data loads automatically, use the real wall-clock time
    // as that cutoff instead of a per-delay marker.
    const changes = [];
    let earliest = Infinity;
    updated.forEach((t, i) => {
      const old = tasksDB[i];
      if (t.start.getTime() === old.start.getTime() && t.end.getTime() === old.end.getTime()) return;
      changes.push({ id: t.id, start: t.start, end: t.end });
      earliest = Math.min(earliest, old.start.getTime(), t.start.getTime());
    });
    if (changes.length === 0) {
      setTasksDB(updated);
      return;
    }

    // Same engine a backend would call for a batch of task changes. A delay
    // can open up a better arrangement for people other than the one it hit,
    // so here (unlike a purely incremental update) everything past the
    // stability window is fully re-optimized and the whole pool is searched;
    // inside the window only what's actually broken gets touched.
    const now = new Date(earliest);
    setBusy(true);
    const startedFrom = tasksDB;
    let outcome;
    try {
      outcome = await runJob('changes', {
        tasks: tasksDB, staffDB, selectedDate, windowDates, changes,
        options: {
          now,
          frozenWindowMs: DELAY_FROZEN_WINDOW_MS,
          stabilityWindowMs: DELAY_STABILITY_WINDOW_MS,
          farReshuffle: true,
          weights: optWeights,
        },
      });
    } catch (err) {
      message.error('Не удалось применить задержки: ' + err.message);
      return;
    } finally {
      setBusy(false);
    }
    if (tasksRef.current !== startedFrom) {
      message.warning('Пока применялись задержки, расписание изменили вручную — результат не применён, чтобы не затереть правки. Примените задержки ещё раз.');
      return;
    }
    const { tasks: resolved, repairs, needsDecision = [] } = outcome;
    // Looked up by id once: a find() per task made this step quadratic, and it
    // froze the page for seconds on a full export.
    const resolvedById = new Map(resolved.map(t => [t.id, t]));
    const beforeById = new Map(tasksDB.map(t => [t.id, t]));
    for (const id of needsDecision) {
      const t = resolvedById.get(id);
      if (t) message.warning(`«${t.name}» закреплена за ${t.employee}, но он(а) больше не может её выполнить (нет смены или допуска) — нужно решение диспетчера`);
    }

    for (const c of repairs) {
      if (c.backlog) {
        message.warning(`«${c.taskName}» (${c.from}): из-за задержки конфликтует с другой задачей — свободных сотрудников нет даже с перетасовкой, задача возвращена в бэклог`);
      } else if (c.viaBump) {
        message.info(`«${c.taskName}»: подвинута с ${c.from} на ${c.to}, чтобы освободить место для задачи из-за задержки`);
      } else {
        message.info(`«${c.taskName}»: из-за задержки переназначена с ${c.from} на ${c.to} (конфликт)`);
      }
    }

    const frozenUntil = new Date(now.getTime() + DELAY_FROZEN_WINDOW_MS);
    const movedCount = resolved.filter(t => {
      const before = beforeById.get(t.id);
      return before && before.employee !== t.employee;
    }).length;
    if (movedCount > repairs.length) {
      message.info(`Задержка применена — перераспределено ${movedCount} задач(и) в расписании после ${fmtTime(frozenUntil)}`);
    }

    setTasksDB(resolved);
  }

  // Turns the call-in plan into the schedule: each proposed earlier start /
  // later end replaces that shift (in every date bucket it touches, now
  // possibly one more across midnight), each call-in becomes a new shift, and
  // the tasks take the plan's assignments. Checked against the new shifts
  // before anything is replaced, and confirmed by the dispatcher: it changes
  // real shifts and calls real people in.
  //
  // The check refuses only what the plan itself would break. Violations that
  // are already in the schedule (typically a task forced onto someone by hand,
  // "Назначить принудительно") are the dispatcher's earlier decision; they must
  // not make the plan unappliable for ever, but they are reported, not hidden.
  function handleApplyCallInPlan(resolution) {
    const db = Object.fromEntries(Object.entries(staffDB).map(([d, list]) => [d, [...list]]));
    const place = obj => {
      for (const d of daysBetween(dayKey(obj.shiftStart), dayKey(obj.shiftEnd))) (db[d] ??= []).push(obj);
    };
    for (const a of resolution.actions) {
      if (a.type === 'extend') {
        let original = null;
        for (const list of Object.values(db)) {
          const i = list.findIndex(s => s.name === a.name && s.shiftStart.getTime() === a.originalStart.getTime());
          if (i >= 0) { original = list[i]; list.splice(i, 1); }
        }
        if (!original) continue;
        place({ ...original, shiftStart: a.shiftStart, shiftEnd: a.shiftEnd, planned: { start: a.originalStart, end: a.originalEnd } });
      } else {
        const person = fullRoster.find(p => p.name === a.name);
        place({ name: a.name, quals: person?.quals || [], zone: 'APRON', shiftStart: a.shiftStart, shiftEnd: a.shiftEnd, basePos: null, callIn: true });
      }
    }
    const before = new Set(validatePlan(tasksDB, staffDB, selectedDate, distanceResolver, windowDates).map(violationKey));
    const after = validatePlan(resolution.tasks, db, selectedDate, distanceResolver, windowDates);
    const introduced = after.filter(v => !before.has(violationKey(v)));
    if (introduced.length > 0) {
      message.error(`План не применён: он вносит ${countRu(introduced.length, 'новое нарушение', 'новых нарушения', 'новых нарушений')} правил — пересчитайте план`);
      return;
    }

    const ext = resolution.actions.filter(a => a.type === 'extend').length;
    const calls = resolution.actions.filter(a => a.type === 'callin').length;
    const eased = resolution.actions.filter(a => a.tier === 'tight' || a.tier === 'forced').length;
    const startedFrom = tasksDB;
    const startedStaff = staffDB;
    modal.confirm({
      title: 'Применить план вызова?',
      width: 480,
      okText: 'Применить',
      cancelText: 'Отмена',
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            Будет изменено: {countRu(ext, 'смена', 'смены', 'смен')}; вызвано: {countRu(calls, 'человек', 'человека', 'человек')}.
          </p>
          {eased > 0 && (
            <p style={{ marginBottom: 8 }}>
              Для {eased} из {resolution.actions.length} {pluralRu(resolution.actions.length, 'изменения', 'изменений', 'изменений')} отдых между сменами сокращён или не соблюдён («сжато», «крайний случай») — нужно согласие сотрудников.
            </p>
          )}
          <p style={{ marginBottom: 0 }}><b>Сдвиги и вызовы согласуйте с сотрудниками и HR.</b></p>
        </div>
      ),
      onOk: () => {
        if (tasksRef.current !== startedFrom || staffRef.current !== startedStaff) {
          message.warning('Пока открыто окно подтверждения, расписание изменилось — план не применён. Пересчитайте план.');
          return;
        }
        setStaffDB(db);
        setTasksDB(resolution.tasks);
        // The report under the metrics must say what is still wrong after the
        // plan, not what was wrong after the optimizer's own run.
        setPlanStats(prev => (prev && prev.selectedDate === selectedDate ? { ...prev, violations: after } : prev));
        const open = resolution.tasks.filter(t => windowDates.includes(t.date) && t.employee === 'Не назначено').length;
        const done = `План применён: ${countRu(resolution.actions.length, 'изменение', 'изменения', 'изменений')} смен. Без исполнителя осталось ${open}.`;
        if (after.length > 0) {
          message.warning(`${done} Остаются ${after.length} ${pluralRu(after.length, 'нарушение', 'нарушения', 'нарушений')} правил у закреплённых вручную задач (они были до плана) — см. «Результат оптимизации».`, 8);
        } else {
          message.success(done);
        }
      },
    });
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
  //
  // A manual assignment passes the same hard rules as the optimizer's own
  // (qualifications, shift incl. the allowed overtime, walk from the shift
  // base, no double-booking) — a qualification or shift problem can't be
  // overridden here, only a conflict can be resolved by picking someone else.
  const canTakeManually = (s, task) =>
    hasAllQuals(s.quals, task) && fitsShift(s, task, distanceResolver, true);
  function attemptAssign(task, employeeName, staffPool) {
    const shifts = staffPool.filter(s => s.name === employeeName);
    if (!shifts.some(s => canTakeManually(s, task))) {
      const missing = requiredQuals(task).filter(q => !shifts.some(s => s.quals.includes(q)));
      message.error(
        shifts.length === 0
          ? `${employeeName}: нет смены в этом окне`
          : missing.length > 0
            ? `${employeeName}: нет допуска ${missing.join(', ')} — назначить нельзя`
            : `${employeeName}: задача вне смены (с учётом допустимой переработки ${policy.maxOvertimeMin} мин) или до неё не успеть дойти от места начала смены`
      );
      return;
    }
    const conflicts = findConflicts(employeeName, task, tasksDB, distanceResolver);
    if (conflicts.length === 0) {
      handleAssign(task.id, employeeName, true);
      return;
    }
    const alternatives = staffPool.filter(s =>
      s.name !== employeeName &&
      canTakeManually(s, task) &&
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

  // Inline time edit from clicking a bar on the main Gantt chart. Goes through
  // the same batch-update path as any other change, so a new time that breaks
  // the assignment (out of shift, now overlapping) is repaired, not kept.
  async function handleEditTaskTime(taskId, newStart, newEnd) {
    if (busy) return;
    setBusy(true);
    const startedFrom = tasksDB;
    try {
      const out = await runJob('changes', {
        tasks: tasksDB, staffDB, selectedDate, windowDates,
        changes: [{ id: taskId, start: newStart, end: newEnd }],
        options: { weights: optWeights, escalate: false },
      });
      if (tasksRef.current !== startedFrom) return;
      setTasksDB(out.tasks);
      if (out.unplaced.includes(taskId)) {
        message.warning('С новым временем задачу некому выполнить — она возвращена в бэклог');
      }
    } catch (err) {
      message.error('Не удалось изменить время: ' + err.message);
    } finally {
      setBusy(false);
    }
  }

  function toggleType(name) {
    setFilterTypes(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const hasData = tasksDB.length > 0;

  const sidebarProps = {
    isDark, hasData, fileRef, handleFileUpload,
    manualFiles, handleManualFileChange, handleManualJsonLoad, handleManualJsonClear, manualAllReady,
    csvFiles, handleCsvFileSelect, handleCsvLoad, handleCsvClear, csvAllReady,
    locationsFile, handleLocationsRows, travelGraphFile, handleTravelGraphRows,
    availableDates, datesWithShifts, selectedDate, setSelectedDate,
    handleRunOptimizer, handleResetBacklog, optPriorities, setOptPriorities, busy,
    policy, setPolicyState, lnsIterations, setLnsIterations, qualOptions,
    filterTypes, allTaskTypes, toggleType, setFilterTypes,
  };

  // White text on the header needs ~6:1 on the light theme (#1677ff gave 4.1:1).
  const headerBg = isDark ? '#001529' : '#0958d9';
  const contentBg = isDark ? '#0d0d0d' : '#f5f5f5';
  const mutedTxt = mutedColor(isDark);

  // No optimizer run for this date yet: counts of "open" tasks would only mean
  // "nothing has been done", not a problem, so the badges stay off until then.
  const calculated = !!planStats && planStats.selectedDate === selectedDate;
  const awaitingRun = !calculated && currentTasks.length > 0 && currentTasks.every(t => t.employee === 'Не назначено');
  const backlogBadge = !awaitingRun && dayBacklogCount > 0 && (
    <Tooltip title={`за ±1 сутки: ${backlogCount}`}>
      <Badge count={dayBacklogCount} overflowCount={99999} style={{ marginLeft: 8 }} />
    </Tooltip>
  );

  // The selected date has no shifts: nobody to assign to. Offer the nearest
  // date that has some instead of a message that disappears after a few seconds.
  const noShiftsToday = hasData && selectedDate && !(staffDB[selectedDate] || []).length;
  const nearestWithShifts = useMemo(() => {
    if (!selectedDate) return null;
    const at = dayStart(selectedDate).getTime();
    let best = null;
    for (const d of datesWithShifts) {
      const dist = Math.abs(dayStart(d).getTime() - at);
      if (best === null || dist < best.dist) best = { d, dist };
    }
    return best ? best.d : null;
  }, [selectedDate, datesWithShifts]);

  const collapseItems = hasData && !isLoading ? [
    {
      key: 'gantt',
      label: (
        <span style={{ fontWeight: 600 }}>
          <BarChartOutlined style={{ marginRight: 8 }} />
          План на {fmtDM(dayStart(selectedDate))}: {currentTasks.length} задач (в окне ±1 сутки — {ganttTasks.length})
        </span>
      ),
      children: (
        <div>
          <Space style={{ marginBottom: 12 }} wrap>
            <Input
              placeholder="Фильтр по рейсу…"
              value={filterFlight}
              onChange={e => setFilterFlight(e.target.value)}
              allowClear
              style={{ width: 220 }}
            />
            <Button
              size="small"
              disabled={ganttVisibleRange && ganttVisibleRange[0] === windowRange[0] && ganttVisibleRange[1] === windowRange[1]}
              onClick={() => setGanttVisibleRange(windowRange)}
            >
              Показать ±1 сутки
            </Button>
            <Button
              size="small"
              disabled={!ganttVisibleRange}
              onClick={() => setGanttVisibleRange(null)}
            >
              Сбросить масштаб
            </Button>
          </Space>
          <Lazy>
            <GanttChart
              tasks={ganttTasks}
              staffShifts={ganttStaff}
              windowDays={GANTT_WINDOW_DAYS}
              windowStart={windowDates[0]}
              qualOrder={qualOrder}
              selectedDate={selectedDate}
              filterTypes={filterTypes}
              filterFlight={filterFlight}
              isDark={isDark}
              draggingTask={draggingTask}
              onDropAssign={handleDropAssign}
              onEditTaskTime={handleEditTaskTime}
              onUnassignTask={taskId => handleAssign(taskId, 'Не назначено', false)}
              distanceResolver={distanceResolver}
              visibleRange={ganttVisibleRange || dayRange}
              onVisibleRangeChange={setGanttVisibleRange}
            />
          </Lazy>
        </div>
      ),
    },
    {
      key: 'backlog',
      label: (
        <span style={{ fontWeight: 600 }}>
          <UnorderedListOutlined style={{ marginRight: 8 }} />
          Нераспределённые задачи
          {backlogBadge}
        </span>
      ),
      children: (
        <Lazy>
          <BacklogPanel
            tasks={tasksDB}
            staffList={ganttStaff}
            windowDates={windowDates}
            windowStart={windowDates[0]}
            windowDays={GANTT_WINDOW_DAYS}
            qualOrder={qualOrder}
            onAssign={handleAssign}
            isDark={isDark}
            distanceResolver={distanceResolver}
            onAssignAttempt={attemptAssign}
            onDragTaskChange={setDraggingTask}
            visibleRange={ganttVisibleRange || dayRange}
            onVisibleRangeChange={setGanttVisibleRange}
          />
        </Lazy>
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
        <Lazy>
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Все задачи</Text>
          <HourlyLoadChart
            tasks={tasksDB}
            selectedDate={selectedDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
            roster={fullRoster}
            qualOrder={qualOrder}
          />
          <Divider style={{ margin: '20px 0' }} />
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Нераспределённые задачи (бэклог)</Text>
          <HourlyLoadChart
            tasks={backlogTasksAll}
            selectedDate={selectedDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
            roster={fullRoster}
            qualOrder={qualOrder}
          />
        </Lazy>
      ),
    },
    {
      key: 'staffing-gap',
      label: (
        <span style={{ fontWeight: 600 }}>
          <TeamOutlined style={{ marginRight: 8 }} />
          Нехватка персонала
          {backlogBadge}
        </span>
      ),
      children: !gapOpen ? null : (
        <Lazy>
          <StaffingGapPanel
            tasks={tasksDB}
            resolution={gapResolution}
            staffDB={staffDB}
            targetDate={selectedDate}
            windowDates={windowDates}
            windowStart={windowDates[0]}
            windowDays={GANTT_WINDOW_DAYS}
            fullRoster={fullRoster}
            allShiftsByPerson={allShiftsByPerson}
            distanceResolver={distanceResolver}
            isDark={isDark}
            qualOrder={qualOrder}
            onApply={handleApplyCallInPlan}
          />
        </Lazy>
      ),
    },
    {
      key: 'strategic',
      label: (
        <span style={{ fontWeight: 600 }}>
          <ScheduleOutlined style={{ marginRight: 8 }} />
          Стратегическое планирование (сутки {futureDate})
        </span>
      ),
      children: !strategicOpen ? null : !futureResolution ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spin size="small" />
          <Text type="secondary">Считаю стратегический план…</Text>
        </div>
      ) : (
        <Lazy>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="Предварительный план на завтра"
            description="Задачи на этот день ещё не распределены реально — оптимизатор заранее раскидывает их по сменам и квалификациям, а всё, что не закрылось имеющимися сменами, дополнительно закрывается планом вызова/продления смен ниже. Поэтому по итогу здесь не должно оставаться нераспределённых задач, кроме тех, где вообще ни у кого нет нужной квалификации — такие показаны отдельно и промаркированы, за счёт кого и на каких условиях распределено остальное."
          />
          {futureResolution && futureResolution.actions.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={`Задействовано ${futureResolution.actions.length} доп. чел. (вызов/продление смены)`}
              description="Без них часть задач ниже осталась бы в бэклоге — состав и условия по каждому смотрите в «Нехватка персонала и план вызова» ниже."
            />
          )}
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Все задачи (с учётом плана вызова)</Text>
          <HourlyLoadChart
            tasks={futureDayTasks}
            selectedDate={futureDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
            roster={fullRoster}
            qualOrder={qualOrder}
          />
          <Divider style={{ margin: '20px 0' }} />
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            Осталось нераспределено (даже с учётом вызова/продления смен)
          </Text>
          <HourlyLoadChart
            tasks={futureBacklogTasks}
            selectedDate={futureDate}
            selectedTaskTypes={filterTypes}
            isDark={isDark}
            roster={fullRoster}
            qualOrder={qualOrder}
          />
          <Divider style={{ margin: '20px 0' }} />
          <Text strong style={{ display: 'block', marginBottom: 8 }}>Нехватка персонала и план вызова на подработку</Text>
          <StaffingGapPanel
            tasks={futureDayTasksRaw}
            resolution={futureResolution}
            staffDB={staffDB}
            targetDate={futureDate}
            windowDates={[futureDate]}
            windowStart={futureDate}
            windowDays={1}
            fullRoster={fullRoster}
            allShiftsByPerson={allShiftsByPerson}
            distanceResolver={distanceResolver}
            isDark={isDark}
            qualOrder={qualOrder}
          />
        </Lazy>
      ),
    },
  ] : [];

  return (
    <ConfigProvider
      locale={ru_RU}
      theme={{
        algorithm: isDark ? darkAlgorithm : defaultAlgorithm,
        token: {
          colorPrimary: isDark ? '#1668dc' : '#0958d9',
          colorLink: isDark ? '#69b1ff' : '#0958d9',
          borderRadius: 8,
          // antd's default greys for secondary text, hints and placeholders are
          // below the 4.5:1 contrast the text needs (3.35:1 and 1.83:1 on white).
          colorTextSecondary: isDark ? '#b0b0b0' : '#595959',
          colorTextDescription: mutedTxt,
          colorTextTertiary: mutedTxt,
          colorTextPlaceholder: isDark ? '#8c8c8c' : '#767676',
        },
      }}
    >
      {modalHolder}
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
                  Пульт КК — Внуково
                </div>
                {!mobileBroken && (
                  <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, lineHeight: 1.2 }}>
                    Оптимизация совмещения задач SV+GH
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {hasData && selectedDate && (
                <div style={{ textAlign: 'right' }}>
                  {!mobileBroken && <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, lineHeight: 1.1 }}>Дата</div>}
                  <div style={{ color: '#fff', fontWeight: 600, fontSize: 13, lineHeight: 1.1 }} title={selectedDate}>
                    {mobileBroken ? fmtDM(dayStart(selectedDate)) : selectedDate}
                  </div>
                </div>
              )}
              <Switch
                checkedChildren={<BulbFilled />}
                unCheckedChildren={<BulbOutlined />}
                checked={isDark}
                onChange={setIsDark}
                title="Переключить тему"
                aria-label="Тёмная тема"
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
                      <div style={{ fontSize: 13, color: mutedTxt }}>
                        Используйте кнопки на боковой панели
                      </div>
                    </div>
                  }
                />
              </div>
            )}

            {hasData && !isLoading && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {noShiftsToday && (
                  <Alert
                    type="warning"
                    showIcon
                    message={`На ${fmtDM(dayStart(selectedDate))} нет ни одной смены — распределять некому.`}
                    description={nearestWithShifts
                      ? `Ближайшая дата со сменами — ${fmtDM(dayStart(nearestWithShifts))} (${nearestWithShifts}).`
                      : 'В загруженных данных вообще нет смен СПО.'}
                    action={nearestWithShifts && (
                      <Button size="small" type="primary" onClick={() => setSelectedDate(nearestWithShifts)}>
                        Перейти на {fmtDM(dayStart(nearestWithShifts))}
                      </Button>
                    )}
                  />
                )}
                {busy && (
                  <div role="status" aria-live="polite">
                    <Text strong>Идёт расчёт…</Text>
                    <Progress percent={100} status="active" showInfo={false} size="small" />
                  </div>
                )}
                {/* While a calculation runs the numbers below are about to change. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: busy ? 0.5 : 1, transition: 'opacity 0.2s' }}>
                  <MetricsSummary
                    tasks={tasksDB}
                    staffList={currentStaff}
                    selectedDate={selectedDate}
                    distanceResolver={distanceResolver}
                    isDark={isDark}
                    calculated={calculated}
                    running={busy}
                  />
                  <PlanReport
                    isDark={isDark}
                    quality={dataQuality}
                    stats={planStats && planStats.selectedDate === selectedDate ? planStats : null}
                  />
                </div>
                <Collapse
                  items={collapseItems}
                  activeKey={openPanels}
                  onChange={keys => setOpenPanels(Array.isArray(keys) ? keys : [keys])}
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
          title={<span style={{ color: statusColor(isDark, 'danger') }}>⚠️ Конфликт расписания</span>}
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
                    <b>{c.name}</b> · {fmtTime(c.start)}–{fmtTime(c.end)} · рейс <span title={c.flight}>{shortFlight(c.flight)}</span>
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
