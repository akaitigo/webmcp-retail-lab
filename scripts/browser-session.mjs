import {spawn} from 'node:child_process';
import {chromium} from 'playwright';

export async function startLab({native = false} = {}) {
  const servers = [];
  const start = (scope) => new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON || 'python3', ['server.py', '--port', '0', '--scope', scope], {stdio: ['ignore', 'pipe', 'inherit']});
    servers.push(child);
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Server did not report its listening URL within 60 seconds')), 60000);
    child.on('error', e => {clearTimeout(timeout); reject(e);});
    child.on('exit', code => {clearTimeout(timeout); reject(new Error(`Server exited before startup completed: ${code}`));});
    child.stdout.on('data', chunk => {
      output += String(chunk);
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) {clearTimeout(timeout); resolve(url);}
    });
  });
  let browser;
  try {
    const base = await start('all');
    const restricted = await start('S01');
    browser = await chromium.launch({
      headless: process.env.HEADED !== '1',
      chromiumSandbox: true,
      ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
      args: native ? ['--enable-experimental-web-platform-features'] : []
    });
    const context = await browser.newContext({viewport: {width:1440,height:1100}, locale:'ja-JP'});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('dialog', d => d.accept());
    return {browser,context,page,errors,base,restricted,
      close: async () => {await browser.close(); for (const s of servers) s.kill();}};
  } catch (e) {
    if (browser) await browser.close();
    for (const s of servers) s.kill();
    throw e;
  }
}
