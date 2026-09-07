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
var managerFs_exports = {};
__export(managerFs_exports, {
  BACKUP_FOLDER: () => BACKUP_FOLDER,
  BACKUP_ON_CHANGE: () => BACKUP_ON_CHANGE,
  TRASH_FOLDER: () => TRASH_FOLDER,
  backupName: () => backupName,
  buildRoots: () => buildRoots,
  isInside: () => isInside,
  listNames: () => listNames,
  normalizeRelative: () => normalizeRelative,
  resolvePath: () => resolvePath,
  writeTarget: () => writeTarget
});
module.exports = __toCommonJS(managerFs_exports);
var fs = __toESM(require("node:fs"));
var path = __toESM(require("node:path"));
const TRASH_FOLDER = ".trash";
const BACKUP_FOLDER = "backup";
const BACKUP_ON_CHANGE = /^visu_config(?!_previewtemp).*\.xml$/;
function buildRoots(dataDir, htmlRoot) {
  const overlayResource = path.join(dataDir, "resource");
  const buildResource = htmlRoot ? path.join(htmlRoot, "resource") : null;
  const mounts = [];
  if (buildResource) {
    mounts.push({
      mountPoint: "demo",
      path: path.join(buildResource, "demo"),
      showSubDirs: true,
      visible: true
    });
    mounts.push({
      mountPoint: "resource/custom_visu_config.xsd",
      path: path.join(buildResource, "custom_visu_config.xsd"),
      showSubDirs: false,
      visible: false
    });
  }
  return {
    overlay: path.join(overlayResource, "config"),
    build: buildResource ? path.join(buildResource, "config") : null,
    mounts
  };
}
function normalizeRelative(value) {
  if (value === void 0 || value === null) {
    return "";
  }
  if (typeof value !== "string" || value.includes("\0")) {
    return null;
  }
  const raw = value.trim();
  if (raw === "" || raw === "." || raw === "/") {
    return "";
  }
  const segments = [];
  for (const segment of raw.split(/[/\\]+/)) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}
function isInside(root, candidate) {
  const resolvedRoot = realpathOrSelf(root);
  const resolved = realpathOrSelf(candidate);
  if (resolved === resolvedRoot) {
    return true;
  }
  return resolved.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep);
}
function realpathOrSelf(target) {
  let current = path.resolve(target);
  const missing = [];
  for (; ; ) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
function resolvePath(roots, value) {
  const relative = normalizeRelative(value);
  if (relative === null) {
    return null;
  }
  const inTrash = relative === TRASH_FOLDER || relative.startsWith(`${TRASH_FOLDER}/`);
  for (const mount of roots.mounts) {
    if (relative === mount.mountPoint || relative.startsWith(`${mount.mountPoint}/`)) {
      const rest = relative.slice(mount.mountPoint.length).replace(/^\//, "");
      const absolute = rest ? path.join(mount.path, ...rest.split("/")) : mount.path;
      if (!isInside(mount.path, absolute)) {
        return null;
      }
      return { absolute, relative, writeable: false, mounted: true, inTrash: false };
    }
  }
  const segments = relative === "" ? [] : relative.split("/");
  const inOverlay = path.join(roots.overlay, ...segments);
  if (!isInside(roots.overlay, inOverlay)) {
    return null;
  }
  if (fs.existsSync(inOverlay) || !roots.build) {
    return { absolute: inOverlay, relative, writeable: true, mounted: false, inTrash };
  }
  const inBuild = path.join(roots.build, ...segments);
  if (!isInside(roots.build, inBuild)) {
    return null;
  }
  if (fs.existsSync(inBuild)) {
    return { absolute: inBuild, relative, writeable: true, mounted: false, inTrash };
  }
  return { absolute: inOverlay, relative, writeable: true, mounted: false, inTrash };
}
function writeTarget(roots, relative) {
  return relative === "" ? roots.overlay : path.join(roots.overlay, ...relative.split("/"));
}
function backupName(name, stamp) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  const time = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const parts = name.split(".");
  const suffix = parts.length > 1 ? parts.pop() : null;
  return suffix ? `${parts.join(".")}-${time}.${suffix}` : `${name}-${time}`;
}
function listNames(roots, relative) {
  const names = /* @__PURE__ */ new Set();
  for (const mount of roots.mounts) {
    if (relative === mount.mountPoint || relative.startsWith(`${mount.mountPoint}/`)) {
      if (!mount.showSubDirs && relative !== mount.mountPoint) {
        return [];
      }
      const rest = relative.slice(mount.mountPoint.length).replace(/^\//, "");
      const dir = rest ? path.join(mount.path, ...rest.split("/")) : mount.path;
      if (!isInside(mount.path, dir)) {
        return [];
      }
      try {
        return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
      } catch {
        return [];
      }
    }
  }
  for (const root of [roots.build, roots.overlay]) {
    if (!root) {
      continue;
    }
    const dir = relative === "" ? root : path.join(root, ...relative.split("/"));
    if (!isInside(root, dir)) {
      continue;
    }
    try {
      for (const entry of fs.readdirSync(dir)) {
        names.add(entry);
      }
    } catch {
    }
  }
  if (relative === "") {
    for (const mount of roots.mounts) {
      if (mount.visible && !mount.mountPoint.includes("/") && fs.existsSync(mount.path)) {
        names.add(mount.mountPoint);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BACKUP_FOLDER,
  BACKUP_ON_CHANGE,
  TRASH_FOLDER,
  backupName,
  buildRoots,
  isInside,
  listNames,
  normalizeRelative,
  resolvePath,
  writeTarget
});
//# sourceMappingURL=managerFs.js.map
