import fs from 'node:fs/promises';
import {startLab} from './browser-session.mjs';
import ui from '../tests/browser/ui.mjs';
import nativeChecks from '../tests/browser/native.mjs';
import revision from '../tests/browser/revision.mjs';
const native = process.argv.includes('--native');
const transport = process.env.WEBMCP_TRANSPORT || 'object';
if (!['object','chrome154-json'].includes(transport)) throw new Error('Unknown WEBMCP_TRANSPORT');
const out = 'artifacts/browser';
await fs.mkdir(out,{recursive:true});
const lab = await startLab({native});
try {
  const tests = await ui({...lab,out,transport});
  if (native) {
    tests.push(...await nativeChecks({...lab,out,transport}));
    tests.push(...await revision({...lab,out,transport}));
  }
  const report = {browser:lab.browser.version(),native,transport: native ? transport : null,tests};
  await fs.writeFile(`${out}/${native ? 'native' : 'ui'}-tests.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if (tests.some(t=>t.status !== 'PASS')) process.exitCode = 1;
} finally {await lab.close();}
