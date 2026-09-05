// Lists CometVisu GitHub releases and downloads/unpacks the selected one into the instance
// data directory, so the webserver can serve it.

import axios from 'axios';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';

const REPO = 'CometVisu/CometVisu';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

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
const LEGACY_LATEST_LABEL = 'latest release';

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
        const tag = value.slice(LEGACY_OFFICIAL_PREFIX.length);
        return { kind: 'release', tag: tag === LEGACY_LATEST_LABEL ? '' : tag };
    }
    if (value.startsWith(CUSTOM_PREFIX)) {
        return { kind: 'custom', file: value.slice(CUSTOM_PREFIX.length) };
    }
    if (value === CUSTOM_VERSION) {
        return { kind: 'custom', file: legacyBuildUpload || '' };
    }
    return { kind: 'release', tag: value };
}

interface Asset {
    name: string;
    browser_download_url: string;
    size: number;
}
interface Release {
    tag_name: string;
    name: string;
    prerelease: boolean;
    assets: Asset[];
}

function githubHeaders(): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'iobroker.cometvisu',
    };
}

/**
 * The CometVisu build archive of a release, e.g. "CometVisu-v0.12.6.tar.gz".
 *
 * @param release the GitHub release to inspect
 */
function buildAsset(release: Release): Asset | undefined {
    const exact = `cometvisu-${release.tag_name.toLowerCase()}.tar.gz`;
    return (
        release.assets.find(a => a.name.toLowerCase() === exact) ||
        release.assets.find(a => /^CometVisu-.*\.tar\.gz$/i.test(a.name))
    );
}

async function fetchReleases(): Promise<Release[]> {
    const res = await axios.get<Release[]>(RELEASES_URL, { headers: githubHeaders(), timeout: 20000 });
    // only releases that actually ship a built archive can be served
    return res.data.filter(r => !!buildAsset(r));
}

async function resolveRelease(version: string): Promise<Release> {
    const releases = await fetchReleases();
    if (!releases.length) {
        throw new Error('no CometVisu release with a build archive was found');
    }
    if (!version) {
        // latest: newest stable, or newest overall if there is no stable release
        return releases.find(r => !r.prerelease) || releases[0];
    }
    const release = releases.find(r => r.tag_name === version);
    if (!release) {
        throw new Error(`CometVisu release "${version}" not found`);
    }
    return release;
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
 * Make sure the requested version is available locally and return the directory to serve.
 * Downloads and unpacks the release once, then reuses the cached copy.
 *
 * @param dataDir the instance data directory to unpack into
 * @param version the release tag to serve, '' for the latest release
 * @param log the adapter logger
 */
export async function ensureRelease(
    dataDir: string,
    version: string,
    log: ioBroker.Logger,
): Promise<{ tag: string; htmlRoot: string }> {
    const release = await resolveRelease(version);
    const targetDir = path.join(dataDir, 'cometvisu', release.tag_name);
    const marker = path.join(targetDir, '.complete');

    if (fs.existsSync(marker)) {
        log.debug(`CometVisu ${release.tag_name} is already present`);
        return { tag: release.tag_name, htmlRoot: findHtmlRoot(targetDir) };
    }

    const asset = buildAsset(release);
    if (!asset) {
        throw new Error(`release ${release.tag_name} has no CometVisu build archive`);
    }

    // a partial previous download must not be served
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    log.info(`downloading CometVisu ${release.tag_name} (${asset.name}, ${Math.round(asset.size / 1048576)} MB)`);
    const res = await axios.get<NodeJS.ReadableStream>(asset.browser_download_url, {
        headers: githubHeaders(),
        responseType: 'stream',
        timeout: 120000,
    });

    await extractTarball(res.data, targetDir);

    fs.writeFileSync(marker, new Date().toISOString());
    log.info(`CometVisu ${release.tag_name} unpacked to ${targetDir}`);
    return { tag: release.tag_name, htmlRoot: findHtmlRoot(targetDir) };
}

/**
 * Extract a .tar.gz into targetDir. node-tar auto-detects the gzip, so both a download stream and a
 * path to a local .tgz can be handed in.
 *
 * @param source a readable .tar.gz stream or the path to a local .tar.gz file
 * @param targetDir the directory to extract into (must already exist)
 */
function extractTarball(source: NodeJS.ReadableStream | string, targetDir: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const extract = tar.x({ cwd: targetDir });
        const input: NodeJS.ReadableStream = typeof source === 'string' ? fs.createReadStream(source) : source;
        input.on('error', reject);
        extract.on('error', reject);
        extract.on('finish', () => resolve());
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

    // a previous build of the same archive must be replaced completely
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    log.info(`unpacking uploaded CometVisu build "${source.file}"`);
    await extractTarball(tgzPath, targetDir);

    const htmlRoot = findHtmlRoot(targetDir);
    if (htmlRoot === targetDir && !fs.existsSync(path.join(targetDir, 'index.html'))) {
        fs.rmSync(targetDir, { recursive: true, force: true });
        throw new Error('the uploaded archive does not contain a CometVisu build (no index.html found)');
    }

    fs.writeFileSync(path.join(targetDir, '.complete'), new Date().toISOString());
    fs.writeFileSync(path.join(targetDir, '.source'), JSON.stringify(source));
    log.info(`uploaded CometVisu build unpacked to ${targetDir}`);
    return { tag: source.file, htmlRoot };
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
