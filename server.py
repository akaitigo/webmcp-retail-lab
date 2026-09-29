#!/usr/bin/env python3
"""Loopback-only WebMCP analytics lab. Synthetic data; never a production server.
Run: python3 server.py          Restricted role: python3 server.py --port 8766 --scope S01
Python 3.10+, standard library only. No external requests, no persistent business writes.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import secrets
import sqlite3
import threading
import time
from datetime import date, timedelta
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STORES = [f'S{i:02}' for i in range(1, 11)]
CATEGORIES = {'C01': '飲料', 'C02': '食品', 'C03': '日用品', 'C04': '菓子', 'C05': '冷凍食品', 'C06': '雑貨'}
PRODUCTS = {f'{c}-P{p}': {'category_id': c, 'name': f'{name}・商品{p}'}
            for c, name in CATEGORIES.items() for p in [1, 2]}
METRICS = {'net_sales': '円', 'gross_profit': '円', 'units': '点', 'gross_margin': '比率', 'avg_unit_price': '円/点'}
ADDITIVE = {'net_sales', 'gross_profit', 'units'}
START, END = date(2026, 6, 16), date(2026, 9, 13)
BASE = {'start': '2026-08-31', 'end': '2026-09-06'}
TARGET = {'start': '2026-09-07', 'end': '2026-09-13'}
DATASET = 'synthetic-retail-20260913-v1'
MAX_RESULT_BYTES = 65536
RESULT_TTL = 900
SESSION_TTL = 3600

class LabError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status
    def payload(self):
        return {'ok': False, 'error': {'code': self.code, 'message': self.message}}

def require(condition, message='入力条件を確認してください。', code='INVALID_ARGUMENT', status=400):
    if not condition:
        raise LabError(code, message, status)

def object_keys(value, allowed, required=()):
    require(isinstance(value, dict), 'JSON object が必要です。')
    require(not (set(value) - set(allowed)), '未対応のフィールドがあります。')
    require(set(required) <= set(value), '必須フィールドが不足しています。')

def split_exact(n: int, count: int):
    q, r = divmod(n, count)
    return [q + (i < r) for i in range(count)]

def seed_database() -> sqlite3.Connection:
    db = sqlite3.connect(':memory:', check_same_thread=False)
    db.execute('CREATE TABLE sales(business_date TEXT,store_id TEXT,category_id TEXT,product_id TEXT,net_sales INTEGER,net_cogs INTEGER,units INTEGER,PRIMARY KEY(business_date,store_id,product_id))')
    # The 90-day product-grain table rolls up to the original 5,400 category-day rows.
    rows = []
    for day in range(90):
        d = START + timedelta(days=day)
        for s, store in enumerate(STORES, 1):
            for c, category in enumerate(CATEGORIES, 1):
                amount = 100000 + s * 1200 + c * 2500 + (day % 7) * 700
                for p, share in [(1, 60), (2, 40)]:
                    revenue = amount * share // 100
                    rows.append((d.isoformat(), store, category, f'{category}-P{p}', revenue, revenue * 7 // 10, revenue // (180 + c * 20)))
    db.executemany('INSERT INTO sales VALUES (?,?,?,?,?,?,?)', rows)
    totals = {'S01': 12000000, 'S02': 12000000, 'S03': 8000000, 'S10': 8000000}
    for store in STORES:
        total = totals.get(store, 10000000)
        for target, start in [(False, date(2026, 8, 31)), (True, date(2026, 9, 7))]:
            adjusted = total + ({'S01': -700000, 'S02': 300000, 'S03': -1600000}.get(store, 0) if target else 0)
            cats = ([1800000] + [920000] * 5 if target else [3000000] + [1000000] * 5) if store == 'S03' else split_exact(adjusted, 6)
            for category, amount in zip(CATEGORIES, cats):
                units = (8000 if target else 10000) if store == 'S03' and category == 'C01' else amount // 250
                margin_pct = 22 if target and store == 'S03' and category == 'C01' else 30
                cost = amount * (100 - margin_pct) // 100
                day_amounts, day_costs, day_units = split_exact(amount, 7), split_exact(cost, 7), split_exact(units, 7)
                for day in range(7):
                    # Both products remain positive. Product-level comparison is an explicit extension.
                    a, co, un = day_amounts[day], day_costs[day], day_units[day]
                    for p in [1, 2]:
                        def part(n): return n * 6 // 10 if p == 1 else n - n * 6 // 10
                        db.execute('UPDATE sales SET net_sales=?,net_cogs=?,units=? WHERE business_date=? AND store_id=? AND product_id=?',
                                   (part(a), part(co), part(un), (start + timedelta(days=day)).isoformat(), store, f'{category}-P{p}'))
    db.commit()
    db.execute('PRAGMA query_only=ON')
    return db

def period(raw):
    object_keys(raw, ['start', 'end'], ['start', 'end'])
    try:
        require(isinstance(raw['start'], str) and isinstance(raw['end'], str))
        start, end = date.fromisoformat(raw['start']), date.fromisoformat(raw['end'])
        require(start.isoformat() == raw['start'] and end.isoformat() == raw['end'])
    except (ValueError, TypeError):
        raise LabError('INVALID_ARGUMENT', '日付は有効な YYYY-MM-DD で指定してください。')
    require(start <= end, '開始日が終了日より後です。')
    require((end - start).days < 90, '照会期間は90日以内です。', 'QUERY_LIMIT_EXCEEDED')
    require(start >= START and end <= END, '要求期間には未収録または未確定の日付が含まれます。ゼロには置換しません。', 'NO_DATA')
    return {'start': start.isoformat(), 'end': end.isoformat()}

def filters(raw, allowed_stores):
    object_keys(raw, ['store_ids', 'category_ids', 'product_ids'], ['store_ids'])
    result = {}
    for key, catalog in [('store_ids', STORES), ('category_ids', CATEGORIES), ('product_ids', PRODUCTS)]:
        values = raw.get(key, [])
        require(isinstance(values, list) and len(values) <= 20 and all(isinstance(v, str) for v in values))
        require(len(set(values)) == len(values), '同じIDを重複指定できません。')
        if key == 'store_ids':
            require(bool(values), '店舗は1件以上、明示的に指定してください。')
            require(set(values) <= set(allowed_stores), '指定された範囲は参照できません。', 'FORBIDDEN', 403)
        else:
            require(set(values) <= set(catalog), 'フィルターに未対応のIDがあります。')
        result[key] = sorted(values)
    if result['product_ids'] and result['category_ids']:
        require(all(PRODUCTS[p]['category_id'] in result['category_ids'] for p in result['product_ids']), '商品とカテゴリの条件が矛盾しています。')
    return result

def normalized_query(raw, allowed_stores, kind):
    object_keys(raw, ['context_id', 'base_period', 'target_period', 'metric', 'group_by', 'filters', 'limit', 'kind'],
                ['context_id', 'target_period', 'metric', 'group_by', 'filters'])
    require(isinstance(raw['context_id'], str) and 1 <= len(raw['context_id']) <= 128)
    require(isinstance(raw['metric'], str) and raw['metric'] in METRICS, '未対応の指標です。')
    require(isinstance(raw['group_by'], str) and raw['group_by'] in ['store', 'category', 'product'], '未対応の集計軸です。')
    limit = raw.get('limit', 100)
    require(type(limit) is int and 1 <= limit <= 100, 'limit は1～100の整数です。', 'QUERY_LIMIT_EXCEEDED')
    q = {'context_id': raw['context_id'], 'kind': kind, 'target_period': period(raw['target_period']),
         'metric': raw['metric'], 'group_by': raw['group_by'], 'filters': filters(raw['filters'], allowed_stores), 'limit': limit}
    if kind == 'compare':
        require('base_period' in raw)
        q['base_period'] = period(raw['base_period'])
    return q

def metric_value(sales: int, costs: int, units: int, metric: str):
    if metric == 'net_sales': return sales
    if metric == 'gross_profit': return sales - costs
    if metric == 'units': return units
    if metric == 'gross_margin': return (sales - costs) / sales if sales > 0 else None
    if metric == 'avg_unit_price': return sales / units if units > 0 else None
    raise LabError('INVALID_ARGUMENT', '未対応の指標です。')

def group_ids(q):
    f = q['filters']
    if q['group_by'] == 'store': return f['store_ids']
    categories = sorted(f['category_ids'] or CATEGORIES)
    prods = [p for p in PRODUCTS if PRODUCTS[p]['category_id'] in categories and (not f['product_ids'] or p in f['product_ids'])]
    return sorted(set(PRODUCTS[p]['category_id'] for p in prods)) if q['group_by'] == 'category' else prods

def aggregate(db, q, per):
    column = {'store': 'store_id', 'category': 'category_id', 'product': 'product_id'}[q['group_by']]
    where, args = ['business_date BETWEEN ? AND ?'], [per['start'], per['end']]
    for key, col in [('store_ids', 'store_id'), ('category_ids', 'category_id'), ('product_ids', 'product_id')]:
        values = q['filters'][key]
        if values:
            where.append(col + ' IN (' + ','.join('?' for _ in values) + ')')
            args.extend(values)
    data = db.execute(f'SELECT {column},SUM(net_sales),SUM(net_cogs),SUM(units),COUNT(*) FROM sales WHERE ' + ' AND '.join(where) + f' GROUP BY {column}', args).fetchall()
    days = (date.fromisoformat(per['end']) - date.fromisoformat(per['start'])).days + 1
    expected = {}
    for store in q['filters']['store_ids']:
        for prod, info in PRODUCTS.items():
            if q['filters']['category_ids'] and info['category_id'] not in q['filters']['category_ids']: continue
            if q['filters']['product_ids'] and prod not in q['filters']['product_ids']: continue
            key = {'store': store, 'category': info['category_id'], 'product': prod}[q['group_by']]
            expected[key] = expected.get(key, 0) + days
    observed = {r[0]: r for r in data}
    missing = [g for g, n in expected.items() if g not in observed or observed[g][4] != n]
    # Refuse incomplete aggregation; never conflate missing records with zero revenue.
    require(not missing, '要求範囲の行に欠損があります。合計を確定できません。', 'NO_DATA')
    values = {r[0]: metric_value(r[1], r[2], r[3], q['metric']) for r in data}
    sales, costs, units = (sum(r[i] for r in data) for i in [1, 2, 3])
    return values, metric_value(sales, costs, units, q['metric'])

def comparison(base, target):
    delta = target - base if base is not None and target is not None else None
    return {'base': base, 'target': target, 'delta': delta,
            'change_rate': delta / base if delta is not None and base is not None and base > 0 else None}

class Analytics:
    def __init__(self, db=None):
        self.db = db or seed_database()
        self.lock = threading.RLock()
        self.sessions = {}

    def new_session(self, scope):
        with self.lock:
            now = time.monotonic()
            self.sessions = {k: v for k, v in self.sessions.items() if v['expires'] > now}
            require(len(self.sessions) < 100, 'セッション上限です。サーバーを再起動してください。', 'QUERY_LIMIT_EXCEEDED', 429)
            token = secrets.token_urlsafe(32)
            session = {'id': token, 'csrf': secrets.token_urlsafe(32), 'allowed_stores': list(scope), 'expires': now + SESSION_TTL, 'results': {}}
            self.sessions[token] = session
            return session

    def session(self, token):
        session = self.sessions.get(token)
        require(session and session['expires'] > time.monotonic(), 'デモセッションがありません。ページを再読込してください。', 'UNAUTHENTICATED', 401)
        return session

    def execute(self, session, raw, kind):
        started = time.perf_counter()
        q = normalized_query(raw, session['allowed_stores'], kind)
        with self.lock:
            target, target_total = aggregate(self.db, q, q['target_period'])
            base, base_total = aggregate(self.db, q, q['base_period']) if kind == 'compare' else ({}, None)
        ids = group_ids(q)
        rows = []
        for key in ids:
            label = CATEGORIES.get(key, PRODUCTS.get(key, {}).get('name', key))
            row = {'id': key, 'label': label}
            row.update(comparison(base.get(key), target.get(key)) if kind == 'compare' else {'value': target.get(key)})
            rows.append(row)
        totals = comparison(base_total, target_total) if kind == 'compare' else {'value': target_total}
        warnings = []
        if kind == 'compare':
            rows.sort(key=lambda r: (r['delta'] is None, r['delta'] or 0, r['id']))
            if any(r['base'] is None or r['target'] is None for r in rows): warnings.append('UNDEFINED_METRIC')
            if any(r['base'] is not None and r['base'] <= 0 for r in rows): warnings.append('NON_POSITIVE_BASE_RATE_NULL')
            if q['metric'] in ADDITIVE:
                delta = totals['delta']
                for row in rows:
                    row['net_delta_share'] = row['delta'] / delta if delta else None
                warnings.append('差分寄与は構成上の内訳であり、原因の証明ではありません。')
            if (date.fromisoformat(q['base_period']['end']) - date.fromisoformat(q['base_period']['start'])) != (date.fromisoformat(q['target_period']['end']) - date.fromisoformat(q['target_period']['start'])):
                warnings.append('UNEQUAL_PERIOD_LENGTHS：日数を正規化していません。')
        elif any(r['value'] is None for r in rows): warnings.append('UNDEFINED_METRIC')
        if q['metric'] not in ADDITIVE: warnings.append('比率指標は全体の分子・分母から再計算し、単純平均しません。')
        hidden = rows[q['limit']:]
        others = None
        if hidden and q['metric'] in ADDITIVE:
            fields = ['base', 'target', 'delta'] if kind == 'compare' else ['value']
            others = {f: sum(r[f] for r in hidden) for f in fields}
        query_hash = hashlib.sha256(json.dumps({k:v for k,v in q.items() if k != 'context_id'}, sort_keys=True).encode()).hexdigest()[:24]
        result = {'ok': True, 'result_id': 'r_' + secrets.token_hex(12), 'query_hash': query_hash, 'query': q,
                  'dataset_snapshot_id': DATASET, 'metric_definition_version': 'retail-metrics-v1',
                  'data_through': END.isoformat(), 'timezone': 'Asia/Tokyo', 'unit': METRICS[q['metric']],
                  'rows': rows[:q['limit']], 'totals': totals, 'row_count': len(rows), 'truncated': bool(hidden),
                  'other_totals': others, 'warnings': warnings, 'duration_ms': round((time.perf_counter()-started)*1000, 3)}
        require(len(json.dumps(result, ensure_ascii=False).encode()) <= MAX_RESULT_BYTES, '応答サイズ上限です。', 'QUERY_LIMIT_EXCEEDED')
        with self.lock:
            cache = session['results']
            now = time.monotonic()
            for rid in list(cache):
                if cache[rid]['expires'] <= now: del cache[rid]
            while len(cache) >= 100: del cache[next(iter(cache))]
            cache[result['result_id']] = {'data': copy.deepcopy(result), 'expires': now + RESULT_TTL}
        return result

    def get_result(self, session, rid):
        require(isinstance(rid, str) and 1 <= len(rid) <= 128)
        with self.lock:
            item = session['results'].get(rid)
            require(item is not None, '結果は参照できません。', 'FORBIDDEN', 403)
            require(item['expires'] > time.monotonic(), '結果の有効期限切れです。再集計してください。', 'RESULT_EXPIRED', 410)
            require(set(item['data']['query']['filters']['store_ids']) <= set(session['allowed_stores']), '結果は参照できません。', 'FORBIDDEN', 403)
            return copy.deepcopy(item['data'])

class LabServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, port=8765, scope=None, analytics=None):
        self.analytics = analytics or Analytics()
        self.scope = list(scope or STORES)
        super().__init__(('127.0.0.1', port), Handler)

class Handler(BaseHTTPRequestHandler):
    server: LabServer
    protocol_version = 'HTTP/1.0'

    def log_message(self, fmt, *args):
        # Exclude cookie, CSRF and response data from logs.
        pass

    def respond(self, status, payload, content_type='application/json; charset=utf-8', cookie=None):
        data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode() if content_type.startswith('application/json') else payload
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Origin-Agent-Cluster', '?1')
        self.send_header('Permissions-Policy', 'tools=(self)')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        if cookie: self.send_header('Set-Cookie', cookie)
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass

    def guard(self):
        port = self.server.server_port
        host = self.headers.get('Host', '')
        require(host in [f'127.0.0.1:{port}', f'localhost:{port}'], '許可されていないHostです。', 'FORBIDDEN', 403)
        origin = self.headers.get('Origin')
        require(origin is None or origin == 'http://' + host, '別オリジンからは利用できません。', 'FORBIDDEN', 403)
        require(self.headers.get('Sec-Fetch-Site', '') not in ['cross-site'], '別サイトからは利用できません。', 'FORBIDDEN', 403)

    def get_session(self):
        c = SimpleCookie()
        try: c.load(self.headers.get('Cookie', ''))
        except Exception: pass
        return self.server.analytics.session(c['lab_session'].value if 'lab_session' in c else None)

    def do_GET(self):
        try:
            self.guard()
            path = urlparse(self.path).path
            if path == '/api/session':
                cookie = None
                try: session = self.get_session()
                except LabError:
                    session = self.server.analytics.new_session(self.server.scope)
                    cookie = f"lab_session={session['id']}; HttpOnly; SameSite=Strict; Path=/"
                self.respond(200, {'ok': True, 'csrf': session['csrf'], 'allowed_store_ids': session['allowed_stores'],
                                   'dataset_snapshot_id': DATASET, 'data_through': END.isoformat(), 'business_as_of': '2026-09-18',
                                   'categories': CATEGORIES, 'products': PRODUCTS, 'metrics': METRICS,
                                   'base_period': BASE, 'target_period': TARGET, 'demo_only': True}, cookie=cookie)
                return
            routes = {'/': ('static/index.html', 'text/html; charset=utf-8'), '/style.css': ('static/style.css', 'text/css; charset=utf-8')}
            if path.startswith('/dist/') and path.endswith('.js') and Path(path).name in ['main.js', 'workspace.js', 'webmcp.js']:
                routes[path] = ('static/dist/' + Path(path).name, 'text/javascript; charset=utf-8')
            require(path in routes, 'ページがありません。', 'NOT_FOUND', 404)
            file, mime = routes[path]
            self.respond(200, (ROOT / file).read_bytes(), mime)
        except LabError as error: self.respond(error.status, error.payload())
        except Exception: self.respond(500, {'ok': False, 'error': {'code': 'INTERNAL', 'message': '処理に失敗しました。'}})

    def do_POST(self):
        try:
            self.guard()
            session = self.get_session()
            require(secrets.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']), 'CSRF検証に失敗しました。', 'FORBIDDEN', 403)
            require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'application/json が必要です。')
            try: length = int(self.headers.get('Content-Length', '-1'))
            except ValueError: length = -1
            require(0 <= length <= 16384, '入力サイズ上限です。', 'QUERY_LIMIT_EXCEEDED', 413)
            self.connection.settimeout(5)
            try: data = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError): raise LabError('INVALID_ARGUMENT', '有効なJSONが必要です。')
            path = urlparse(self.path).path
            if path in ['/api/compare', '/api/query']:
                result = self.server.analytics.execute(session, data, 'compare' if path == '/api/compare' else 'query')
            elif path == '/api/result':
                object_keys(data, ['result_id'], ['result_id'])
                result = self.server.analytics.get_result(session, data['result_id'])
            else:
                raise LabError('NOT_FOUND', '操作がありません。', 404)
            self.respond(200, result)
        except LabError as error: self.respond(error.status, error.payload())
        except Exception: self.respond(500, {'ok': False, 'error': {'code': 'INTERNAL', 'message': '処理に失敗しました。'}})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--scope', choices=['all', 'S01'], default='all')
    args = parser.parse_args()
    server = LabServer(args.port, STORES if args.scope == 'all' else ['S01'])
    print(f'WebMCP Retail Lab: http://127.0.0.1:{server.server_port}  scope={args.scope}', flush=True)
    print('Synthetic data only. Loopback only. Ctrl+C to stop.', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
