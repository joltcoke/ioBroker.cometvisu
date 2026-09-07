// Filesystem behind the CometVisu manager API. The manager edits files below the build's
// "resource/config" directory, but a build is unpacked read-only and gets replaced whenever another
// version is selected. Writes therefore go to the instance data directory, which already overlays
// the build when the visualisation is served (see web.ts). Reading returns the union of both, the
// overlay winning - the same order a browser sees.
//
// The layout follows the reference backend shipped with CometVisu
// (source/rest/manager/src/config.php): the config directory is the root the manager browses,
// "demo" and "custom_visu_config.xsd" are mounted read-only beside it, and deleted files are moved
// into a ".trash" folder.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Name of the trash folder inside the config directory. */
export const TRASH_FOLDER = '.trash';

/** Name of the backup folder inside the config directory. */
export const BACKUP_FOLDER = 'backup';

/** Files that get a copy in the backup folder before they are overwritten. */
export const BACKUP_ON_CHANGE = /^visu_config(?!_previewtemp).*\.xml$/;

/** A folder or file of the build that is shown beside the config directory, but never written. */
export interface Mount {
    /** where it appears in the manager, relative to the config directory */
    mountPoint: string;
    /** absolute path it points at */
    path: string;
    /** whether its sub directories are shown */
    showSubDirs: boolean;
    /** whether the manager lists it at all */
    visible: boolean;
}

/** The directories the manager API works on. */
export interface ManagerRoots {
    /** writable config directory in the instance data directory */
    overlay: string;
    /** read-only config directory of the unpacked build, null while no build is served */
    build: string | null;
    /** read-only entries from the build shown beside the config directory */
    mounts: Mount[];
}

/**
 * Work out the directories for one instance and the build it currently serves.
 *
 * @param dataDir absolute instance data directory
 * @param htmlRoot directory of the served build, null while there is none
 */
export function buildRoots(dataDir: string, htmlRoot: string | null): ManagerRoots {
    const overlayResource = path.join(dataDir, 'resource');
    const buildResource = htmlRoot ? path.join(htmlRoot, 'resource') : null;
    const mounts: Mount[] = [];

    if (buildResource) {
        mounts.push({
            mountPoint: 'demo',
            path: path.join(buildResource, 'demo'),
            showSubDirs: true,
            visible: true,
        });
        // mounting this file lets the manager copy it into the config folder when it is missing
        mounts.push({
            mountPoint: 'resource/custom_visu_config.xsd',
            path: path.join(buildResource, 'custom_visu_config.xsd'),
            showSubDirs: false,
            visible: false,
        });
    }

    return {
        overlay: path.join(overlayResource, 'config'),
        build: buildResource ? path.join(buildResource, 'config') : null,
        mounts,
    };
}

/**
 * Bring a path from a request into the form used internally: relative, "/"-separated, without a
 * leading or trailing slash.
 *
 * A leading slash is not an absolute path here: CometVisu writes the config root that way, for
 * example "/visu_config_previewtemp.xml" for the preview file (FileItem.getFullPath()). Leading
 * separators are therefore stripped, and everything stays below the config directory - what keeps
 * it there is the rejection of ".." and the containment check in resolvePath().
 *
 * Returns null for anything that would leave the root: ".." and NUL bytes.
 *
 * @param value path as it arrived from the client
 */
export function normalizeRelative(value: string | undefined | null): string | null {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value !== 'string' || value.includes('\0')) {
        return null;
    }

    const raw = value.trim();
    if (raw === '' || raw === '.' || raw === '/') {
        return '';
    }

    const segments: string[] = [];
    for (const segment of raw.split(/[/\\]+/)) {
        if (segment === '' || segment === '.') {
            continue;
        }
        if (segment === '..') {
            // climbing out is never allowed, not even when a later segment would come back
            return null;
        }
        segments.push(segment);
    }
    return segments.join('/');
}

/** A path resolved against one of the roots. */
export interface ResolvedPath {
    /** absolute path on disk */
    absolute: string;
    /** relative path inside the manager, "/"-separated */
    relative: string;
    /** whether writing to it is allowed */
    writeable: boolean;
    /** whether it comes from a mount instead of the config directory */
    mounted: boolean;
    /** whether it lies inside the trash folder */
    inTrash: boolean;
}

/**
 * Whether `candidate` really lies inside `root`. Both are resolved first, so a symlink pointing
 * outside is rejected as well.
 *
 * @param root directory that must contain the candidate
 * @param candidate path to check
 */
export function isInside(root: string, candidate: string): boolean {
    const resolvedRoot = realpathOrSelf(root);
    const resolved = realpathOrSelf(candidate);
    if (resolved === resolvedRoot) {
        return true;
    }
    return resolved.startsWith(resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep);
}

/**
 * Resolve a symlink chain, falling back to the path itself while it does not exist yet - a file
 * that is about to be created has no real path.
 *
 * @param target path to resolve
 */
function realpathOrSelf(target: string): string {
    let current = path.resolve(target);
    const missing: string[] = [];

    // walk up until something exists - a file that is about to be created can be several levels
    // below the deepest existing directory
    for (;;) {
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

/**
 * Resolve a path from a request. Mounts win over the config directory, because they are the reason
 * a name like "demo" exists at all. Everything else is looked up in the overlay first and in the
 * build second; a path that exists in neither resolves to the overlay, which is where it would be
 * created.
 *
 * @param roots directories of this instance
 * @param value path as it arrived from the client
 * @returns the resolved path, or null when it is not acceptable
 */
export function resolvePath(roots: ManagerRoots, value: string | undefined | null): ResolvedPath | null {
    const relative = normalizeRelative(value);
    if (relative === null) {
        return null;
    }

    const inTrash = relative === TRASH_FOLDER || relative.startsWith(`${TRASH_FOLDER}/`);

    for (const mount of roots.mounts) {
        if (relative === mount.mountPoint || relative.startsWith(`${mount.mountPoint}/`)) {
            const rest = relative.slice(mount.mountPoint.length).replace(/^\//, '');
            const absolute = rest ? path.join(mount.path, ...rest.split('/')) : mount.path;
            if (!isInside(mount.path, absolute)) {
                return null;
            }
            return { absolute, relative, writeable: false, mounted: true, inTrash: false };
        }
    }

    const segments = relative === '' ? [] : relative.split('/');
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
        // served from the build, but a write creates it in the overlay
        return { absolute: inBuild, relative, writeable: true, mounted: false, inTrash };
    }

    return { absolute: inOverlay, relative, writeable: true, mounted: false, inTrash };
}

/**
 * Where a write for this path has to go. Always the overlay, never the build - a build is replaced
 * whenever another version is selected.
 *
 * @param roots directories of this instance
 * @param relative relative path, already normalized
 */
export function writeTarget(roots: ManagerRoots, relative: string): string {
    return relative === '' ? roots.overlay : path.join(roots.overlay, ...relative.split('/'));
}

/**
 * Name of the backup copy for a file that is about to be overwritten: the name with a timestamp in
 * front of its suffix, as the reference backend does it.
 *
 * @param name file name including its suffix
 * @param stamp timestamp to put into the name
 */
export function backupName(name: string, stamp: Date): string {
    const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
    const time =
        `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
        `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const parts = name.split('.');
    const suffix = parts.length > 1 ? parts.pop() : null;
    return suffix ? `${parts.join('.')}-${time}.${suffix}` : `${name}-${time}`;
}

/**
 * Names of the entries of one directory, merged from overlay and build. The overlay wins, so a file
 * edited by the user hides the one shipped with the build.
 *
 * @param roots directories of this instance
 * @param relative relative path of the directory
 */
export function listNames(roots: ManagerRoots, relative: string): string[] {
    const names = new Set<string>();

    // a path inside a mount is listed from the mount, the config directory has no such folder
    for (const mount of roots.mounts) {
        if (relative === mount.mountPoint || relative.startsWith(`${mount.mountPoint}/`)) {
            if (!mount.showSubDirs && relative !== mount.mountPoint) {
                return [];
            }
            const rest = relative.slice(mount.mountPoint.length).replace(/^\//, '');
            const dir = rest ? path.join(mount.path, ...rest.split('/')) : mount.path;
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
        const dir = relative === '' ? root : path.join(root, ...relative.split('/'));
        if (!isInside(root, dir)) {
            continue;
        }
        try {
            for (const entry of fs.readdirSync(dir)) {
                names.add(entry);
            }
        } catch {
            // not a directory here, the other root may still have it
        }
    }

    if (relative === '') {
        for (const mount of roots.mounts) {
            if (mount.visible && !mount.mountPoint.includes('/') && fs.existsSync(mount.path)) {
                names.add(mount.mountPoint);
            }
        }
    }

    return [...names].sort((a, b) => a.localeCompare(b));
}
