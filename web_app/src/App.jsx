import { useState, useMemo, useRef, useEffect } from 'react';
import {
  ConfigProvider, Layout, Button, Select, Switch, Input,
  Checkbox, Space, Drawer, Collapse, Typography, Alert,
  Spin, Empty, theme as antdTheme, Badge, Divider, message
} from 'antd';
import {
  UploadOutlined, ThunderboltOutlined, ClearOutlined,
  MenuOutlined, BulbOutlined, BulbFilled, BarChartOutlined,
  UnorderedListOutlined, ClockCircleOutlined, RiseOutlined
} from '@ant-design/icons';
import { parseCSV } from './utils/dataParser';
import { runOptimizer, reassignDelayedConflicts } from './optimizer';
import MetricsSummary from './components/MetricsSummary';
import GanttChart from './components/GanttChart';
import BacklogPanel from './components/BacklogPanel';
import TaskDelayPanel from './components/TaskDelayPanel';
import HourlyLoadChart from './components/HourlyLoadChart';

const { Sider, Content, Header } = Layout;
const { darkAlgorithm, defaultAlgorithm } = antdTheme;
const { Text } = Typography;

function SidebarContent({
  isDark, hasData, fileRef, handleFileUpload, handleDemoLoad,
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
            🎬 Демо-данные
          </Button>
        </Space>
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
  const [selectedDate, setSelectedDate] = useState('');
  const [optimizerRan, setOptimizerRan] = useState(false);
  const [filterTypes, setFilterTypes] = useState([]);
  const [filterFlight, setFilterFlight] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isDark, setIsDark] = useState(false);
  const [mobileBroken, setMobileBroken] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fileRef = useRef();

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
  const allTaskTypes = useMemo(
    () => [...new Set(tasksDB.map(t => t.name))].sort(),
    [tasksDB]
  );
  const backlogCount = currentTasks.filter(t => t.employee === 'Не назначено').length;

  function loadData(text) {
    setIsLoading(true);
    setError(null);
    try {
      const { tasks, staffDB: db, colorMap: cm } = parseCSV(text);
      if (tasks.length === 0) throw new Error('CSV не содержит корректных данных');
      const dates = [...new Set(tasks.map(t => t.date))].sort();
      const types = [...new Set(tasks.map(t => t.name))];
      setTasksDB(tasks);
      setStaffDB(db);
      setColorMap(cm);
      setSelectedDate(dates[0]);
      setFilterTypes(types);
      setFilterFlight('');
      setOptimizerRan(false);
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

  function handleRunOptimizer() {
    const updated = runOptimizer(tasksDB, staffDB, selectedDate);
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

    const { tasks: resolved, changes } = reassignDelayedConflicts(updated, staffDB, selectedDate, delayedIds);
    updated = resolved;
    for (const c of changes) {
      if (c.backlog) {
        message.warning(`«${c.taskName}» (${c.from}): из-за задержки конфликтует с другой закреплённой задачей — свободных сотрудников нет, задача возвращена в бэклог`);
      } else {
        message.info(`«${c.taskName}»: из-за задержки переназначена с ${c.from} на ${c.to} (конфликт с закреплённой задачей)`);
      }
    }

    if (optimizerRan) updated = runOptimizer(updated, staffDB, selectedDate);
    setTasksDB(updated);
  }

  function handleAssign(taskId, employeeName, lock) {
    setTasksDB(prev =>
      prev.map(t => t.id === taskId ? { ...t, employee: employeeName, isLocked: lock } : t)
    );
  }

  function toggleType(name) {
    setFilterTypes(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  }

  const hasData = tasksDB.length > 0;

  const sidebarProps = {
    isDark, hasData, fileRef, handleFileUpload, handleDemoLoad,
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
          Оперативный план-график ({currentTasks.length} задач)
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
            tasks={tasksDB}
            colorMap={colorMap}
            selectedDate={selectedDate}
            filterTypes={filterTypes}
            filterFlight={filterFlight}
            isDark={isDark}
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
          staffList={currentStaff}
          selectedDate={selectedDate}
          colorMap={colorMap}
          onAssign={handleAssign}
          isDark={isDark}
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
        <HourlyLoadChart
          tasks={tasksDB}
          selectedDate={selectedDate}
          selectedTaskTypes={filterTypes}
          colorMap={colorMap}
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
      </Layout>
    </ConfigProvider>
  );
}
