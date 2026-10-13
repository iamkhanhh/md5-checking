require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const SCRIPT_PATH = process.env.SCRIPT_PATH;
const DATA_BASE_DIR = process.env.DATA_BASE_DIR;
const OUTPUT_DIR = process.env.OUTPUT_DIR;
const CALLBACK_URL = process.env.CALLBACK_URL;
const API_TOKEN = process.env.API_TOKEN;

if (!SCRIPT_PATH || !DATA_BASE_DIR || !OUTPUT_DIR || !CALLBACK_URL || !API_TOKEN) {
  console.error('One or more required environment variables are not set');
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// data_folder values currently being checked, to avoid running the same folder twice
const running = new Set();

app.use(express.json());

// Requires header "Authorization: Bearer <API_TOKEN>"
function verifyToken(req, res, next) {
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    return res.status(401).json({ error: 'Invalid or missing token' });
  }
  next();
}

// POST /md5
// Body: { "data_folder": "D2609240002" }
// Starts the md5 check in the background and responds immediately.
// When the script finishes, the parsed summary is POSTed to CALLBACK_URL.
app.post('/md5', verifyToken, (req, res) => {
  const { data_folder } = req.body || {};

  if (typeof data_folder !== 'string' || !/^[A-Za-z0-9_-]+$/.test(data_folder)) {
    return res.status(400).json({ error: '"data_folder" must be a folder name like "D2609240002"' });
  }

  const folderPath = path.join(DATA_BASE_DIR, data_folder);
  if (!fs.existsSync(folderPath)) {
    return res.status(404).json({ error: `Folder not found: ${folderPath}` });
  }

  if (running.has(data_folder)) {
    return res.status(409).json({ error: `${data_folder} is already running` });
  }

  runMd5Check(data_folder, folderPath);
  res.status(202).json({ message: 'Started', data_folder });
});

function runMd5Check(dataFolder, folderPath) {
  running.add(dataFolder);

  // Equivalent of: ./md5_check_sep2.sh <folderPath> <dataFolder> > <OUTPUT_DIR>/<dataFolder>_run.out 2>&1
  const runOut = fs.openSync(path.join(OUTPUT_DIR, `${dataFolder}_run.out`), 'w');
  const child = spawn(SCRIPT_PATH, [folderPath, dataFolder], {
    cwd: OUTPUT_DIR,
    stdio: ['ignore', runOut, runOut],
  });

  console.log(`[${dataFolder}] started (pid ${child.pid})`);

  let finished = false;
  const onDone = (err, exitCode) => {
    if (finished) return;
    finished = true;
    fs.closeSync(runOut);
    running.delete(dataFolder);
    console.log(`[${dataFolder}] finished, exit code ${exitCode}${err ? `, error: ${err.message}` : ''}`);
    reportResult(dataFolder, exitCode, err);
  };

  child.on('error', (err) => onDone(err, null));
  child.on('close', (code) => onDone(null, code));
}

async function reportResult(dataFolder, exitCode, spawnError) {
  const payload = { data_folder: dataFolder, exit_code: exitCode };
  const summaryPath = path.join(OUTPUT_DIR, `${dataFolder}_md5_summary.log`);

  if (spawnError) {
    payload.error = spawnError.message;
  } else if (!fs.existsSync(summaryPath)) {
    payload.error = `Summary file not found: ${summaryPath}`;
  } else {
    payload.results = parseSummary(fs.readFileSync(summaryPath, 'utf8'));
  }

  try {
    const res = await postJson(CALLBACK_URL, payload);
    console.log(`[${dataFolder}] callback responded ${res.statusCode}`);
  } catch (err) {
    console.error(`[${dataFolder}] callback failed: ${err.message}`);
  }
}

// Turns lines like "N3177 | N3177_..._L1_1.fq.gz | OK" into
// [{ sample: "N3177", status: "OK", files: [...] }].
// A sample is OK only if every one of its files (R1 and R2) is OK.
function parseSummary(content) {
  const samples = new Map();

  for (const line of content.split('\n')) {
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length !== 3 || !parts[0]) continue;

    const [sample, file, status] = parts;
    if (!samples.has(sample)) samples.set(sample, []);
    samples.get(sample).push({ file, status });
  }

  return [...samples].map(([sample, files]) => ({
    sample,
    status: files.every((f) => f.status === 'OK') ? 'OK' : 'FAIL',
    files,
  }));
}

function postJson(url, body) {
  const data = JSON.stringify(body);
  const client = url.startsWith('https:') ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.end(data);
  });
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
