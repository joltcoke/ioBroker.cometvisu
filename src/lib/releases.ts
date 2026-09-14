// Unpacks the CometVisu build that was selected in the admin into the instance data directory, so
// the web adapter can serve it. The release list is read by the admin component, not here: it hands
// over the download URL of the archive it picked, which keeps GitHub out of the adapter's start.

import axios from 'axios';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar';

const REPO = 'CometVisu/CometVisu';
/** Only an archive from this project's releases may be downloaded, whoever asks for it. */
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** Directory (and legacy version value) for a build the user uploaded instead of a GitHub release. */
export const CUSTOM_VERSION = '__custom__';
/** Legacy version values for uploaded builds were "__custom__:<file name>". */
export const CUSTOM_PREFIX = `${CUSTOM_VERSION}:`;

// The admin shows one list: the archives the user uploaded (they are the only files in the
// instance's "files" meta object) and the GitHub releases, which the admin component fetches
// itself. The configured value carries the prefix of the entry that was picked.
/** Value prefix for an archive the user uploaded; the rest is the file name as stored. */
export const CUSTOM_FILE_PREFIX = '[Custom] ';
/** Value prefix for a GitHub release; the rest is the tag. */
export const OFFICIAL_FILE_PREFIX = '[Official] ';

// values written by earlier adapter versions
const LEGACY_CUSTOM_PREFIX = 'Custom: ';
const LEGACY_OFFICIAL_PREFIX = 'Official: ';

/** What a configured version value refers to. */
export type VersionSelection = { kind: 'custom'; file: string } | { kind: 'release'; tag: string };

/**
 * Resolve the configured version to either an uploaded archive or a GitHub release tag. The values
 * written by earlier adapter versions are still accepted, so an existing instance keeps working.
 *
 * @param value the configured version value
 * @param legacyBuildUpload file name from the former separate upload field, used by the bare
 * "__custom__" legacy value
 */
export function resolveVersionSelection(value: string, legacyBuildUpload?: string): VersionSelection {
    if (value.startsWith(CUSTOM_FILE_PREFIX)) {
        return { kind: 'custom', file: value.slice(CUSTOM_FILE_PREFIX.length) };
    }
    if (value.startsWith(OFFICIAL_FILE_PREFIX)) {
        return { kind: 'release', tag: value.slice(OFFICIAL_FILE_PREFIX.length) };
    }
    // legacy values
    if (value.startsWith(LEGACY_CUSTOM_PREFIX)) {
        // those uploads were stored including the prefix
        return { kind: 'custom', file: value };
    }
    if (value.startsWith(LEGACY_OFFICIAL_PREFIX)) {
        return { kind: 'release', tag: value.slice(LEGACY_OFFICIAL_PREFIX.length) };
    }
    if (value.startsWith(CUSTOM_PREFIX)) {
        return { kind: 'custom', file: value.slice(CUSTOM_PREFIX.length) };
    }
    if (value === CUSTOM_VERSION) {
        return { kind: 'custom', file: legacyBuildUpload || '' };
    }
    return { kind: 'release', tag: value };
}

function githubHeaders(): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'iobroker.cometvisu',
    };
}

/**
 * Finds the directory to serve inside the extracted archive. CometVisu ships its app under a
 * "cometvisu/release/" sub path, so this returns the shallowest directory that holds index.html.
 *
 * @param dir the directory the archive was extracted into
 */
export function findHtmlRoot(dir: string): string {
    // breadth-first search so the app root ("release/") wins over deeper index.html files
    let level = [dir];
    for (let depth = 0; depth < 5 && level.length; depth++) {
        const next: string[] = [];
        for (const current of level) {
            if (fs.existsSync(path.join(current, 'index.html'))) {
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

/**
 * How far preparing a build has come. The two phases overlap - tar writes while the download is
 * still running - so "unpacking" means the last byte has arrived and only the writing is left.
 */
export interface PrepareProgress {
    /** which part of the work is running */
    phase: 'downloading' | 'unpacking';
    /** bytes that have arrived so far, undefined before the first chunk */
    done?: number;
    /** the size GitHub announced, undefined when it announced none */
    total?: number;
}

/**
 * Where a release is unpacked to. The tag is the directory name, so the disk tells what is there.
 *
 * @param dataDir the instance data directory
 * @param tag the release tag
 */
export function releaseBuildDir(dataDir: string, tag: string): string {
    return path.join(dataDir, 'cometvisu', tag);
}

/**
 * The unpacked build of a release, or null when it is not (completely) there.
 *
 * @param dataDir the instance data directory
 * @param tag the release tag
 */
export function readReleaseBuild(dataDir: string, tag: string): { tag: string; htmlRoot: string } | null {
    const targetDir = releaseBuildDir(dataDir, tag);
    return fs.existsSync(path.join(targetDir, '.complete')) ? { tag, htmlRoot: findHtmlRoot(targetDir) } : null;
}

/**
 * Download the build archive of a release and unpack it. Called when the admin activates a release,
 * never at start - by then the build is either there or the instance has nothing to serve.
 *
 * @param dataDir the instance data directory to unpack into
 * @param tag the release tag, which names the directory
 * @param url the archive to download, as picked by the admin component
 * @param log the adapter logger
 * @param onProgress told how far the download has come, so the admin can show it
 */
export async function ensureRelease(
    dataDir: string,
    tag: string,
    url: string,
    log: ioBroker.Logger,
    onProgress?: (progress: PrepareProgress) => void,
): Promise<{ tag: string; htmlRoot: string }> {
    if (!tag) {
        throw new Error('no CometVisu release given');
    }
    // The URL travels through the admin and the instance object, both of which can be edited, and
    // whatever arrives here is downloaded and unpacked. So it has to come from the project itself.
    if (!url.startsWith(DOWNLOAD_PREFIX)) {
        throw new Error(`"${url}" is not a download of ${REPO} releases`);
    }

    const present = readReleaseBuild(dataDir, tag);
    if (present) {
        log.debug(`CometVisu ${tag} is already present`);
        return present;
    }

    const targetDir = releaseBuildDir(dataDir, tag);
    // Unpacked next to the final directory and only swapped in once whole, the same way an upload
    // is handled: a download that breaks off must not leave something half unpacked behind that the
    // next start would take for a finished build.
    const stagingDir = `${targetDir}.tmp`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
        log.info(`downloading CometVisu ${tag} from ${url}`);
        onProgress?.({ phase: 'downloading' });
        const res = await axios.get<NodeJS.ReadableStream>(url, {
            headers: githubHeaders(),
            responseType: 'stream',
            timeout: 120000,
        });
        const total = Number(res.headers?.['content-length']) || undefined;
        await extractTarball(
            res.data,
            stagingDir,
            onProgress && (done => onProgress({ phase: 'downloading', done, total })),
            onProgress && (() => onProgress({ phase: 'unpacking' })),
        );

        if (!fs.existsSync(path.join(findHtmlRoot(stagingDir), 'index.html'))) {
            throw new Error('the downloaded archive does not contain a CometVisu build (no index.html found)');
        }
        fs.writeFileSync(path.join(stagingDir, '.complete'), new Date().toISOString());

        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, targetDir);
    } finally {
        // nothing to remove after a successful rename, everything after a failure
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    log.info(`CometVisu ${tag} unpacked to ${targetDir}`);
    return { tag, htmlRoot: findHtmlRoot(targetDir) };
}

/**
 * Extract a .tar.gz into targetDir. node-tar auto-detects the gzip, so both a download stream and a
 * path to a local .tgz can be handed in.
 *
 * @param source a readable .tar.gz stream or the path to a local .tar.gz file
 * @param targetDir the directory to extract into (must already exist)
 * @param onBytes told how many bytes have arrived so far
 * @param onRead told when the source is through and only the writing is left
 */
function extractTarball(
    source: NodeJS.ReadableStream | string,
    targetDir: string,
    onBytes?: (bytes: number) => void,
    onRead?: () => void,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const extract = tar.x({ cwd: targetDir });
        const input: NodeJS.ReadableStream = typeof source === 'string' ? fs.createReadStream(source) : source;
        input.on('error', reject);
        extract.on('error', reject);
        extract.on('finish', () => resolve());
        if (onBytes) {
            // Counted here and not around the pipe: a stream emits nothing synchronously, so the
            // listener is in place before the first chunk moves, and no byte is missed.
            let bytes = 0;
            input.on('data', (chunk: Buffer | string) => onBytes((bytes += chunk.length)));
        }
        // The source is through, only the writing is left - which is not the same moment as the
        // promise resolving, that one waits for tar to have written everything.
        input.on('end', () => onRead?.());
        input.pipe(extract);
    });
}

/** What an uploaded archive was when it was unpacked, so a re-upload can be told apart. */
export interface CustomBuildSource {
    /** name of the uploaded archive in the instance's file storage */
    file: string;
    /** byte size of that archive, unknown for builds of an older adapter version */
    size?: number;
    /** upload time of that archive, unknown for builds of an older adapter version */
    modifiedAt?: number;
}

/**
 * Directory that holds one sub directory per uploaded build.
 *
 * @param dataDir the instance data directory
 */
function customRootDir(dataDir: string): string {
    return path.join(dataDir, 'cometvisu', 'custom');
}

/**
 * The directory an uploaded archive is unpacked into. Every upload gets its own one, so several
 * uploaded builds can exist side by side and switching between them needs no unpacking. The name is
 * derived from the archive's file name, which makes an upload under the same name replace exactly
 * that build. The hash keeps names apart that only the sanitizing would make equal ("a b.tgz" and
 * "a_b.tgz").
 *
 * @param dataDir the instance data directory
 * @param file name of the uploaded archive
 */
export function customBuildDir(dataDir: string, file: string): string {
    const readable = file.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
    const hash = createHash('sha1').update(file).digest('hex').slice(0, 8);
    return path.join(customRootDir(dataDir), `${readable}__${hash}`);
}

/**
 * Unpack a CometVisu build the user uploaded through the admin into its own directory and return the
 * directory to serve. Behaves like {@link ensureRelease}, only the source is a local file.
 *
 * @param tgzPath path to the uploaded .tar.gz file
 * @param dataDir the instance data directory to unpack into
 * @param log the adapter logger
 * @param source describes the uploaded archive, stored so a later start can tell whether this build
 * still matches the archive in the file storage
 */
export async function unpackUploadedTarball(
    tgzPath: string,
    dataDir: string,
    log: ioBroker.Logger,
    source: CustomBuildSource,
): Promise<{ tag: string; htmlRoot: string }> {
    if (!fs.existsSync(tgzPath)) {
        throw new Error(`uploaded build archive not found at ${tgzPath}`);
    }
    const targetDir = customBuildDir(dataDir, source.file);
    // Unpacked beside the final directory and only swapped in once it is complete. An upload of an
    // archive that is already in use is unpacked while the web adapter serves the previous build of
    // it, so that one must stay in place until there is a whole new one - and has to survive an
    // upload that turns out to be no CometVisu build at all.
    const stagingDir = `${targetDir}.tmp`;

    // a leftover of an unpacking that was cut short must not be added to
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
        log.info(`unpacking uploaded CometVisu build "${source.file}"`);
        await extractTarball(tgzPath, stagingDir);

        if (!fs.existsSync(path.join(findHtmlRoot(stagingDir), 'index.html'))) {
            throw new Error('the uploaded archive does not contain a CometVisu build (no index.html found)');
        }

        fs.writeFileSync(path.join(stagingDir, '.complete'), new Date().toISOString());
        fs.writeFileSync(path.join(stagingDir, '.source'), JSON.stringify(source));

        // the only moment in which the previous build is gone
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.renameSync(stagingDir, targetDir);
    } finally {
        // nothing to remove after a successful rename, everything after a failure
        fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    log.info(`uploaded CometVisu build unpacked to ${targetDir}`);
    return { tag: source.file, htmlRoot: findHtmlRoot(targetDir) };
}

/**
 * Read the ".source" marker of an unpacked build. Older adapter versions stored the plain file name,
 * which is still understood - the missing size and time then simply mean "unknown".
 *
 * @param targetDir directory of the unpacked build
 */
function readSource(targetDir: string): CustomBuildSource | null {
    const sourceFile = path.join(targetDir, '.source');
    if (!fs.existsSync(sourceFile)) {
        return null;
    }
    const content = fs.readFileSync(sourceFile, 'utf8').trim();
    try {
        const parsed = JSON.parse(content);
        return typeof parsed?.file === 'string' ? (parsed as CustomBuildSource) : null;
    } catch {
        return content ? { file: content } : null;
    }
}

/**
 * Directory + source info of the build unpacked from a given archive, or null if it is not unpacked.
 *
 * @param dataDir the instance data directory
 * @param file name of the uploaded archive
 */
export function readCustomBuild(
    dataDir: string,
    file: string,
): { htmlRoot: string; source: CustomBuildSource | null } | null {
    const targetDir = customBuildDir(dataDir, file);
    if (!fs.existsSync(path.join(targetDir, '.complete'))) {
        return null;
    }
    return { htmlRoot: findHtmlRoot(targetDir), source: readSource(targetDir) };
}

/**
 * All unpacked builds with the archive each one was made from, used to drop those whose archive was
 * deleted in the admin.
 *
 * @param dataDir the instance data directory
 */
export function listCustomBuilds(dataDir: string): { dir: string; file: string | null }[] {
    const root = customRootDir(dataDir);
    if (!fs.existsSync(root)) {
        return [];
    }
    return fs
        .readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const dir = path.join(root, entry.name);
            return { dir, file: readSource(dir)?.file ?? null };
        });
}

/**
 * Remove the build that was unpacked from a given archive.
 *
 * @param dataDir the instance data directory
 * @param file name of the uploaded archive
 */
export function removeCustomBuild(dataDir: string, file: string): boolean {
    const targetDir = customBuildDir(dataDir, file);
    if (!fs.existsSync(targetDir)) {
        return false;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    return true;
}

/**
 * Remove the single directory all uploads shared before every upload got its own one.
 *
 * @param dataDir the instance data directory
 */
export function removeLegacyCustomBuild(dataDir: string): boolean {
    const legacyDir = path.join(dataDir, 'cometvisu', CUSTOM_VERSION);
    if (!fs.existsSync(legacyDir)) {
        return false;
    }
    fs.rmSync(legacyDir, { recursive: true, force: true });
    return true;
}

/**
 * Drop every unpacked release except the one that is served. A release is not kept as an archive but
 * as its unpacked directory, so trying out versions would pile them up without this.
 *
 * @param dataDir the instance data directory
 * @param keepTag tag of the release to keep, null when an uploaded build is served
 * @returns the tags whose directories were removed
 */
export function pruneReleaseBuilds(dataDir: string, keepTag: string | null): string[] {
    const root = path.join(dataDir, 'cometvisu');
    if (!fs.existsSync(root)) {
        return [];
    }
    // the uploaded builds live next to the releases and are kept
    const keep = new Set([CUSTOM_VERSION, 'custom', keepTag]);
    const removed: string[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || keep.has(entry.name)) {
            continue;
        }
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
    }
    return removed;
}
