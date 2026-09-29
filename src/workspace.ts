/** Shared application services. UI and WebMCP call these exact methods. */
export type Period = { start: string; end: string };
export type Filters = { store_ids: string[]; category_ids: string[]; product_ids: string[] };
export type Metric = 'net_sales' | 'gross_profit' | 'units' | 'gross_margin' | 'avg_unit_price';
export type Group = 'store' | 'category' | 'product';
export type ViewType = 'table' | 'bar';
export type State = { base_period: Period; target_period: Period; metric: Metric; group_by: Group; filters: Filters };
export type QueryArgs = Partial<State> & { context_id: string; limit?: number };
export type Row = { id: string; label: string; base?: number | null; target?: number | null; delta?: number | null; change_rate?: number | null; net_delta_share?: number | null; value?: number | null };
export type Result = { ok: true; result_id: string; query_hash: string; query: State & { context_id: string; kind: 'compare' | 'query'; limit: number }; rows: Row[]; totals: Omit<Row, 'id' | 'label'>; warnings: string[]; truncated: boolean; other_totals: Record<string, number> | null; dataset_snapshot_id: string; metric_definition_version: string; data_through: string; timezone: string; unit: string; duration_ms: number };
export type Session = { csrf: string; allowed_store_ids: string[]; dataset_snapshot_id: string; data_through: string; business_as_of: string; base_period: Period; target_period: Period; categories: Record<string, string>; products: Record<string, { category_id: string; name: string }>; metrics: Record<Metric, string> };
export type Context = State & { context_id: string; view_version: number; dataset_snapshot_id: string; business_as_of: string; data_through: string; allowed_store_ids: string[]; categories: Session['categories']; products: Session['products']; metrics: Session['metrics']; current_result_id: string | null };
export type DraftArgs = { result_ids: string[]; title: string; notes: string; idempotency_key: string };
export type Draft = { draft_id: string; title: string; text: string; result_ids: string[]; saved: false };
export type Trace = { sequence: number; at: string; route: string; action: string; outcome: string; view_version: number; result_id?: string; elapsed_ms: number };
export class AppError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function check(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('CANCELLED', '処理を取り消しました。');
}
const clone = <T>(x: T): T => structuredClone(x);
export type Api = (path: string, body: unknown, signal?: AbortSignal) => Promise<Result>;
export type Render = () => void;

export class Workspace {
  state: State;
  version = 1;
  displayed: Result | null = null;
  viewType: ViewType = 'bar';
  drafts: Draft[] = [];
  trace: Trace[] = [];
  readonly pageId = crypto.randomUUID();
  private sequence = 0;
  private contexts = new Map<string, { version: number; state: State }>();
  private results = new Map<string, { version: number; queryHash: string }>();
  private history: { state: State; displayed: Result | null; viewType: ViewType }[] = [];
  private keys = new Map<string, { payload: string; draftId: string }>();
  private active = new Set<AbortController>();
  constructor(public session: Session, public api: Api, public render: Render = () => {}) {
    this.state = { base_period: clone(session.base_period), target_period: clone(session.target_period),
      metric: 'net_sales', group_by: 'store', filters: { store_ids: [...session.allowed_store_ids], category_ids: [], product_ids: [] } };
  }
  get pendingCount(): number { return this.active.size; }
  private boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
    map.set(key, value);
    while (map.size > 100) { const first = map.keys().next(); if (!first.done) map.delete(first.value); }
  }
  record(route: string, action: string, outcome: string, elapsed = 0, resultId?: string): void {
    this.trace.push({ sequence: ++this.sequence, at: new Date().toISOString(), route, action, outcome, view_version: this.version,
      result_id: resultId, elapsed_ms: Math.round(elapsed * 1000) / 1000 });
    if (this.trace.length > 200) this.trace.shift();
  }
  context(): Context {
    const context_id = `ctx_${this.pageId}_${this.version}`;
    this.boundedSet(this.contexts, context_id, { version: this.version, state: clone(this.state) });
    return { ...clone(this.state), context_id, view_version: this.version,
      dataset_snapshot_id: this.session.dataset_snapshot_id, business_as_of: this.session.business_as_of,
      data_through: this.session.data_through, allowed_store_ids: [...this.session.allowed_store_ids],
      categories: clone(this.session.categories), products: clone(this.session.products), metrics: clone(this.session.metrics),
      current_result_id: this.displayed?.result_id ?? null };
  }
  private remember(): void {
    this.history.push({ state: clone(this.state), displayed: clone(this.displayed), viewType: this.viewType });
    if (this.history.length > 50) this.history.shift();
  }
  humanChange(next: State): void {
    this.remember(); this.state = clone(next); this.version++; this.displayed = null;
    this.record('manual', 'change_conditions', 'OK'); this.render();
  }
  undo(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.state = previous.state; this.displayed = previous.displayed; this.viewType = previous.viewType;
    this.version++; // Never restore an old version number: prevents ABA-style stale commits.
    this.record('manual', 'undo', 'OK'); this.render();
  }
  cancelAll(): void {
    for (const controller of this.active) controller.abort();
    this.record('manual', 'cancel', 'REQUESTED'); this.render();
  }
  async run<T>(name: string, route: string, fn: (signal: AbortSignal) => Promise<T>, outer?: AbortSignal): Promise<T> {
    cancelled(outer);
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer?.addEventListener('abort', abort, { once: true });
    this.active.add(controller);
    const started = performance.now();
    this.render();
    try {
      const out = await fn(controller.signal);
      // For state mutations, the commit check is inside the method; cancellation after commit is not rollback.
      const resultId = out && typeof out === 'object' && 'result_id' in out && typeof out.result_id === 'string' ? out.result_id : undefined;
      this.record(route, name, 'OK', performance.now() - started, resultId);
      return out;
    } catch (error) {
      const e = error instanceof AppError ? error : (controller.signal.aborted ? new AppError('CANCELLED', '処理を取り消しました。') : new AppError('FAILED', error instanceof Error ? error.message : '失敗しました。'));
      this.record(route, name, e.code, performance.now() - started);
      throw e;
    } finally {
      outer?.removeEventListener('abort', abort); this.active.delete(controller); this.render();
    }
  }
  async query(args: QueryArgs, kind: 'compare' | 'query', signal?: AbortSignal): Promise<Result> {
    cancelled(signal);
    const snapshot = this.contexts.get(args.context_id);
    check(snapshot && snapshot.version === this.version, 'STALE_CONTEXT', '画面条件が変わりました。get_analysis_context で読み直してください。');
    const fixed = clone(snapshot);
    const body = { ...fixed.state, ...clone(args), filters: clone(args.filters ?? fixed.state.filters), limit: args.limit ?? 100 };
    const result = await this.api(kind === 'compare' ? '/api/compare' : '/api/query', body, signal);
    cancelled(signal);
    this.boundedSet(this.results, result.result_id, { version: fixed.version, queryHash: result.query_hash });
    return clone(result); // Does not change visible filters or output.
  }
  async present(args: { result_id: string; expected_view_version: number; view_type: ViewType }, signal?: AbortSignal): Promise<{ ok: true; result_id: string; view_version: number }> {
    cancelled(signal);
    const guard = () => {
      const ref = this.results.get(args.result_id);
      check(ref, 'RESULT_EXPIRED', 'このページの結果参照がありません。再集計してください。');
      check(args.expected_view_version === this.version && ref.version === this.version,
        'VIEW_CHANGED', '人または別の操作が画面を変更しました。古い結果は表示しません。条件を再取得して再集計してください。');
      return ref;
    };
    const before = guard();
    const result = await this.api('/api/result', { result_id: args.result_id }, signal); // Reauthorize server-side.
    cancelled(signal); guard(); // Recheck after awaiting network; closes time-of-check/time-of-use gap.
    check(result.query_hash === before.queryHash, 'RESULT_EXPIRED', '結果の版が一致しません。');
    this.remember();
    const q = result.query;
    this.state = { base_period: clone(q.base_period ?? this.state.base_period), target_period: clone(q.target_period),
      metric: q.metric, group_by: q.group_by, filters: clone(q.filters) };
    this.displayed = clone(result); this.viewType = args.view_type; this.version++;
    this.render(); // Synchronous DOM renderer finishes before this tool returns success.
    return { ok: true, result_id: result.result_id, view_version: this.version };
  }
  async createDraft(args: DraftArgs, signal?: AbortSignal): Promise<{ ok: true; draft_id: string; saved: false; reused: boolean }> {
    cancelled(signal);
    const payload = JSON.stringify({ result_ids: args.result_ids, title: args.title, notes: args.notes });
    const prior = () => {
      const p = this.keys.get(args.idempotency_key);
      if (p) check(p.payload === payload, 'IDEMPOTENCY_CONFLICT', '同じキーで異なる下書きは作れません。');
      return p;
    };
    prior();
    const results: Result[] = [];
    for (const rid of args.result_ids) {
      check(this.results.has(rid), 'RESULT_EXPIRED', 'このページの結果参照がありません。');
      results.push(await this.api('/api/result', { result_id: rid }, signal));
    }
    cancelled(signal);
    const existing = prior(); // Recheck after awaits; concurrent retries create only one draft.
    if (existing) return { ok: true, draft_id: existing.draftId, saved: false, reused: true };
    check(this.drafts.length < 50, 'QUERY_LIMIT_EXCEEDED', '下書きは50件までです。');
    const names: Record<Metric, string> = { net_sales: '売上', gross_profit: '粗利額', units: '販売数量', gross_margin: '粗利率', avg_unit_price: '平均販売単価' };
    const facts = results.map(r => {
      const q = r.query;
      const format = (n: number | null | undefined, delta = false): string => n == null ? '算出不可' : q.metric === 'gross_margin' ? `${(n * 100).toFixed(2)}${delta ? 'ポイント' : '%'}` : `${n.toLocaleString('ja-JP', { maximumFractionDigits: 2 })}${r.unit}`;
      const periods = q.kind === 'compare' ? `${q.base_period.start}〜${q.base_period.end} → ${q.target_period.start}〜${q.target_period.end}` : `${q.target_period.start}〜${q.target_period.end}`;
      const describe = (row: Omit<Row, 'id' | 'label'>): string => q.kind === 'compare' ? `${format(row.base)} → ${format(row.target)}（増減 ${format(row.delta, true)}）` : format(row.value);
      const filters = [q.filters.store_ids.join('・'), ...q.filters.category_ids.map(id => this.session.categories[id] ?? id), ...q.filters.product_ids.map(id => this.session.products[id]?.name ?? id)].join(' / ');
      return `${names[q.metric]} / ${filters}\n${periods}\n合計：${describe(r.totals)}\n\n${r.rows.map(row => `${row.label}：${describe(row)}`).join('\n')}${r.truncated ? '\n※一部の内訳を省略。合計は全件です。' : ''}`;
    }).join('\n\n');
    const draft: Draft = { draft_id: 'd_' + crypto.randomUUID(), title: args.title, saved: false, result_ids: [...args.result_ids],
      text: `${args.title}\n\n${facts}${args.notes ? `\n\nメモ（集計では未検証）\n${args.notes}` : ''}\n\n補足\n天候・在庫・販促・来店人数は集計に含まれていません。増減の原因は未確認です。` };
    this.drafts.push(draft); this.keys.set(args.idempotency_key, { payload, draftId: draft.draft_id });
    this.render();
    return { ok: true, draft_id: draft.draft_id, saved: false, reused: false };
  }
  editDraft(id: string, text: string): void {
    const draft = this.drafts.find(d => d.draft_id === id);
    check(draft, 'NOT_FOUND', '下書きがありません。');
    draft.text = text; // Tool cannot edit existing drafts, so human text is never replaced.
  }
}
