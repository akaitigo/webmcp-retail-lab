import copy
import http.client
import json
import sqlite3
import threading
import time
import unittest
from server import Analytics, BASE, TARGET, STORES, LabError, LabServer, metric_value


def query(**overrides):
    q = {'context_id': 'ctx_test', 'base_period': BASE, 'target_period': TARGET,
         'metric': 'net_sales', 'group_by': 'store', 'filters': {'store_ids': STORES}, 'limit': 100}
    q.update(overrides)
    return q

class AnalyticsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.a = Analytics()
    @classmethod
    def tearDownClass(cls): cls.a.db.close()
    def setUp(self): self.s = self.a.new_session(STORES)
    def execute(self, **kw): return self.a.execute(self.s, query(**kw), 'compare')
    def error(self, code, fn):
        with self.assertRaises(LabError) as ctx: fn()
        self.assertEqual(ctx.exception.code, code)
    def test_seed_counts(self):
        self.assertEqual(self.a.db.execute('select count(*) from sales').fetchone()[0], 10800)
        self.assertEqual(self.a.db.execute('select count(*) from (select business_date,store_id,category_id from sales group by 1,2,3)').fetchone()[0], 5400)
    def test_golden_totals(self):
        r = self.execute(); self.assertEqual(r['totals'], {'base':100000000,'target':98000000,'delta':-2000000,'change_rate':-.02})
    def test_largest_store_decline(self):
        r = self.execute()['rows'][0]
        self.assertEqual((r['id'],r['base'],r['target'],r['net_delta_share']), ('S03',8000000,6400000,.8))
    def test_drink_decline(self):
        r = self.execute(group_by='category', filters={'store_ids':['S03']})['rows'][0]
        self.assertEqual((r['id'],r['base'],r['target'],r['net_delta_share']), ('C01',3000000,1800000,.75))
    def test_units(self):
        r = self.execute(metric='units', group_by='category', filters={'store_ids':['S03'],'category_ids':['C01']})
        self.assertEqual((r['totals']['base'],r['totals']['target']), (10000,8000))
    def test_weighted_price(self):
        r = self.execute(metric='avg_unit_price', group_by='category', filters={'store_ids':['S03'],'category_ids':['C01']})
        self.assertEqual((r['totals']['base'],r['totals']['target']), (300,225))
        self.assertNotIn('net_delta_share',r['rows'][0])
    def test_products_rollup(self):
        c = self.execute(group_by='category')['totals']; p = self.execute(group_by='product')
        self.assertEqual(c,p['totals']); self.assertEqual(len(p['rows']),12)
    def test_monthly_periods(self):
        r = self.execute(base_period={'start':'2026-07-01','end':'2026-07-31'}, target_period={'start':'2026-08-01','end':'2026-08-31'})
        direct = self.a.db.execute("select sum(net_sales) from sales where business_date between '2026-08-01' and '2026-08-31'").fetchone()[0]
        self.assertEqual(r['totals']['target'],direct)
    def test_truncated_totals(self):
        r = self.execute(limit=1); self.assertTrue(r['truncated']); self.assertEqual(len(r['rows']),1)
        self.assertEqual(r['rows'][0]['delta']+r['other_totals']['delta'],r['totals']['delta'])
    def test_numeric_result_independent_of_context_id(self):
        first=self.execute(); second=self.execute(context_id='ctx_another')
        self.assertEqual(first['query_hash'],second['query_hash']); self.assertEqual(first['rows'],second['rows'])
    def test_readonly_database(self):
        with self.assertRaises(sqlite3.OperationalError): self.a.db.execute('delete from sales')
    def test_forbidden_store(self):
        s=self.a.new_session(['S01'])
        self.error('FORBIDDEN',lambda:self.a.execute(s,query(filters={'store_ids':['S03']}),'compare'))
    def test_unknown_store_same_error(self):
        s=self.a.new_session(['S01'])
        self.error('FORBIDDEN',lambda:self.a.execute(s,query(filters={'store_ids':['S99']}),'compare'))
    def test_other_session_result(self):
        r=self.execute(); other=self.a.new_session(STORES)
        self.error('FORBIDDEN',lambda:self.a.get_result(other,r['result_id']))
    def test_authority_rechecked(self):
        r=self.execute(); self.s['allowed_stores']=['S01']
        self.error('FORBIDDEN',lambda:self.a.get_result(self.s,r['result_id']))
    def test_expired_result(self):
        r=self.execute(); self.s['results'][r['result_id']]['expires']=0
        self.error('RESULT_EXPIRED',lambda:self.a.get_result(self.s,r['result_id']))
    def test_invalid_limit(self):
        for value in [0,101,True,'10']:
            self.error('QUERY_LIMIT_EXCEEDED',lambda:self.execute(limit=value))
    def test_invalid_metric(self):
        for value in ['sql',[],None]: self.error('INVALID_ARGUMENT',lambda:self.execute(metric=value))
    def test_invalid_group(self):
        self.error('INVALID_ARGUMENT',lambda:self.execute(group_by='store_id; DROP TABLE sales;'))
    def test_unknown_field(self):
        self.error('INVALID_ARGUMENT',lambda:self.execute(user_id='admin'))
    def test_duplicate_or_empty_store(self):
        for stores in [[],['S01','S01']]:self.error('INVALID_ARGUMENT',lambda:self.execute(filters={'store_ids':stores}))
    def test_unknown_product(self):
        self.error('INVALID_ARGUMENT',lambda:self.execute(filters={'store_ids':['S01'],'product_ids':['unknown']}))
    def test_mismatched_product_category(self):
        self.error('INVALID_ARGUMENT',lambda:self.execute(filters={'store_ids':['S01'],'category_ids':['C01'],'product_ids':['C02-P1']}))
    def test_invalid_date(self):
        self.error('INVALID_ARGUMENT',lambda:self.execute(target_period={'start':'2026-02-30','end':'2026-09-13'}))
    def test_unavailable_period_not_zero(self):
        self.error('NO_DATA',lambda:self.execute(target_period={'start':'2026-09-01','end':'2026-09-30'}))
    def test_ratio_zero_denominator(self):
        self.assertIsNone(metric_value(0,0,0,'gross_margin'))
        self.assertIsNone(metric_value(100,50,0,'avg_unit_price'))
    def test_missing_row_not_zero(self):
        a=Analytics(); s=a.new_session(STORES)
        a.db.execute('pragma query_only=off'); a.db.execute("delete from sales where business_date='2026-09-07' and store_id='S03' and product_id='C01-P1'"); a.db.commit();a.db.execute('pragma query_only=on')
        self.error('NO_DATA',lambda:a.execute(s,query(),'compare'));a.db.close()
    def test_zero_base_rate_null(self):
        a=Analytics();s=a.new_session(STORES)
        a.db.execute('pragma query_only=off');a.db.execute("update sales set net_sales=0 where business_date between '2026-08-31' and '2026-09-06' and store_id='S01'");a.db.commit();a.db.execute('pragma query_only=on')
        r=a.execute(s,query(),'compare'); row=next(r for r in r['rows'] if r['id']=='S01')
        self.assertIsNone(row['change_rate']);self.assertIn('NON_POSITIVE_BASE_RATE_NULL',r['warnings']);a.db.close()

class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=LabServer(0,['S01']);cls.port=cls.server.server_port
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls): cls.server.shutdown();cls.server.server_close()
    def request(self,method,path,body=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        c.request(method,path,body=json.dumps(body) if body is not None else None,headers=headers or {})
        r=c.getresponse();data=r.read();out=(r.status,dict(r.getheaders()),json.loads(data));c.close();return out
    def session(self):
        _,h,s=self.request('GET','/api/session')
        return {'Cookie':h['Set-Cookie'].split(';')[0],'X-CSRF-Token':s['csrf'],'Content-Type':'application/json'}
    def test_http_scope_readonly(self):
        headers=self.session();status,_,r=self.request('POST','/api/compare',query(filters={'store_ids':['S01']}),headers)
        self.assertEqual(status,200);self.assertEqual(len(r['rows']),1)
    def test_http_scope_denied(self):
        status,_,r=self.request('POST','/api/compare',query(filters={'store_ids':['S03']}),self.session())
        self.assertEqual((status,r['error']['code']),(403,'FORBIDDEN'));self.assertNotIn('S03',r['error']['message'])
    def test_no_session(self):
        status,_,_=self.request('POST','/api/compare',query(),{'Content-Type':'application/json'});self.assertEqual(status,401)
    def test_csrf_required(self):
        h=self.session();del h['X-CSRF-Token'];status,_,_=self.request('POST','/api/compare',query(),h);self.assertEqual(status,403)
    def test_cross_origin_denied(self):
        h=self.session();h['Origin']='https://untrusted.invalid';status,_,_=self.request('POST','/api/compare',query(),h);self.assertEqual(status,403)
    def test_bad_host_denied(self):
        status,_,_=self.request('GET','/api/session',headers={'Host':'untrusted.invalid'});self.assertEqual(status,403)
    def test_write_route_absent(self):
        status,_,_=self.request('POST','/api/delete',{},self.session());self.assertEqual(status,404)
    def test_headers(self):
        _,h,_=self.request('GET','/api/session');self.assertEqual(h['Origin-Agent-Cluster'],'?1');self.assertEqual(h['Permissions-Policy'],'tools=(self)')
        self.assertIn('HttpOnly',h['Set-Cookie']);self.assertNotIn('Access-Control-Allow-Origin',h)

if __name__=='__main__': unittest.main(verbosity=2)
