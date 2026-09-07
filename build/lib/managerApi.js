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
var managerApi_exports = {};
__export(managerApi_exports, {
  createManagerRouter: () => createManagerRouter
});
module.exports = __toCommonJS(managerApi_exports);
var import_express = __toESM(require("express"));
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
var zlib = __toESM(require("node:zlib"));
var import_managerFs = require("./managerFs");
function contentHash(file) {
  try {
    return zlib.crc32(fs.readFileSync(file));
  } catch {
    return void 0;
  }
}
function describe(roots, parent, name, writable) {
  const relative = parent ? `${parent}/${name}` : name;
  const resolved = (0, import_managerFs.resolvePath)(roots, relative);
  if (!resolved) {
    return null;
  }
  let stat;
  try {
    stat = fs.statSync(resolved.absolute);
  } catch {
    return null;
  }
  const isDir = stat.isDirectory();
  return {
    name,
    type: isDir ? "DIR" : "FILE",
    parentFolder: parent,
    hasChildren: isDir && (0, import_managerFs.listNames)(roots, relative).length > 0,
    readable: true,
    writeable: writable && resolved.writeable,
    mounted: resolved.mounted,
    trash: relative === import_managerFs.TRASH_FOLDER,
    inTrash: resolved.inTrash,
    hash: isDir ? void 0 : contentHash(resolved.absolute)
  };
}
function environmentState(roots, relative, writable) {
  const resolved = (0, import_managerFs.resolvePath)(roots, relative);
  if (!resolved || !fs.existsSync(resolved.absolute)) {
    return 0;
  }
  let state = 1;
  try {
    fs.accessSync(resolved.absolute, fs.constants.R_OK);
    state |= 2;
  } catch {
  }
  if (writable && resolved.writeable) {
    state |= 4;
  }
  return state;
}
function writeContent(target, content, expected) {
  const hash = zlib.crc32(content);
  if (typeof expected === "string" && expected !== "" && expected !== "ignore" && expected !== String(hash)) {
    throw Object.assign(new Error("data has been corrupted during transport"), { status: 405 });
  }
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content);
    if (zlib.crc32(fs.readFileSync(temporary)) !== hash) {
      throw Object.assign(new Error("hash mismatch on written content"), { status: 405 });
    }
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) {
      fs.rmSync(temporary, { force: true });
    }
  }
}
function backup(roots, relative, current) {
  var _a;
  const name = (_a = relative.split("/").pop()) != null ? _a : "";
  if (!import_managerFs.BACKUP_ON_CHANGE.test(name) || !fs.existsSync(current)) {
    return;
  }
  const folder = (0, import_managerFs.writeTarget)(roots, import_managerFs.BACKUP_FOLDER);
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(current, path.join(folder, (0, import_managerFs.backupName)(name, /* @__PURE__ */ new Date())));
}
function remove(roots, relative, target, force, inTrash) {
  if (force || inTrash) {
    if (!force && fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0) {
      throw Object.assign(new Error("folder not empty"), { status: 406 });
    }
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  const trashed = (0, import_managerFs.writeTarget)(roots, `${import_managerFs.TRASH_FOLDER}/${relative}`);
  fs.mkdirSync(path.dirname(trashed), { recursive: true });
  fs.rmSync(trashed, { recursive: true, force: true });
  fs.renameSync(target, trashed);
}
function createManagerRouter(ctx) {
  const router = (0, import_express.Router)();
  const readOnly = (res, reason) => {
    res.status(403).json({ message: reason });
  };
  const failed = (res, e) => {
    const status = typeof (e == null ? void 0 : e.status) === "number" ? e.status : 405;
    const message = e instanceof Error ? e.message : String(e);
    ctx.log.warn(`CometVisu manager: ${message}`);
    res.status(status).json({ message });
  };
  router.get(["/environment.php", "/environment"], (_req, res) => {
    res.json({
      SERVER_SOFTWARE: `ioBroker.cometvisu ${ctx.version}`,
      phpversion: "none - served by the ioBroker adapter",
      required_php_version: ">=0.0",
      requiresAuth: false
    });
  });
  router.get("/fs/check", (_req, res) => {
    const roots = ctx.roots();
    const writable = ctx.writable();
    res.json([
      { entity: "config", state: environmentState(roots, "", writable) },
      { entity: "backup", state: environmentState(roots, "backup", writable) },
      { entity: "trash", state: environmentState(roots, import_managerFs.TRASH_FOLDER, writable) }
    ]);
  });
  router.get("/fs", (req, res) => {
    const roots = ctx.roots();
    const resolved = (0, import_managerFs.resolvePath)(roots, req.query.path);
    if (!resolved) {
      readOnly(res, "path is not allowed");
      return;
    }
    let stat;
    try {
      stat = fs.statSync(resolved.absolute);
    } catch {
      res.status(404).json({ message: "path not found" });
      return;
    }
    if (stat.isDirectory()) {
      const writable = ctx.writable();
      const entries = (0, import_managerFs.listNames)(roots, resolved.relative).map((name) => describe(roots, resolved.relative, name, writable)).filter((entry) => entry !== null);
      res.json(entries);
      return;
    }
    if (req.query.download === "true") {
      res.download(resolved.absolute, path.basename(resolved.absolute));
      return;
    }
    res.type("text/plain").send(fs.readFileSync(resolved.absolute, "utf8"));
  });
  const guard = (req, res, next) => {
    if (!ctx.writable()) {
      readOnly(res, "editing is disabled - the web instance requires no login");
      return;
    }
    next();
  };
  const text = import_express.default.text({ type: () => true, limit: "16mb" });
  const body = (req, res, next) => {
    var _a;
    if (((_a = req.headers["content-type"]) != null ? _a : "").toLowerCase().startsWith("multipart/")) {
      res.status(415).json({ message: "uploading files is not supported yet" });
      return;
    }
    text(req, res, next);
  };
  router.post("/fs", guard, body, (req, res) => {
    const roots = ctx.roots();
    const resolved = (0, import_managerFs.resolvePath)(roots, req.query.path);
    if (!resolved || resolved.mounted) {
      readOnly(res, "path is not allowed");
      return;
    }
    const target = (0, import_managerFs.writeTarget)(roots, resolved.relative);
    if (fs.existsSync(target)) {
      res.status(406).json({ message: "file exists" });
      return;
    }
    try {
      if (req.query.type === "dir") {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        writeContent(target, typeof req.body === "string" ? req.body : "", req.query.hash);
      }
    } catch (e) {
      failed(res, e);
      return;
    }
    res.json({ message: "created" });
  });
  router.put("/fs", guard, body, (req, res) => {
    const roots = ctx.roots();
    const resolved = (0, import_managerFs.resolvePath)(roots, req.query.path);
    if (!resolved || resolved.mounted) {
      readOnly(res, "path is not allowed");
      return;
    }
    if (!fs.existsSync(resolved.absolute)) {
      res.status(404).json({ message: "file does not exist" });
      return;
    }
    const target = (0, import_managerFs.writeTarget)(roots, resolved.relative);
    try {
      backup(roots, resolved.relative, resolved.absolute);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeContent(target, typeof req.body === "string" ? req.body : "", req.query.hash);
    } catch (e) {
      failed(res, e);
      return;
    }
    res.json({ message: "saved" });
  });
  router.delete("/fs", guard, (req, res) => {
    const roots = ctx.roots();
    const resolved = (0, import_managerFs.resolvePath)(roots, req.query.path);
    if (!resolved || resolved.mounted || resolved.relative === "") {
      readOnly(res, "path is not allowed");
      return;
    }
    const target = (0, import_managerFs.writeTarget)(roots, resolved.relative);
    if (!fs.existsSync(target)) {
      res.status(404).json({ message: "file not found" });
      return;
    }
    const force = req.query.force === "true";
    try {
      remove(roots, resolved.relative, target, force, resolved.inTrash);
    } catch (e) {
      failed(res, e);
      return;
    }
    res.json({ message: "deleted" });
  });
  router.put("/fs/move", guard, (req, res) => transfer(req, res, "move"));
  router.put("/fs/copy", guard, (req, res) => transfer(req, res, "copy"));
  function transfer(req, res, mode) {
    const roots = ctx.roots();
    const source = (0, import_managerFs.resolvePath)(roots, req.query.src);
    const destination = (0, import_managerFs.resolvePath)(roots, req.query.target);
    if (!source || !destination || destination.mounted || mode === "move" && source.mounted) {
      readOnly(res, "path is not allowed");
      return;
    }
    if (!fs.existsSync(source.absolute)) {
      res.status(404).json({ message: "source does not exist" });
      return;
    }
    const target = (0, import_managerFs.writeTarget)(roots, destination.relative);
    if (fs.existsSync(target) && req.query.force !== "true") {
      res.status(406).json({ message: "target does exist" });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source.absolute, target, { recursive: true, force: true });
      if (mode === "move") {
        fs.rmSync((0, import_managerFs.writeTarget)(roots, source.relative), { recursive: true, force: true });
      }
    } catch (e) {
      failed(res, e);
      return;
    }
    res.json({ message: mode === "move" ? "moved" : "copied" });
  }
  const hiddenFile = (roots) => (0, import_managerFs.writeTarget)(roots, "hidden.json");
  const readHidden = (roots) => {
    const file = hiddenFile(roots);
    if (!fs.existsSync(file)) {
      return {};
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      ctx.log.warn(`CometVisu manager: ${file} is not readable as JSON, starting over`);
      return {};
    }
  };
  const writeHidden = (roots, value) => {
    const file = hiddenFile(roots);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}
`);
  };
  router.get(["/config/hidden", "/config/hidden/:section", "/config/hidden/:section/:key"], (req, res) => {
    var _a, _b;
    const hidden = readHidden(ctx.roots());
    const { section, key } = req.params;
    if (!section) {
      res.json(hidden);
      return;
    }
    if (!key) {
      res.json((_a = hidden[section]) != null ? _a : {});
      return;
    }
    if (!Object.prototype.hasOwnProperty.call((_b = hidden[section]) != null ? _b : {}, key)) {
      res.status(404).json({ message: "config option does not exist" });
      return;
    }
    res.json(hidden[section][key]);
  });
  router.put("/config/hidden", guard, import_express.default.json({ limit: "1mb" }), (req, res) => {
    if (!req.body || typeof req.body !== "object") {
      res.status(405).json({ message: "expected an object" });
      return;
    }
    writeHidden(ctx.roots(), req.body);
    res.json({ message: "saved" });
  });
  for (const method of ["post", "put"]) {
    router[method]("/config/hidden/:section/:key", guard, body, (req, res) => {
      var _a, _b;
      const roots = ctx.roots();
      const hidden = readHidden(roots);
      const { section, key } = req.params;
      const exists = Object.prototype.hasOwnProperty.call((_a = hidden[section]) != null ? _a : {}, key);
      if (method === "post" && exists) {
        res.status(404).json({ message: "config option does exist" });
        return;
      }
      if (method === "put" && !exists) {
        res.status(404).json({ message: "config option does not exist" });
        return;
      }
      hidden[section] = (_b = hidden[section]) != null ? _b : {};
      hidden[section][key] = typeof req.body === "string" ? req.body : "";
      writeHidden(roots, hidden);
      res.json({ message: "saved" });
    });
  }
  router.delete("/config/hidden/:section/:key", guard, (req, res) => {
    var _a;
    const roots = ctx.roots();
    const hidden = readHidden(roots);
    const { section, key } = req.params;
    if (!Object.prototype.hasOwnProperty.call((_a = hidden[section]) != null ? _a : {}, key)) {
      res.status(404).json({ message: "config option does not exist" });
      return;
    }
    delete hidden[section][key];
    if (Object.keys(hidden[section]).length === 0) {
      delete hidden[section];
    }
    writeHidden(roots, hidden);
    res.json({ message: "deleted" });
  });
  router.get("/data/designs", (_req, res) => {
    const roots = ctx.roots();
    const names = /* @__PURE__ */ new Set();
    for (const root of [roots.build, roots.overlay]) {
      if (!root) {
        continue;
      }
      const designs = path.join(path.dirname(root), "designs");
      try {
        for (const entry of fs.readdirSync(designs, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            names.add(entry.name);
          }
        }
      } catch {
      }
    }
    res.json([...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name })));
  });
  router.get("/data/addresses", (_req, res) => {
    ctx.addresses().then(
      (entries) => res.json(entries),
      (e) => failed(res, e)
    );
  });
  return router;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createManagerRouter
});
//# sourceMappingURL=managerApi.js.map
