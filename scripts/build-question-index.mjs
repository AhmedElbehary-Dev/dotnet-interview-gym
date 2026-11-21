import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestPath = 'questions/manifest.json';
const mappingPath = 'questions/concept-map.json';
const taxonomyPath = 'questions/topic-taxonomy.json';
const indexPath = 'questions/index.json';
const conceptPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const validId = id => (count(id) && id > 0) || (typeof id === 'string' && /^[a-z0-9_-]+$/.test(id));

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const isCalendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

export const normalizePrompt = value => value.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

export function questionFingerprint(q) {
  const prompt = normalizePrompt(q.q);
  // Preserve code characters, including case and whitespace inside literals.
  const input = typeof q.code?.code === 'string'
    ? JSON.stringify(['code', prompt, q.code.lang,
      typeof q.code.prompt === 'string' ? normalizePrompt(q.code.prompt) : '',
      q.code.code.replace(/\r\n/g, '\n')])
    : JSON.stringify([prompt]);
  return createHash('sha256').update(input).digest('hex');
}

export function buildQuestionIndex(root = process.cwd(), read = path => readJson(root, path)) {
  const manifest = read(manifestPath);
  if (manifest?.schemaVersion !== 1 || !count(manifest.total) || !Array.isArray(manifest.files)) {
    throw new Error(`${manifestPath}: invalid manifest`);
  }
  const taxonomy = read(taxonomyPath);
  if (taxonomy?.schemaVersion !== 1 || !isRecord(taxonomy.concepts) ||
      Object.entries(taxonomy.concepts).some(([id, label]) => !conceptPattern.test(id) || !nonempty(label))) {
    throw new Error(`${taxonomyPath}: invalid topic taxonomy`);
  }

  let mapping = {};
  try {
    const document = read(mappingPath);
    if (document?.schemaVersion !== 1 || !isRecord(document.questions) ||
        Object.values(document.questions).some(id => typeof id !== 'string' || !Object.hasOwn(taxonomy.concepts, id))) {
      throw new Error(`${mappingPath}: invalid concept mapping`);
    }
    mapping = document.questions;
  } catch (error) {
    if (error.cause?.code !== 'ENOENT') throw error;
  }

  const ids = new Set();
  const paths = new Set();
  const categories = new Set();
  const questions = [];
  for (const entry of manifest.files) {
    if (typeof entry?.path !== 'string' || !/^questions\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.json$/i.test(entry.path) ||
        [manifestPath, taxonomyPath, mappingPath, indexPath].includes(entry.path) || paths.has(entry.path) ||
        !nonempty(entry.category) || !count(entry.count)) {
      throw new Error(`${manifestPath}: invalid or repeated shard entry ${JSON.stringify(entry)}`);
    }
    const { path: source } = entry;
    paths.add(source);
    categories.add(entry.category);
    const shard = read(source);
    if (!Array.isArray(shard?.questions)) throw new Error(`${source}: expected questions array`);
    if (shard.questions.length !== entry.count) throw new Error(`${source}: manifest count mismatch`);
    for (const q of shard.questions) {
      if (!isRecord(q)) throw new Error(`${source}: invalid question`);
      const { id, category, difficulty, skill } = q;
      const mapped = Object.hasOwn(mapping, id) ? mapping[id] : undefined;
      if (q.conceptId !== undefined && mapped !== undefined && q.conceptId !== mapped) {
        throw new Error(`${source} #${id}: conflicting concept mapping`);
      }
      const conceptId = q.conceptId === undefined ? mapped : q.conceptId;
      const where = `${source} #${id}`;
      if (!validId(id)) throw new Error(`${where}: invalid ID`);
      // Browser progress uses IDs as object keys, so 1 and "1" would share history.
      if (ids.has(String(id))) throw new Error(`${where}: duplicate ID`);
      ids.add(String(id));
      for (const field of ['q', 'category', 'difficulty', 'skill']) {
        if (!nonempty(q[field])) throw new Error(`${where}: missing ${field}`);
      }
      categories.add(category);
      const fingerprint = questionFingerprint(q);
      const indexed = { id, category, difficulty, skill, source, fingerprint };
      if (conceptId !== undefined) {
        if (typeof conceptId !== 'string' || !Object.hasOwn(taxonomy.concepts, conceptId)) {
          throw new Error(`${where}: unregistered conceptId ${JSON.stringify(conceptId)}`);
        }
        indexed.conceptId = conceptId;
      }
      if (q.publishedOn !== undefined) {
        if (!isCalendarDate(q.publishedOn)) throw new Error(`${where}: invalid publication date`);
        indexed.publishedOn = q.publishedOn;
      }
      questions.push(indexed);
    }
  }
  if (questions.length !== manifest.total) throw new Error(`${manifestPath}: total mismatch`);
  for (const id of Object.keys(mapping)) {
    if (!ids.has(id)) throw new Error(`${mappingPath}: unknown question ID ${id}`);
  }
  questions.sort((a, b) => {
    if (typeof a.id === typeof b.id) return typeof a.id === 'number' ? a.id - b.id : compareText(a.id, b.id);
    return typeof a.id === 'number' ? -1 : 1;
  });
  return { schemaVersion: 1, categories: [...categories].sort(compareText), questions };
}

export function isMain(url) {
  return process.argv[1] && fileURLToPath(url) === resolve(process.argv[1]);
}

export function runArtifactCli(moduleUrl, path, generate) {
  if (!isMain(moduleUrl)) return;
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--check')) {
      throw new Error(`Usage: node scripts/${process.argv[1].split(/[\\/]/).at(-1)} [--check]`);
    }
    const output = `${JSON.stringify(generate(), null, 2)}\n`;
    if (args.length) {
      const stale = `${path} is stale. Run the generator again and commit the result.`;
      let current;
      try {
        current = readFileSync(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new Error(stale);
      }
      if (!current.equals(Buffer.from(output))) throw new Error(stale);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, output);
    }
    console.log(`OK: ${path}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

runArtifactCli(import.meta.url, indexPath, buildQuestionIndex);
