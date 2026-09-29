import { executeNative, NativeTransport } from './webmcp.js';
import { Workspace, AppError, Session, State, Result, Metric, Group, Row, cancelled } from './workspace.js';
import { definitions, getNativeContext, register, Capability } from './webmcp.js';
const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing element: ${id}`); return element as T;
};
const setText = (id: string, text: string) => { el(id).textContent = text; };
const option = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
function notice(message: string, error = false): void {
  const conflict = message.includes('VIEW_CHANGED') || message.includes('STALE_CONTEXT');
  setText('notice', conflict ? '条件が変わったため、前の結果は表示していません。' : message.includes('CANCELLED') ? '集計を中止しました。' : message);
  el('notice').dataset.error = String(error);
  el('retry').hidden = !conflict;
}
function errorMessage(error: unknown): string { return error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error); }
function number(n: number | null | undefined, metric: string): string {
  if (n === null || n === undefined) return '—';
  return metric === 'gross_margin' ? `${(n * 100).toFixed(2)}%` : n.toLocaleString('ja-JP', { maximumFractionDigits: 2 });
}
let workspace: Workspace;
let observedTrace = 0;
let capability: Capability;
let lastContext: ReturnType<Workspace['context']> | undefined;
let lastResult: Result | undefined;
const lifetime = new AbortController();
const metricNames: Record<Metric, string> = { net_sales: '売上', gross_profit: '粗利額', units: '販売数量', gross_margin: '粗利率', avg_unit_price: '平均販売単価' };
const groupNames: Record<Group, string> = { store: '店舗別', category: 'カテゴリ別', product: '商品別' };
function difference(value: number | null | undefined, metric: Metric): string {
  if (value == null) return '—';
  const formatted = metric === 'gross_margin' ? `${(value * 100).toFixed(2)} pt` : number(value, metric);
  return value > 0 ? `+${formatted}` : formatted;
}

function render(): void {
  if (!workspace) return;
  const s = workspace.state;
  for (const [id, value] of [['base-start', s.base_period.start], ['base-end', s.base_period.end], ['target-start', s.target_period.start], ['target-end', s.target_period.end], ['metric', s.metric], ['group', s.group_by], ['category', s.filters.category_ids[0] ?? ''], ['product', s.filters.product_ids[0] ?? '']]) el<HTMLInputElement>(id).value = value;
  for (const o of el<HTMLSelectElement>('stores').options) o.selected = s.filters.store_ids.includes(o.value);
  setText('view-version', String(workspace.version));
  el<HTMLButtonElement>('cancel').disabled = workspace.pendingCount === 0;
  setText('activity', workspace.pendingCount ? '集計中…' : '');
  el('kpis').setAttribute('aria-busy', String(workspace.pendingCount > 0));
  setText('draft-link', workspace.drafts.length ? `未保存の下書き ${workspace.drafts.length}件` : '下書き 0件');
  el('draft-link').classList.toggle('has-drafts', workspace.drafts.length > 0);
  el<HTMLButtonElement>('create-draft').disabled = !workspace.displayed;
  const result = workspace.displayed;
  const kpis = el('kpis'), chart = el('chart'), tableWrap = el('table-wrap');
  kpis.replaceChildren(); chart.replaceChildren(); tableWrap.replaceChildren();
  if (result) {
    const q = result.query;
    const stores = q.filters.store_ids.length === workspace.session.allowed_store_ids.length && q.filters.store_ids.length > 1 ? `全${q.filters.store_ids.length}店舗` : q.filters.store_ids.join('・');
    const category = q.filters.category_ids.map(id => workspace.session.categories[id]).join('・');
    const products = q.filters.product_ids.map(id => workspace.session.products[id]?.name ?? id).join('・');
    setText('result-provenance', `${metricNames[q.metric]} · ${stores}${category ? ` / ${category}` : ''}${products ? ` / ${products}` : ''} · ${groupNames[q.group_by]}\n${q.kind === 'compare' ? `${q.base_period.start}〜${q.base_period.end} → ` : ''}${q.target_period.start}〜${q.target_period.end}`);
    setText('result-detail', JSON.stringify({ result_id: result.result_id, query_hash: result.query_hash, dataset_snapshot_id: result.dataset_snapshot_id, query: q }, null, 2));
    setText('chart-title', q.kind === 'compare' ? `比較期間からの増減（${q.metric === 'gross_margin' ? 'ポイント' : result.unit}）` : `対象期間の${metricNames[q.metric]}（${result.unit}）`);
    const cards: [string, number | null | undefined][] = q.kind === 'compare' ? [['比較期間', result.totals.base], ['対象期間', result.totals.target], ['増減', result.totals.delta]] : [['対象期間', result.totals.value]];
    for (const [label, value] of cards) {
      const box = document.createElement('div'); box.className = 'kpi';
      const isDelta = label === '増減';
      const a = document.createElement('span'); a.textContent = `${label}（${isDelta && q.metric === 'gross_margin' ? 'ポイント' : result.unit}）`;
      const b = document.createElement('strong'); b.textContent = isDelta ? difference(value, q.metric).replace(' pt', '') : number(value, q.metric); box.append(a, b);
      if (isDelta) {
        const description = document.createElement('em');
        description.textContent = value == null ? '算出できません' : value === 0 ? '増減なし' : `${value < 0 ? '減少' : '増加'}${result.totals.change_rate == null ? ' · 増減率は算出不可' : ` ${Math.abs(result.totals.change_rate * 100).toFixed(2)}%`}`;
        box.classList.add(value != null && value < 0 ? 'negative' : value != null && value > 0 ? 'positive' : 'unchanged');
        box.append(description);
      }
      kpis.append(box);
    }
    const values = result.rows.map(r => q.kind === 'compare' ? r.delta : r.value);
    const max = Math.max(1, ...values.map(v => Math.abs(v ?? 0)));
    if (workspace.viewType === 'bar') for (const [index, row] of result.rows.entries()) {
      const v = values[index]; const wrap = document.createElement('div'); wrap.className = 'bar-row';
      const label = document.createElement('div'); label.className = 'bar-label'; const name = document.createElement('span'); name.textContent = row.label;
      const value = document.createElement('span'); value.textContent = q.kind === 'compare' ? difference(v, q.metric) : number(v, q.metric); label.append(name, value);
      const track = document.createElement('div'); track.className = 'bar-track'; const fill = document.createElement('div'); fill.className = 'bar-fill' + ((v ?? 0) < 0 ? ' negative' : ''); fill.style.width = `${Math.abs(v ?? 0) / max * 100}%`; track.append(fill); wrap.append(label, track); chart.append(wrap);
    }
    const table = document.createElement('table');
    const fields: (keyof Row)[] = q.kind === 'compare' ? ['label', 'base', 'target', 'delta', 'change_rate'] : ['label', 'value'];
    const names = q.kind === 'compare' ? ['対象', '比較期間', '対象期間', '増減', '増減率'] : ['対象', '値'];
    const head = document.createElement('thead'), hr = document.createElement('tr');
    for (const name of names) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = name; hr.append(cell); } head.append(hr);
    const body = document.createElement('tbody');
    for (const row of result.rows) { const tr = document.createElement('tr'); tr.dataset.rowId = row.id; for (const f of fields) { const td = document.createElement('td'); const value = row[f]; td.textContent = typeof value === 'string' ? value : f === 'change_rate' ? number(value, 'gross_margin') : f === 'delta' ? difference(value, q.metric) : number(value, q.metric); if (f === 'delta') { td.classList.add('delta'); if (typeof value === 'number' && value !== 0) td.classList.add(value < 0 ? 'negative' : 'positive'); } tr.append(td); } body.append(tr); }
    table.append(head, body); tableWrap.append(table);
    setText('warnings', [...result.warnings.map(w => w === '差分寄与は構成上の内訳であり、原因の証明ではありません。' ? '増減の内訳から、原因までは判断できません。' : w), ...(result.truncated ? ['表示行は一部です。KPI合計は全対象範囲を集計しています。'] : [])].join('\n'));
  } else {
    setText('result-provenance', '条件を選んで「比較する」を押してください。'); setText('warnings', ''); setText('chart-title', ''); setText('result-detail', '未表示');
  }
  el('draft-empty').hidden = workspace.drafts.length > 0;
  for (const draft of workspace.drafts) {
    let block = document.getElementById(draft.draft_id);
    if (!block) {
      block = document.createElement('div'); block.id = draft.draft_id; block.className = 'draft'; const heading = document.createElement('h3'); heading.textContent = draft.title;
      const area = document.createElement('textarea'); area.setAttribute('aria-label', `下書き ${draft.title}`); area.addEventListener('input', () => workspace.editDraft(draft.draft_id, area.value)); const source = document.createElement('details'); source.className = 'draft-source'; const summary = document.createElement('summary'); summary.textContent = '参照した集計'; const ids = document.createElement('p'); ids.textContent = draft.result_ids.join(' / '); source.append(summary, ids); block.append(heading, area, source); el('drafts').append(block);
    }
    const area = block.querySelector('textarea')!; if (area.value !== draft.text) area.value = draft.text;
  }
  setText('trace', JSON.stringify(workspace.trace, null, 2));
  const latest = workspace.trace.at(-1);
  if (latest && latest.sequence > observedTrace) {
    observedTrace = latest.sequence;
    if (['VIEW_CHANGED', 'STALE_CONTEXT', 'CANCELLED'].includes(latest.outcome)) notice(latest.outcome, true);
    else if (latest.action === 'present_result' && latest.outcome === 'OK') notice('集計しました。');
  }
}
function readControls(): State {
  const value = (id: string) => el<HTMLInputElement>(id).value;
  return { base_period: { start: value('base-start'), end: value('base-end') }, target_period: { start: value('target-start'), end: value('target-end') }, metric: value('metric') as Metric, group_by: value('group') as Group,
    filters: { store_ids: [...el<HTMLSelectElement>('stores').selectedOptions].map(o => o.value), category_ids: value('category') ? [value('category')] : [], product_ids: value('product') ? [value('product')] : [] } };
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    cancelled(signal); const onAbort = () => { clearTimeout(timer); reject(new AppError('CANCELLED', '取り消しました。')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
async function manual(kind: 'compare' | 'query', race = false): Promise<void> {
  try {
    const ctx = workspace.context();
    await workspace.run(race ? 'manual_race' : `manual_${kind}`, 'manual', async signal => {
      const result = await workspace.query({ context_id: ctx.context_id }, kind, signal); lastResult = result;
      if (race) { notice('3秒保留中です。いま店舗または指標を変えると、古い結果の表示を拒否します。'); await delay(3000, signal); }
      return workspace.present({ result_id: result.result_id, expected_view_version: ctx.view_version, view_type: 'bar' }, signal);
    });
    notice('集計しました。');
  } catch (error) { notice(errorMessage(error), true); }
}
function output(value: unknown): void {
  setText('tool-output', JSON.stringify(value, null, 2));
  if (value && typeof value === 'object') {
    if ('context_id' in value && 'view_version' in value) lastContext = value as ReturnType<Workspace['context']>;
    if ('result_id' in value && 'rows' in value) lastResult = value as Result;
  }
}
async function start(): Promise<void> {
  const response = await fetch('/api/session', { credentials: 'same-origin' });
  const session = await response.json() as Session;
  if (!response.ok) throw new Error('セッションの初期化に失敗しました。');
  workspace = new Workspace(session, async (path, body, signal) => {
    cancelled(signal);
    const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify(body), signal });
    const data = await r.json();
    if (!r.ok || data.ok === false) throw new AppError(data.error?.code ?? 'FAILED', data.error?.message ?? 'API処理失敗');
    return data as Result;
  }, render);
  for (const id of session.allowed_store_ids) el('stores').append(option(id, id));
  for (const [id, name] of Object.entries(session.categories)) el('category').append(option(id, name));
  for (const [id, info] of Object.entries(session.products)) el('product').append(option(id, info.name));
  for (const id of ['stores', 'base-start', 'base-end', 'target-start', 'target-end', 'metric', 'group', 'category', 'product']) {
    el(id).addEventListener('change', () => {
      if (id === 'category') el<HTMLSelectElement>('product').value = '';
      if (id === 'product') { const p = el<HTMLSelectElement>('product').value; if (p) el<HTMLSelectElement>('category').value = session.products[p].category_id; }
      workspace.humanChange(readControls()); notice('条件を変更しました。再集計すると結果が表示されます。');
    });
  }
  el('weekly').onclick = () => { workspace.humanChange({ ...workspace.state, base_period: session.base_period, target_period: session.target_period }); notice('8/31〜9/6と9/7〜9/13を比較します。'); };
  el('monthly').onclick = () => { workspace.humanChange({ ...workspace.state, base_period: { start: '2026-07-01', end: '2026-07-31' }, target_period: { start: '2026-08-01', end: '2026-08-31' } }); notice('7月と8月を比較します。'); };
  el('compare').onclick = () => { void manual('compare'); };
  el('retry').onclick = () => { void manual('compare'); };
  el('query').onclick = () => { void manual('query'); };
  el('race').onclick = () => { void manual('compare', true); };
  el('cancel').onclick = () => workspace.cancelAll();
  el('undo').onclick = () => workspace.undo();
  el('create-draft').onclick = async () => {
    if (!workspace.displayed) return;
    try { await workspace.run('create_report_draft', 'manual', signal => workspace.createDraft({ result_ids: [workspace.displayed!.result_id], title: `${metricNames[workspace.displayed!.query.metric]}の集計メモ`, notes: '', idempotency_key: crypto.randomUUID() }, signal)); notice('下書きを追加しました。'); }
    catch (error) { notice(errorMessage(error), true); }
  };
  const local = definitions(workspace, 'local-test');
  for (const tool of local) el('tool-select').append(option(tool.name, tool.name));
  el('sample-input').onclick = () => {
    const name = el<HTMLSelectElement>('tool-select').value;
    lastContext = workspace.context();
    const example = name === 'get_analysis_context' ? {} : name === 'present_result' ? { result_id: lastResult?.result_id ?? '先に集計してください', expected_view_version: lastContext.view_version, view_type: 'bar' } : name === 'create_report_draft' ? { result_ids: [lastResult?.result_id ?? '先に集計してください'], title: '比較レポート', notes: '', idempotency_key: crypto.randomUUID() } : { context_id: lastContext.context_id };
    el<HTMLTextAreaElement>('tool-input').value = JSON.stringify(example, null, 2);
  };
  el('local-run').onclick = async () => {
    try { const tool = local.find(t => t.name === el<HTMLSelectElement>('tool-select').value)!; output(await tool.execute(JSON.parse(el<HTMLTextAreaElement>('tool-input').value))); notice('共通処理の直接呼出しです。WebMCP統合検証ではありません。'); }
    catch (error) { notice(errorMessage(error), true); }
  };
  el('native-list').onclick = async () => {
    try { const mc = getNativeContext(); if (!mc?.getTools) throw new AppError('UNSUPPORTED', '現行の getTools API がありません。Chrome版・フラグを確認してください。');
      const tools = await mc.getTools(); output(tools.map(t => ({ name: t.name }))); }
    catch (error) { notice(errorMessage(error), true); }
  };
  el('native-run').onclick = async () => {
    try {
      const mc = getNativeContext(); if (!mc?.getTools || !mc.executeTool) throw new AppError('UNSUPPORTED', '現行の発見・実行APIがありません。対応クライアントまたはInspectorで検証してください。');
      const tools = await mc.getTools(); const tool = tools.find(t => t.name === el<HTMLSelectElement>('tool-select').value);
      if (!tool) throw new AppError('NOT_FOUND', '選択したツールはネイティブ一覧にありません。');
      const transport = el<HTMLSelectElement>('native-transport').value as NativeTransport;
      output(await executeNative(mc, tool, JSON.parse(el<HTMLTextAreaElement>('tool-input').value), transport));
      notice('ネイティブAPIを呼び出しました。返却値を確認してください。これはLLMによる自然言語操作ではありません。');
    } catch (error) { notice(errorMessage(error), true); }
  };
  render();
  const enabled = new URLSearchParams(location.search).get('webmcp') !== 'off';
  capability = await register(workspace, enabled, lifetime);
  setText('capability', { disabled: '無効', unsupported: '現行API未検出', registered: '5ツール登録済み', registration_failed: '登録失敗' }[capability.status]);
  setText('capability-detail', capability.details);
  notice('店舗と期間を選んで集計できます。');
  // Diagnostic handle only on an explicit test URL. This is not a WebMCP shim.
  if (new URLSearchParams(location.search).get('test') === '1') {
    Object.assign(window, { retailLab: { workspace, tools: local, capability, getNativeContext } });
  }
  window.addEventListener('beforeunload', event => { if (workspace.drafts.length) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { workspace.cancelAll(); lifetime.abort(); });
}
start().catch(error => notice(errorMessage(error), true));
