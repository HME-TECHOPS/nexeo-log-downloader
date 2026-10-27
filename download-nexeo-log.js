const fs = require('node:fs/promises');
const { appendFileSync, mkdirSync, existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseArgs, promisify } = require('node:util');
const readline = require('node:readline/promises');

const DEFAULT_SERIALS_FILE = path.join(__dirname, 'nexeo_serials_to_run.csv');
const RESULTS_DIR = path.join(__dirname, 'results');
const FAILURES_DIR = path.join(__dirname, 'failures');
const DOWNLOADS_DIR = path.join(__dirname, 'Downloads');
const LOGS_DIR = path.join(__dirname, 'logs');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const HELP = `For each Nexeo serial: find it in the HME admin portal, click its "Online" status to open
the remote connection, go to System > PIN and enter the PIN, then System > Advanced >
System Logs and download every log into Downloads/<serial>/, extracting each archive
(SYSTEM/logs/enc/<module>/...) and deleting the archive afterwards.

Usage:
  node download-nexeo-log.js                    (uses nexeo_serials_to_run.csv next to this script)
  node download-nexeo-log.js --serial XXXXXXXX
  node download-nexeo-log.js --csv serials.csv

Options:
  --serial SN      Serial number to search for
  --csv FILE       One serial per line (optional "serial" header); use instead of --serial
  --out FILE       Results CSV (default: results/nexeo_results_<timestamp>.csv in this folder)
  --url URL        Admin portal URL (default: https://portal.hmecloud.com/admin/)
  --login-timeout  Minutes to wait for SSO sign-in (default: 5)
  --profile DIR    Browser profile dir that keeps the sign-in between runs
                   (default: %LOCALAPPDATA%\\hme-portal-playwright-<channel>; shared with portal_automation)
  --channel NAME   chrome (installed Chrome, default), msedge, or chromium (Playwright bundled)
  --slow-mo MS     Delay every browser action by MS milliseconds so you can watch (e.g. 1500)
  --help           Show this help

The PIN is read from config.json next to this script ({ "nexeoPin": "..." }); NEXEO_PIN in the
environment overrides it. The PIN is never printed or logged.
Logs: logs/nexeo_YYYY-MM-DD.log (one file per day). Failed serials get a screenshot,
page snapshot and HTML in failures/.
`;

function writeLog(level, message) {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${day} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const lines = String(message).trim().split('\n').map((l) => `${time} [${level}] ${l}`).join('\n');
    appendFileSync(path.join(LOGS_DIR, `nexeo_${day}.log`), lines + '\n');
  } catch {
    // Logging must never break a run.
  }
}

function log(message) {
  console.log(message);
  writeLog('INFO', message);
}

function logError(message) {
  console.error(message);
  writeLog('ERROR', message);
}

function readConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${CONFIG_FILE}: ${err.message}`);
  }
}

function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      serial: { type: 'string' },
      csv: { type: 'string' },
      out: { type: 'string' },
      url: { type: 'string', default: 'https://portal.hmecloud.com/admin/' },
      'login-timeout': { type: 'string', default: '5' },
      profile: { type: 'string' },
      channel: { type: 'string', default: 'chrome' },
      'slow-mo': { type: 'string', default: '0' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return values;
  values.pin = process.env.NEXEO_PIN || readConfig().nexeoPin;
  if (!values.pin) throw new Error(`Set "nexeoPin" in ${CONFIG_FILE} (or NEXEO_PIN in the environment).`);
  if (!['chrome', 'msedge', 'chromium'].includes(values.channel)) {
    throw new Error('--channel must be chrome, msedge, or chromium.');
  }
  values.profile ??= path.join(process.env.LOCALAPPDATA || os.homedir(), `hme-portal-playwright-${values.channel}`);
  if (values.serial && values.csv) throw new Error('Provide only one of --serial or --csv.');
  if (!values.serial && !values.csv) values.csv = DEFAULT_SERIALS_FILE;
  if (values.serial) values.serial = validSerial(values.serial);
  const url = new URL(values.url);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('--url must be an HTTPS URL without credentials.');
  }
  return values;
}

function validSerial(value) {
  const serial = value.trim().replace(/^"|"$/g, '').trim().toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(serial)) throw new Error(`Invalid serial: ${JSON.stringify(value)}`);
  return serial;
}

async function readSerials(file) {
  const lines = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((l) => l.split(',')[0].trim()).filter(Boolean);
  if (/^serial/i.test(lines[0] || '')) lines.shift();
  const serials = [...new Set(lines.map(validSerial))];
  if (!serials.length) throw new Error(`No serials found in ${file}.`);
  return serials;
}

async function waitForLogin(page, minutes) {
  const systems = page.getByRole('link', { name: /^\s*systems\s*$/i }).first();
  if (await systems.waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false)) return;
  const loginButton = page.getByRole('button', { name: /log-in through hme credentials/i });
  if (await loginButton.isVisible().catch(() => false)) {
    await loginButton.click();
    log('Clicked "Log-in through HME Credentials"; complete sign-in in the browser if asked...');
  } else {
    log('Click "Log-in through HME Credentials" and complete sign-in in the browser window...');
  }
  await systems.waitFor({ state: 'attached', timeout: minutes * 60_000 });
}

async function searchSerial(page, serial) {
  const nav = page.getByRole('link', { name: /^\s*systems\s*$/i }).first();
  if (!(await nav.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /toggle navigation/i }).click().catch(() => {});
  }
  await nav.click();
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByText(/^search for$/i).first().waitFor({ timeout: 30000 });
  await page.getByText(/^\s*serial #\s*$/i).first().click();
  await page.getByRole('option', { name: /^serial #$/i })
    .or(page.getByRole('listitem').filter({ hasText: /^serial #$/i }))
    .or(page.getByText(/^serial #$/i).last())
    .first()
    .click();
  const input = page.getByPlaceholder(/serial #/i);
  await input.fill(serial);
  await page.getByRole('button', { name: /^\s*search\s*$/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

// Mouse click at the element's centre, like a user; device UIs often fail Playwright's clickability checks.
async function clickAt(page, locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  const box = await locator.boundingBox({ timeout: 10000 });
  if (!box) throw new Error('Element not visible');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// Clicking "Online" in the system row opens the remote connection (new tab or embedded frame).
async function connectOnline(page, serial) {
  const row = page.getByRole('row').filter({ has: page.getByRole('gridcell', { name: serial, exact: true }) }).first();
  await row.waitFor({ timeout: 20000 });
  const online = row.getByText(/^\s*online\s*$/i).first();
  if (!(await online.isVisible().catch(() => false))) throw new Error('System is not Online');
  const popupPromise = page.context().waitForEvent('page', { timeout: 60000 }).catch(() => null);
  const framePromise = page.locator('iframe').first().waitFor({ state: 'attached', timeout: 60000 }).then(() => page, () => null);
  await online.click();
  const target = (await Promise.race([popupPromise, framePromise])) || page;
  const device = (await target.locator('iframe').count()) ? target.frameLocator('iframe').first() : target;
  // Ready once the device's left menu (HOME ... System) has rendered; the remote stream never goes network-idle.
  await device.getByText(/^\s*system\s*!?\s*$/i).first().waitFor({ timeout: 60000 });
  return { target, device };
}

async function enterPin(target, device, pin) {
  // The nav label may carry an alert badge, e.g. "System !".
  await clickAt(target, device.getByText(/^\s*system\s*!?\s*$/i).first());
  const box = device.locator('input[type="password"]:visible, input[placeholder*="pin" i]:visible, input[name*="pin" i]:visible').first();
  const pinTab = device.getByText(/^\s*pin\s*$/i).first();
  await box.or(pinTab).first().waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await box.isVisible().catch(() => false)) && await pinTab.isVisible().catch(() => false)) {
    await clickAt(target, pinTab);
    await box.waitFor({ timeout: 15000 }).catch(() => {});
  }
  if (!(await box.isVisible().catch(() => false))) throw new Error('PIN field not found after clicking System');
  await clickAt(target, box);
  await target.keyboard.press('Control+A');
  await target.keyboard.type(pin, { delay: 20 });
  if ((await box.inputValue()) !== pin) throw new Error('PIN was not entered correctly');
  const submit = device.getByRole('button', { name: /submit|enter|ok|log ?in|unlock|continue/i }).first();
  if (await submit.isVisible().catch(() => false)) await clickAt(target, submit);
  else await target.keyboard.press('Enter');
  await device.getByRole('button', { name: /^\s*advanced\s*$/i }).first().waitFor({ timeout: 30000 });
}

async function openSystemLogs(target, device) {
  await clickAt(target, device.getByRole('button', { name: /^\s*advanced\s*$/i }).first());
  const link = device.getByRole('link', { name: /^\s*system logs\s*$/i }).first();
  await link.waitFor({ state: 'visible', timeout: 15000 });
  await clickAt(target, link);
  await device.getByRole('button', { name: /^\s*download\s*$/i }).first().waitFor({ timeout: 30000 });
}

// Logs arrive as .tar.gz (SYSTEM/logs/enc/<module>/...). Windows bsdtar refuses absolute and ".." paths.
async function extractAndRemove(archive, dir) {
  await promisify(execFile)('tar', ['-xzf', archive, '-C', dir]);
  await fs.unlink(archive);
}

// Downloads every log on the System Logs page into Downloads/<serial>/. Never touches Delete.
async function downloadAllLogs(target, device, serial) {
  const dir = path.join(DOWNLOADS_DIR, serial);
  await fs.mkdir(dir, { recursive: true });
  const buttons = device.getByRole('button', { name: /^\s*download\s*$/i });
  const count = await buttons.count();
  const saved = [];
  const failed = [];
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    // The log name is the first line of the row that holds this Download button.
    const name = (await button.evaluate((el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        const first = (node.innerText || '').split('\n').map((s) => s.trim()).find(Boolean);
        if (first && !/^(download|delete|show)$/i.test(first)) return first;
      }
      return '';
    })) || `log_${i + 1}`;
    const safeName = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_|_$/g, '');
    const downloadPromise = target.waitForEvent('download', { timeout: 60000 }).catch(() => null);
    await clickAt(target, button);
    const download = await downloadPromise;
    if (!download) {
      failed.push(name);
      logError(`[${serial}] No download for ${name}`);
      continue;
    }
    const ext = path.extname(download.suggestedFilename()) || '.log';
    const file = path.join(dir, `${serial}_${safeName}${ext}`);
    await download.saveAs(file);
    try {
      await extractAndRemove(file, dir);
      saved.push(file);
      log(`[${serial}] Downloaded and extracted ${name}`);
    } catch (err) {
      failed.push(name);
      logError(`[${serial}] Could not extract ${path.basename(file)} (kept): ${err.message.split('\n')[0]}`);
    }
  }
  return { dir, total: count, saved: saved.length, failed };
}

async function saveFailure(target, serial, step) {
  await fs.mkdir(FAILURES_DIR, { recursive: true });
  const base = path.join(FAILURES_DIR, `nexeo_${serial}_${step}`);
  await target.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  const snapshot = await target.locator('body').ariaSnapshot().catch(() => '');
  const frameSnaps = await Promise.all(target.frames().slice(1).map(async (f) =>
    `\n--- frame ${f.url().split('?')[0]} ---\n${await f.locator('body').ariaSnapshot().catch(() => '')}`));
  await fs.writeFile(`${base}_snapshot.txt`, snapshot + frameSnaps.join('')).catch(() => {});
  const html = await Promise.all(target.frames().map((f) => f.content().catch(() => '')));
  await fs.writeFile(`${base}.html`, html.join('\n<!-- next frame -->\n')).catch(() => {});
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function processSerial(page, serial, result, state, pin) {
  const step = (name) => {
    result.step = name;
    writeLog('STEP', `[${serial}] ${name}`);
  };
  step('search');
  await searchSerial(page, serial);
  step('connect-online');
  const { target, device } = await connectOnline(page, serial);
  state.target = target;
  log(`[${serial}] Connected (Online clicked).`);
  step('system-pin');
  await enterPin(target, device, pin);
  log(`[${serial}] Entered PIN under System > PIN.`);
  step('system-logs');
  await openSystemLogs(target, device);
  log(`[${serial}] Opened System > Advanced > System Logs.`);
  step('download-logs');
  const logs = await downloadAllLogs(target, device, serial);
  result.logFile = `${logs.saved}/${logs.total} logs in ${logs.dir}`;
  log(`[${serial}] Downloaded ${result.logFile}`);
  if (logs.failed.length) throw new Error(`Download/extract failed for: ${logs.failed.join(', ')}`);
  result.status = 'OK';
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const serials = options.csv ? await readSerials(options.csv) : [options.serial];
  writeLog('INFO', `=== Run started: ${serials.length} serial(s) [${serials.join(', ')}], input ${options.csv || '--serial'} ===`);
  const out = options.out || path.join(RESULTS_DIR, `nexeo_results_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.csv`);
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, 'serial,status,failed_step,logs,detail\n');

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(options.profile, {
    headless: false,
    slowMo: Math.max(0, Number(options['slow-mo']) || 0),
    ...(options.channel === 'chromium' ? {} : { channel: options.channel }),
  });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    await waitForLogin(page, Number(options['login-timeout']) || 5);

    for (const [i, serial] of serials.entries()) {
      log(`\n(${i + 1}/${serials.length}) ${serial}`);
      const result = { status: 'FAILED' };
      const state = { target: page };
      try {
        await processSerial(page, serial, result, state, options.pin);
      } catch (err) {
        result.detail = err.message.split('\n')[0];
        logError(`[${serial}] Failed at step "${result.step}": ${result.detail}`);
        await saveFailure(state.target, serial, result.step);
        process.exitCode = 1;
      }
      if (state.target !== page) await state.target.close().catch(() => {});
      writeLog(result.status === 'OK' ? 'INFO' : 'ERROR', `[${serial}] Result: ${result.status}`);
      const row = [serial, result.status, result.status === 'OK' ? '' : result.step, result.logFile, result.detail];
      await fs.appendFile(out, row.map(csvCell).join(',') + '\n');
    }
    log(`\nResults written to ${out}`);
  } catch (err) {
    logError(`Failed at sign-in: ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
  writeLog('INFO', '=== Run finished ===');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter to close the browser... ');
  rl.close();
  await context.close();
}

main().catch((err) => {
  logError(err.message);
  process.exitCode = 1;
});
