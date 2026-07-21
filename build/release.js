// One-command release with retries: builds, publishes to GitHub, VERIFIES the
// release actually has everything auto-update needs (latest.yml + Setup exe),
// and retries if the publish died partway — which GitHub uploads sometimes do
// right after the large installer asset.
const { spawnSync, execSync } = require('child_process');
const https = require('https');
const path = require('path');

const version = require('../package.json').version;
const OWNER = 'Korzen101';
const REPO = 'TradeForge';
const ATTEMPTS = 3;

// Convenience: pull the GitHub token from the gh CLI if not already set.
if (!process.env.GH_TOKEN) {
  try {
    const t = execSync('gh auth token', { encoding: 'utf8' }).trim();
    if (t) {
      process.env.GH_TOKEN = t;
      console.log('release: using token from gh CLI');
    }
  } catch (_) {
    console.log('release: no GH_TOKEN and gh CLI unavailable — publish will fail without one');
  }
}

function build() {
  const r = spawnSync('npx', ['electron-builder', '--win', '--publish', 'always'], {
    stdio: 'inherit',
    shell: true,
    cwd: path.join(__dirname, '..')
  });
  return r.status === 0;
}

function ghGet(apiPath) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: apiPath,
      headers: {
        'User-Agent': 'TradeForge-release',
        'Accept': 'application/vnd.github+json',
        ...(process.env.GH_TOKEN ? { Authorization: 'Bearer ' + process.env.GH_TOKEN } : {})
      }
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch (_) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, json: null }); });
  });
}

// The release may still be a draft mid-publish, so list all releases
// (drafts included when authed) and find our tag.
async function assetsComplete() {
  const { json } = await ghGet(`/repos/${OWNER}/${REPO}/releases?per_page=10`);
  if (!Array.isArray(json)) return false;
  const rel = json.find((r) => r.tag_name === `v${version}`);
  if (!rel) return false;
  const names = (rel.assets || []).map((a) => a.name);
  const hasYml = names.includes('latest.yml');
  const hasExe = names.some((n) => /Setup.*\.exe$/i.test(n) && !n.endsWith('.blockmap'));
  console.log(`release: v${version} assets = [${names.join(', ')}]`);
  return hasYml && hasExe;
}

(async () => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    console.log(`\n=== release attempt ${attempt}/${ATTEMPTS} (v${version}) ===`);
    const built = build();
    if (await assetsComplete()) {
      console.log(`release: v${version} is complete on GitHub ✓`);
      // No shell: array args survive spaces in the path (e.g. "Chris Korzen").
      const post = spawnSync(process.execPath, [path.join(__dirname, 'post-dist.js')], { stdio: 'inherit' });
      process.exit(post.status || 0);
    }
    console.log(built
      ? 'release: build ok but GitHub release is incomplete — retrying publish'
      : 'release: build/publish errored — retrying');
  }
  console.error(`release: FAILED after ${ATTEMPTS} attempts — check network/token and re-run npm run release`);
  process.exit(1);
})();
