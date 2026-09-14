"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var releases_exports = {};
__export(releases_exports, {
  CUSTOM_FILE_PREFIX: () => CUSTOM_FILE_PREFIX,
  CUSTOM_PREFIX: () => CUSTOM_PREFIX,
  CUSTOM_VERSION: () => CUSTOM_VERSION,
  OFFICIAL_FILE_PREFIX: () => OFFICIAL_FILE_PREFIX,
  customBuildDir: () => customBuildDir,
  ensureRelease: () => ensureRelease,
  findHtmlRoot: () => findHtmlRoot,
  listCustomBuilds: () => listCustomBuilds,
  pruneReleaseBuilds: () => pruneReleaseBuilds,
  readCustomBuild: () => readCustomBuild,
  readReleaseBuild: () => readReleaseBuild,
  releaseBuildDir: () => releaseBuildDir,
  removeCustomBuild: () => removeCustomBuild,
  removeLegacyCustomBuild: () => removeLegacyCustomBuild,
  resolveVersionSelection: () => resolveVersionSelection,
  unpackUploadedTarball: () => unpackUploadedTarball
});
module.exports = __toCommonJS(releases_exports);
var import_axios = __toESM(require("axios"));
var import_node_crypto = require("node:crypto");
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var tar = __toESM(require("tar"));
const REPO = "CometVisu/CometVisu";
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const CUSTOM_VERSION = "__custom__";
const CUSTOM_PREFIX = `${CUSTOM_VERSION}:`;
const CUSTOM_FILE_PREFIX = "[Custom] ";
const OFFICIAL_FILE_PREFIX = "[Official] ";
const LEGACY_CUSTOM_PREFIX = "Custom: ";
const LEGACY_OFFICIAL_PREFIX = "Official: ";
function resolveVersionSelection(value, legacyBuildUpload) {
  if (value.startsWith(CUSTOM_FILE_PREFIX)) {
    return { kind: "custom", file: value.slice(CUSTOM_FILE_PREFIX.length) };
  }
  if (value.startsWith(OFFICIAL_FILE_PREFIX)) {
    return { kind: "release", tag: value.slice(OFFICIAL_FILE_PREFIX.length) };
  }
  if (value.startsWith(LEGACY_CUSTOM_PREFIX)) {
    return { kind: "custom", file: value };
  }
  if (value.startsWith(LEGACY_OFFICIAL_PREFIX)) {
    return { kind: "release", tag: value.slice(LEGACY_OFFICIAL_PREFIX.length) };
  }
  if (value.startsWith(CUSTOM_PREFIX)) {
    return { kind: "custom", file: value.slice(CUSTOM_PREFIX.length) };
  }
  if (value === CUSTOM_VERSION) {
    return { kind: "custom", file: legacyBuildUpload || "" };
  }
  return { kind: "release", tag: value };
}
function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "iobroker.cometvisu"
  };
}
function findHtmlRoot(dir) {
  let level = [dir];
  for (let depth = 0; depth < 5 && level.length; depth++) {
    const next = [];
    for (const current of level) {
      if (fs.existsSync(path.join(current, "index.html"))) {
        return current;
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          next.push(path.join(current, entry.name));
        }
      }
    }
    level = next;
  }
  return dir;
}
function releaseBuildDir(dataDir, tag) {
  return path.join(dataDir, "cometvisu", tag);
}
function readReleaseBuild(dataDir, tag) {
  const targetDir = releaseBuildDir(dataDir, tag);
  return fs.existsSync(path.join(targetDir, ".complete")) ? { tag, htmlRoot: findHtmlRoot(targetDir) } : null;
}
async function ensureRelease(dataDir, tag, url, log, onProgress) {
  var _a;
  if (!tag) {
    throw new Error("no CometVisu release given");
  }
  if (!url.startsWith(DOWNLOAD_PREFIX)) {
    throw new Error(`"${url}" is not a download of ${REPO} releases`);
  }
  const present = readReleaseBuild(dataDir, tag);
  if (present) {
    log.debug(`CometVisu ${tag} is already present`);
    return present;
  }
  const targetDir = releaseBuildDir(dataDir, tag);
  const stagingDir = `${targetDir}.tmp`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    log.info(`downloading CometVisu ${tag} from ${url}`);
    onProgress == null ? void 0 : onProgress({ phase: "downloading" });
    const res = await import_axios.default.get(url, {
      headers: githubHeaders(),
      responseType: "stream",
      timeout: 12e4
    });
    const total = Number((_a = res.headers) == null ? void 0 : _a["content-length"]) || void 0;
    await extractTarball(
      res.data,
      stagingDir,
      onProgress && ((done) => onProgress({ phase: "downloading", done, total })),
      onProgress && (() => onProgress({ phase: "unpacking" }))
    );
    if (!fs.existsSync(path.join(findHtmlRoot(stagingDir), "index.html"))) {
      throw new Error("the downloaded archive does not contain a CometVisu build (no index.html found)");
    }
    fs.writeFileSync(path.join(stagingDir, ".complete"), (/* @__PURE__ */ new Date()).toISOString());
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  log.info(`CometVisu ${tag} unpacked to ${targetDir}`);
  return { tag, htmlRoot: findHtmlRoot(targetDir) };
}
function extractTarball(source, targetDir, onBytes, onRead) {
  return new Promise((resolve, reject) => {
    const extract = tar.x({ cwd: targetDir });
    const input = typeof source === "string" ? fs.createReadStream(source) : source;
    input.on("error", reject);
    extract.on("error", reject);
    extract.on("finish", () => resolve());
    if (onBytes) {
      let bytes = 0;
      input.on("data", (chunk) => onBytes(bytes += chunk.length));
    }
    input.on("end", () => onRead == null ? void 0 : onRead());
    input.pipe(extract);
  });
}
function customRootDir(dataDir) {
  return path.join(dataDir, "cometvisu", "custom");
}
function customBuildDir(dataDir, file) {
  const readable = file.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const hash = (0, import_node_crypto.createHash)("sha1").update(file).digest("hex").slice(0, 8);
  return path.join(customRootDir(dataDir), `${readable}__${hash}`);
}
async function unpackUploadedTarball(tgzPath, dataDir, log, source) {
  if (!fs.existsSync(tgzPath)) {
    throw new Error(`uploaded build archive not found at ${tgzPath}`);
  }
  const targetDir = customBuildDir(dataDir, source.file);
  const stagingDir = `${targetDir}.tmp`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    log.info(`unpacking uploaded CometVisu build "${source.file}"`);
    await extractTarball(tgzPath, stagingDir);
    if (!fs.existsSync(path.join(findHtmlRoot(stagingDir), "index.html"))) {
      throw new Error("the uploaded archive does not contain a CometVisu build (no index.html found)");
    }
    fs.writeFileSync(path.join(stagingDir, ".complete"), (/* @__PURE__ */ new Date()).toISOString());
    fs.writeFileSync(path.join(stagingDir, ".source"), JSON.stringify(source));
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, targetDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  log.info(`uploaded CometVisu build unpacked to ${targetDir}`);
  return { tag: source.file, htmlRoot: findHtmlRoot(targetDir) };
}
function readSource(targetDir) {
  const sourceFile = path.join(targetDir, ".source");
  if (!fs.existsSync(sourceFile)) {
    return null;
  }
  const content = fs.readFileSync(sourceFile, "utf8").trim();
  try {
    const parsed = JSON.parse(content);
    return typeof (parsed == null ? void 0 : parsed.file) === "string" ? parsed : null;
  } catch {
    return content ? { file: content } : null;
  }
}
function readCustomBuild(dataDir, file) {
  const targetDir = customBuildDir(dataDir, file);
  if (!fs.existsSync(path.join(targetDir, ".complete"))) {
    return null;
  }
  return { htmlRoot: findHtmlRoot(targetDir), source: readSource(targetDir) };
}
function listCustomBuilds(dataDir) {
  const root = customRootDir(dataDir);
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    var _a, _b;
    const dir = path.join(root, entry.name);
    return { dir, file: (_b = (_a = readSource(dir)) == null ? void 0 : _a.file) != null ? _b : null };
  });
}
function removeCustomBuild(dataDir, file) {
  const targetDir = customBuildDir(dataDir, file);
  if (!fs.existsSync(targetDir)) {
    return false;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  return true;
}
function removeLegacyCustomBuild(dataDir) {
  const legacyDir = path.join(dataDir, "cometvisu", CUSTOM_VERSION);
  if (!fs.existsSync(legacyDir)) {
    return false;
  }
  fs.rmSync(legacyDir, { recursive: true, force: true });
  return true;
}
function pruneReleaseBuilds(dataDir, keepTag) {
  const root = path.join(dataDir, "cometvisu");
  if (!fs.existsSync(root)) {
    return [];
  }
  const keep = /* @__PURE__ */ new Set([CUSTOM_VERSION, "custom", keepTag]);
  const removed = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) {
      continue;
    }
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CUSTOM_FILE_PREFIX,
  CUSTOM_PREFIX,
  CUSTOM_VERSION,
  OFFICIAL_FILE_PREFIX,
  customBuildDir,
  ensureRelease,
  findHtmlRoot,
  listCustomBuilds,
  pruneReleaseBuilds,
  readCustomBuild,
  readReleaseBuild,
  releaseBuildDir,
  removeCustomBuild,
  removeLegacyCustomBuild,
  resolveVersionSelection,
  unpackUploadedTarball
});
//# sourceMappingURL=releases.js.map
