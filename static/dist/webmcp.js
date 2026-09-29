import { AppError, cancelled } from './workspace.js';
const string = (maxLength = 128) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const list = (min = 0, max = 20) => ({ type: 'array', items: string(), minItems: min, maxItems: max });
const per = object({ start: string(10), end: string(10) });
const filter = object({ store_ids: { ...list(1, 10), description: '1件以上。現在条件は get_analysis_context から取得。' }, category_ids: { ...list(), description: '空配列は選択店舗の全カテゴリ。' }, product_ids: { ...list(), description: '空配列は選択カテゴリの全商品。' } }, ['store_ids']);
const query = object({ context_id: string(), base_period: per, target_period: per,
    metric: { type: 'string', enum: ['net_sales', 'gross_profit', 'units', 'gross_margin', 'avg_unit_price'] },
    group_by: { type: 'string', enum: ['store', 'category', 'product'] }, filters: filter,
    limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['context_id']);
/** Small validator for exactly the schema subset used here, not a general JSON Schema library. */
export function validate(schema, input, path = '$') {
    const bad = (text) => { throw new AppError('INVALID_ARGUMENT', `${path}: ${text}`); };
    if (schema.type === 'object') {
        if (input === null || typeof input !== 'object' || Array.isArray(input))
            bad('object が必要です。');
        const obj = input;
        for (const required of schema.required ?? [])
            if (!(required in obj))
                bad(`${required} が必要です。`);
        for (const key of Object.keys(obj)) {
            const child = schema.properties?.[key];
            if (child)
                validate(child, obj[key], `${path}.${key}`);
            else
                bad(`${key} は未対応です。`);
        }
    }
    else if (schema.type === 'string') {
        if (typeof input !== 'string')
            bad('string が必要です。');
        const text = input;
        if (text.length < (schema.minLength ?? 0) || text.length > (schema.maxLength ?? Infinity))
            bad('文字数が範囲外です。');
        if (schema.enum && !schema.enum.includes(text))
            bad('許可されていない値です。');
    }
    else if (schema.type === 'integer') {
        if (typeof input !== 'number' || !Number.isInteger(input))
            bad('integer が必要です。');
        const n = input;
        if (n < (schema.minimum ?? -Infinity) || n > (schema.maximum ?? Infinity))
            bad('数値が範囲外です。');
    }
    else {
        if (!Array.isArray(input))
            bad('array が必要です。');
        const array = input;
        if (array.length < (schema.minItems ?? 0) || array.length > (schema.maxItems ?? Infinity))
            bad('配列件数が範囲外です。');
        if (schema.items)
            array.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
    }
}
export function definitions(workspace, route = 'webmcp-handler') {
    const tool = (name, description, inputSchema, readOnlyHint, action, untrustedContentHint = false) => ({
        name, description, inputSchema, annotations: { readOnlyHint, untrustedContentHint },
        execute: async (input, options) => {
            try {
                validate(inputSchema, input);
                return await workspace.run(name, route, async (signal) => { cancelled(signal); return action(input, signal); }, options?.signal);
            }
            catch (error) {
                const e = error instanceof AppError ? error : new AppError('FAILED', error instanceof Error ? error.message : '処理失敗');
                return { ok: false, error: { code: e.code, message: e.message } };
            }
        }
    });
    return [
        tool('get_analysis_context', '現在の店舗・期間・指標・集計軸、画面版、データ版と参照可能範囲を取得します。分析前および人が条件を変えた後に使います。', object({}), true, async () => workspace.context()),
        tool('compare_periods', '2期間の値・差分・増減率を店舗別、カテゴリ別または商品別に比較します。省略した条件は context_id の画面条件を引き継ぎます。画面は変更しません。表示は present_result で行います。', query, true, async (args, signal) => workspace.query(args, 'compare', signal)),
        tool('query_metrics', '指定期間の売上、粗利、数量または比率を集計します。省略した条件は context_id の画面条件を使います。比率は分子・分母を再集計します。画面は変更しません。', query, true, async (args, signal) => workspace.query(args, 'query', signal)),
        tool('present_result', '取得済みの結果を条件・表・グラフと一緒に表示します。可逆な画面変更です。画面が変わった場合は古い結果を拒否します。VIEW_CHANGED の後は条件取得・再集計が必要です。', object({ result_id: string(), expected_view_version: { type: 'integer', minimum: 1 }, view_type: { type: 'string', enum: ['table', 'bar'] } }), false, async (args, signal) => workspace.present(args, signal)),
        tool('create_report_draft', '集計結果を根拠として、新しい未保存のレポート下書きをページ内に作ります。既存の下書きは編集しません。保存・共有・送信は行いません。同じキー・同じ内容の再実行は重複しません。', object({ result_ids: list(1, 5), title: string(100), notes: { type: 'string', maxLength: 2000 }, idempotency_key: string(128) }), false, async (args, signal) => workspace.createDraft(args, signal), true)
    ];
}
export function getNativeContext() {
    // No navigator fallback, shim, global reassignment, or polyfill: absence remains visible.
    const mc = document.modelContext;
    return mc && typeof mc.registerTool === 'function' ? mc : undefined;
}
export async function register(workspace, enabled, lifetime) {
    if (!enabled)
        return { status: 'disabled', registered: [], details: 'WebMCP登録は無効。通常UIは使用できます。' };
    const mc = getNativeContext();
    if (!mc)
        return { status: 'unsupported', registered: [], details: 'document.modelContext.registerTool を検出できません。通常UIと共通処理テストのみ利用できます。' };
    const names = [];
    try {
        for (const tool of definitions(workspace)) {
            await mc.registerTool(tool, { signal: lifetime.signal });
            names.push(tool.name);
        }
        return { status: 'registered', registered: names, details: `${names.length}ツールを登録。登録成功は、エージェント実行成功を意味しません。` };
    }
    catch (error) {
        lifetime.abort();
        return { status: 'registration_failed', registered: [], details: `登録失敗（部分登録解除を要求済み）: ${error instanceof Error ? error.message : '不明'}` };
    }
}
export async function executeNative(mc, tool, args, transport) {
    if (!mc.executeTool)
        throw new AppError('UNSUPPORTED', 'ネイティブ実行APIがありません。');
    const result = await mc.executeTool(tool, transport === 'chrome154-json' ? JSON.stringify(args) : args);
    if (typeof result === 'string') {
        try {
            return JSON.parse(result);
        }
        catch {
            return result;
        }
    }
    return result;
}
