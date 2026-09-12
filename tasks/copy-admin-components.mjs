// Copies the built admin GUI component (module federation remote) into admin/custom, which is where
// jsonConfig loads it from, and stamps the bundle's hash into that URL. The remote entry always has
// the same file name while its chunks are content hashed, so without the stamp a browser can keep a
// cached entry that points at chunks this build already replaced - the component then fails to load.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const from = 'src-admin/build';
const to = 'admin/custom';
const entry = 'customComponents.js';
// Nothing in our own bundle refers to this file, the admin fetches it on its own: before it
// registers the component, jsonConfig reads the shared dependencies from "<entry dir>/mf-manifest.json"
// to check which GUI API generation the component was built against. Without it that request is a 404.
const manifest = 'mf-manifest.json';
const jsonConfigFile = 'admin/jsonConfig.json';

if (!existsSync(`${from}/${entry}`)) {
    throw new Error(`missing ${from}/${entry} - run "npm --prefix src-admin run build" first`);
}

rmSync(to, { recursive: true, force: true });
cpSync(`${from}/${entry}`, `${to}/${entry}`);
cpSync(`${from}/assets`, `${to}/assets`, { recursive: true });
cpSync(`${from}/${manifest}`, `${to}/${manifest}`);

// the chunk file names are part of the entry, so hashing it covers the whole bundle
const hash = createHash('sha1')
    .update(readFileSync(`${to}/${entry}`))
    .digest('hex')
    .slice(0, 8);
const url = `custom/${entry}?v=${hash}`;

const jsonConfig = JSON.parse(readFileSync(jsonConfigFile, 'utf8'));
if (jsonConfig.items?.version?.url !== url) {
    jsonConfig.items.version.url = url;
    writeFileSync(jsonConfigFile, `${JSON.stringify(jsonConfig, null, 4)}\n`);
}

console.log(`copied admin components to ${to}, jsonConfig url is "${url}"`);
