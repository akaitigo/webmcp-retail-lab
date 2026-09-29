import test from 'node:test';
import assert from 'node:assert/strict';
import {executeNative} from '../static/dist/webmcp.js';
test('Chrome 154 explicit JSON transport decodes returned JSON',async()=>{
 const tool={name:'get_analysis_context'};
 const mc={executeTool:async(t,args)=>{assert.equal(t,tool);assert.equal(args,'{}');return '{"context_id":"native-context","view_version":1}';}};
 assert.deepEqual(await executeNative(mc,tool,{},'chrome154-json'),{context_id:'native-context',view_version:1});
});
test('object transport preserves object input and output',async()=>{
 const args={context_id:'c'},result={ok:true};
 assert.equal(await executeNative({executeTool:async(t,a)=>{assert.equal(a,args);return result;}},{name:'x'},args,'object'),result);
});
test('native failure is not retried through a different transport',async()=>{
 let count=0;
 await assert.rejects(executeNative({executeTool:async()=>{count++;throw new Error('native failed');}},{name:'x'},{},'object'),/native failed/);
 assert.equal(count,1);
});
test('plain text and navigation null remain intact',async()=>{
 for(const result of ['plain text',null])assert.equal(await executeNative({executeTool:async()=>result},{name:'x'},{},'chrome154-json'),result);
});
