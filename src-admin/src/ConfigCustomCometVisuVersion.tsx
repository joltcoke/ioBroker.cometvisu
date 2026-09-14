import React from 'react';
import {
    Box,
    Button,
    CircularProgress,
    FormControl,
    FormHelperText,
    IconButton,
    InputLabel,
    ListSubheader,
    MenuItem,
    Select,
    Typography,
} from '@mui/material';
import {
    CheckCircle as CheckIcon,
    Delete as DeleteIcon,
    UploadFile as UploadIcon,
    Warning as WarningIcon,
} from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import { I18n } from '@iobroker/gui-components';

/** Value prefix of an uploaded archive; the rest is the file name as stored. */
const CUSTOM_PREFIX = '[Custom] ';
/** Value prefix of a GitHub release; the rest is the tag. */
const OFFICIAL_PREFIX = '[Official] ';
/** Archives the file dialog offers. */
const ACCEPT = '.tgz,.tar.gz,.gz';
const RELEASES_URL = 'https://api.github.com/repos/CometVisu/CometVisu/releases?per_page=100';
/** Only releases that ship this asset can be served by the adapter. */
const BUILD_ASSET = /^CometVisu-.*\.tar\.gz$/i;
/** How long the adapter may take to answer, downloading and unpacking a build included. */
const ANSWER_TIMEOUT = 300000;
/** How often the adapter is asked how far it has come while we wait for it. */
const STATUS_INTERVAL = 1000;
/** How long a mere question may take - it answers from memory or from a look at the disk. */
const QUESTION_TIMEOUT = 5000;

/**
 * Bytes as megabytes with one decimal, for the download progress.
 *
 * @param bytes the number of bytes
 */
function megabytes(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
}

interface Release {
    tag_name: string;
    created_at: string;
    assets: { name: string; browser_download_url: string }[];
}

/**
 * The build archive of a release. A release can carry several - the dev releases ship the archives
 * of the preceding builds as well - so the one named after the tag wins, and only when none matches
 * does the last one count, which is the newest GitHub lists.
 *
 * @param release the release to inspect
 */
function buildArchive(release: Release): string | undefined {
    const archives = (release.assets || []).filter(asset => BUILD_ASSET.test(asset.name));
    const exact = `cometvisu-${release.tag_name.toLowerCase()}.tar.gz`;
    return (archives.find(a => a.name.toLowerCase() === exact) ?? archives.at(-1))?.browser_download_url;
}

interface State extends ConfigGenericState {
    /** uploaded archives, newest upload first */
    uploads: string[];
    /** whether the uploads could actually be read - only then a value can be judged as missing */
    uploadsLoaded: boolean;
    /** release tags, newest release first */
    releases: string[];
    /** the archive the adapter has to download, per release tag */
    archives: Record<string, string>;
    /** whether the releases could actually be fetched */
    releasesLoaded: boolean;
    /** archive picked in the file dialog but not uploaded yet */
    pending: File | null;
    busy: boolean;
    error: string;
    /** something worth saying that is not a failure */
    notice: string;
    /** why the release list is empty, when that is nothing broken - set by loadReleases() alone */
    warning: string;
    /** how far the adapter has come with the build it is preparing, null while it prepares none */
    progress: { phase: string; done?: number; total?: number } | null;
    /** whether the version now shown lies unpacked on the server - what the green tick reports */
    ready: boolean;
}

/**
 * Single control to pick the CometVisu version. It lists the archives uploaded to this instance and
 * the CometVisu releases fetched straight from GitHub, uploads a build archive from the local file
 * dialog and deletes uploads again. Picking a version is mandatory, so an empty value blocks saving.
 */
export default class ConfigCustomCometVisuVersion extends ConfigGeneric<ConfigGenericProps, State> {
    private readonly inputRef = React.createRef<HTMLInputElement>();
    private statusTimer: ReturnType<typeof setInterval> | null = null;

    componentWillUnmount(): void {
        this.stopWatching();
        // Picking a release fetches it at once, so looking around in the list leaves downloads
        // behind. Best effort: React unmounts when the dialog closes, but closing the browser tab
        // does not, which is why the adapter also prunes when it starts.
        void this.sendToInstance('pruneBuilds', {}, QUESTION_TIMEOUT);
        super.componentWillUnmount?.();
    }

    /**
     * Ask the adapter every second how far it has come, as long as we are waiting for it. The work
     * happens on its side, so this is the only way to show anything but a spinning circle.
     */
    private startWatching(): void {
        this.stopWatching();
        this.statusTimer = setInterval(() => {
            void this.sendToInstance('prepareStatus', {}, QUESTION_TIMEOUT).then(status => {
                if (this.statusTimer) {
                    this.setState({ progress: status || null });
                }
            });
        }, STATUS_INTERVAL);
    }

    private stopWatching(): void {
        if (this.statusTimer) {
            clearInterval(this.statusTimer);
            this.statusTimer = null;
        }
        this.setState({ progress: null });
    }

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        this.setState(
            {
                uploads: [],
                uploadsLoaded: false,
                releases: [],
                archives: {},
                releasesLoaded: false,
                pending: null,
                busy: false,
                error: '',
                notice: '',
                warning: '',
                progress: null,
                ready: false,
            },
            () => {
            void this.loadUploads();
            void this.loadReleases();
            void this.refreshReady();
            this.updateError();
        });
    }

    /** Namespace of the meta object the uploaded archives live in. */
    private get objectId(): string {
        const context = this.props.oContext || (this.props as any);
        return `${context.adapterName}.${context.instance}.files`;
    }

    private get socket(): any {
        const context = this.props.oContext || (this.props as any);
        return context.socket;
    }

    /** Our own instance, e.g. "cometvisu.0". */
    private get instanceId(): string {
        const context = this.props.oContext || (this.props as any);
        return `${context.adapterName}.${context.instance}`;
    }

    /**
     * Ask the running instance to prepare a build. A message to a stopped instance is never
     * answered, which would leave the dialog waiting forever - hence the timeout, which is the only
     * thing standing between the two. Anything else must not silently swallow the message.
     *
     * @param command the command to send
     * @param message what the command is about
     * @param timeout how long to wait, the full preparation time when left out
     * @returns the answer, or null when the instance did not answer in time or is not reachable
     */
    private async sendToInstance(
        command: string,
        message: Record<string, string>,
        timeout = ANSWER_TIMEOUT,
    ): Promise<any> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                this.socket.sendTo(this.instanceId, command, message),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve(null), timeout);
                }),
            ]);
        } catch (e: unknown) {
            // the instance is not reachable - findable in the browser console instead of nowhere
            console.warn(`cometvisu: "${command}" to ${this.instanceId} failed`, e);
            return null;
        } finally {
            // an answered question must not leave its timer behind; the status is asked once a
            // second, and those would pile up for as long as the timeout lasts
            clearTimeout(timer);
        }
    }

    /**
     * Whether a configured value points to something that does not exist any more - an upload that
     * was deleted, or a release that is gone. Only a list that was read successfully can tell that,
     * otherwise a failed request would wrongly condemn a perfectly fine value.
     *
     * @param value the configured value
     */
    private isMissing(value: string): boolean {
        if (value.startsWith(CUSTOM_PREFIX)) {
            return this.state.uploadsLoaded && !(this.state.uploads || []).includes(value.slice(CUSTOM_PREFIX.length));
        }
        if (value.startsWith(OFFICIAL_PREFIX)) {
            return (
                this.state.releasesLoaded && !(this.state.releases || []).includes(value.slice(OFFICIAL_PREFIX.length))
            );
        }
        // values of older adapter versions cannot be judged
        return false;
    }

    /** The reason the current value cannot be saved, or undefined when it is fine. */
    private valueError(value: string): string | undefined {
        if (!value) {
            return I18n.t('Please select a CometVisu version');
        }
        return this.isMissing(value) ? I18n.t('The selected CometVisu version is no longer available') : undefined;
    }

    /** Picking a valid version is mandatory: as long as it is not, an error blocks the save button. */
    private updateError(value?: string): void {
        const current = value ?? ((ConfigGeneric.getValue(this.props.data, this.props.attr) as string) || '');
        this.onError(this.props.attr, this.valueError(current));
    }

    private async setValue(value: string): Promise<void> {
        await this.onChange(this.props.attr, value);
        this.updateError(value);
        await this.refreshReady(value);
    }

    /**
     * Ask the adapter whether the version now shown lies unpacked on disk. Every path that changes
     * the value runs through setValue(), so asking there and when the dialog opens covers all of
     * them - and the answer is looked up instead of guessed from what happened last.
     *
     * @param value the value to ask about, the configured one when left out
     */
    private async refreshReady(value?: string): Promise<void> {
        const current = value ?? ((ConfigGeneric.getValue(this.props.data, this.props.attr) as string) || '');
        const answer = await this.sendToInstance('buildStatus', { value: current }, QUESTION_TIMEOUT);
        this.setState({ ready: !!answer?.ready });
    }

    private async loadUploads(): Promise<void> {
        try {
            const entries: { file: string; isDir: boolean; modifiedAt?: number; createdAt?: number }[] =
                await this.socket.readDir(this.objectId, '/');
            const uploads = entries
                .filter(entry => !entry.isDir && !entry.file.startsWith('.'))
                // newest upload first
                .sort((a, b) => (b.modifiedAt || b.createdAt || 0) - (a.modifiedAt || a.createdAt || 0))
                .map(entry => entry.file);
            this.setState({ uploads, uploadsLoaded: true }, () => this.updateError());
        } catch {
            // without a readable list nothing can be judged as missing
            this.setState({ uploads: [], uploadsLoaded: false }, () => this.updateError());
        }
    }

    /**
     * The local time at which the GitHub rate limit resets, an empty string when it is a rate limit
     * without a readable time, and null when the answer is not one at all. Both headers are listed
     * in the API's "access-control-expose-headers", so the browser is allowed to read them.
     *
     * @param response the answer GitHub returned
     */
    private rateLimitReset(response: Response): string | null {
        // GitHub answers 403 for other reasons too, and those stay errors
        if (response.status !== 403 && response.status !== 429) {
            return null;
        }
        if (response.headers.get('x-ratelimit-remaining') !== '0') {
            return null;
        }
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toLocaleTimeString() : '';
    }

    private async loadReleases(): Promise<void> {
        try {
            const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
            if (!response.ok) {
                const reset = this.rateLimitReset(response);
                if (reset !== null) {
                    // nothing is broken: the uploads stay usable and the configured version keeps
                    // being served, so this is a warning and not an error
                    this.setState(
                        {
                            releases: [],
                            archives: {},
                            releasesLoaded: false,
                            warning: reset
                                ? I18n.t(
                                      'The GitHub rate limit for this address is used up, the official releases cannot be listed until %s',
                                      reset,
                                  )
                                : I18n.t(
                                      'The GitHub rate limit for this address is used up, the official releases cannot be listed right now',
                                  ),
                        },
                        () => this.updateError(),
                    );
                    return;
                }
                throw new Error(`GitHub returned ${response.status}`);
            }
            const releases: Release[] = await response.json();
            // The archive is picked here and handed to the adapter later, so it never needs the
            // GitHub API itself - neither when a version is chosen nor when it starts.
            const archives: Record<string, string> = {};
            for (const release of releases) {
                const url = buildArchive(release);
                if (url) {
                    archives[release.tag_name] = url;
                }
            }
            this.setState(
                {
                    releases: releases
                        .filter(release => !!archives[release.tag_name])
                        // newest release first
                        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
                        .map(release => release.tag_name),
                    archives,
                    releasesLoaded: true,
                    warning: '',
                },
                () => this.updateError()
            );
        } catch (e: unknown) {
            // the uploads stay usable even without GitHub
            this.setState(
                {
                    releases: [],
                    archives: {},
                    releasesLoaded: false,
                    warning: '',
                    error: `could not load the CometVisu releases: ${e instanceof Error ? e.message : String(e)}`,
                },
                () => this.updateError()
            );
        }
    }

    private onPick = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const file = event.target.files?.[0] || null;
        // allow picking the same file again later
        event.target.value = '';
        this.setState({ pending: file, error: '', notice: '' });
    };

    private async upload(): Promise<void> {
        const file = this.state.pending;
        if (!file) {
            return;
        }
        this.setState({ busy: true, error: '', notice: '' });
        try {
            const content = await file.arrayBuffer();
            await this.socket.writeFile64(this.objectId, file.name, content);
            // Let the adapter unpack the archive right here. Uploading it again under the name it
            // already had leaves the configuration untouched, so saving would not restart the
            // instance and the build of the previous archive would stay in use.
            this.startWatching();
            const answer = await this.sendToInstance('prepareCustomBuild', { file: file.name });
            this.stopWatching();
            await this.loadUploads();
            this.setState({
                pending: null,
                busy: false,
                error: answer && !answer.ok ? answer.error || I18n.t('The archive could not be unpacked') : '',
                // an upload that quietly changes nothing is the worst of the three outcomes, so the
                // one case that is neither success nor failure says so in words
                notice: answer ? '' : I18n.t('The instance did not answer, the upload is unpacked when it starts'),
            });
            await this.setValue(`${CUSTOM_PREFIX}${file.name}`);
        } catch (e: unknown) {
            this.stopWatching();
            this.setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
        }
    }

    /**
     * Activate a version. An uploaded archive is unpacked the moment it is uploaded, a release has
     * to be fetched first - and only once the adapter reports it ready does the value change, so the
     * configuration never points at something that is not on disk.
     *
     * @param value the entry that was picked in the list
     */
    private async select(value: string): Promise<void> {
        if (!value.startsWith(OFFICIAL_PREFIX)) {
            await this.setValue(value);
            return;
        }
        const tag = value.slice(OFFICIAL_PREFIX.length);
        const url = this.state.archives?.[tag];
        if (!url) {
            this.setState({ error: I18n.t('%s ships no CometVisu build archive', tag), notice: '' });
            return;
        }

        // The choice shows at once, the build is fetched afterwards - waiting for the adapter would
        // leave the previous name in the field for the length of a download, which reads as if that
        // one were being fetched. What is really on disk is told by the tick, which stays away
        // until the build lies there.
        await this.setValue(value);
        this.setState({ busy: true, error: '', notice: '' });
        this.startWatching();
        const answer = await this.sendToInstance('prepareRelease', { tag, url });
        this.stopWatching();
        this.setState({
            busy: false,
            error: answer?.ok
                ? ''
                : answer
                  ? answer.error || I18n.t('The release could not be prepared')
                  : I18n.t('The instance did not answer - it has to be running to download a release'),
        });
        await this.refreshReady();
    }

    private async remove(fileName: string): Promise<void> {
        this.setState({ busy: true, error: '', notice: '' });
        try {
            await this.socket.deleteFile(this.objectId, fileName);
            // let the adapter drop the unpacked build right away; if it is not running, its next
            // start removes the leftovers, so an unanswered message must not disturb the user
            await this.sendToInstance('deleteCustomBuild', { file: fileName });
            await this.loadUploads();
            this.setState({ busy: false });
            if (ConfigGeneric.getValue(this.props.data, this.props.attr) === `${CUSTOM_PREFIX}${fileName}`) {
                await this.setValue('');
            }
        } catch (e: unknown) {
            this.setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
        }
    }

    renderItem(): React.JSX.Element {
        const progress = this.state.progress;
        // only the download can be measured; unpacking has no length, so the circle keeps spinning
        const percent =
            progress?.phase === 'downloading' && progress.total
                ? Math.round(((progress.done || 0) / progress.total) * 100)
                : null;
        const value = (ConfigGeneric.getValue(this.props.data, this.props.attr) as string) || '';
        const uploads = this.state.uploads || [];
        const releases = this.state.releases || [];
        // uploads first (newest upload on top), then the releases (newest release on top)
        const options = [
            ...uploads.map(file => `${CUSTOM_PREFIX}${file}`),
            ...releases.map(tag => `${OFFICIAL_PREFIX}${tag}`),
        ];
        // A configured value that is not in the list is still shown, otherwise nobody could tell what
        // is set. It is marked though, and valueError() keeps it from being saved.
        const orphan = value && !options.includes(value) ? value : null;
        if (orphan) {
            options.unshift(orphan);
        }
        const error = this.valueError(value);
        // the group headers name the two kinds, so the prefix is dropped from the label - it stays
        // part of the value, that is what tells the adapter an upload from a release tag
        const label = (option: string): string => {
            const name = option.startsWith(CUSTOM_PREFIX)
                ? option.slice(CUSTOM_PREFIX.length)
                : option.startsWith(OFFICIAL_PREFIX)
                  ? option.slice(OFFICIAL_PREFIX.length)
                  : option;
            return this.isMissing(option) ? I18n.t('%s (missing)', name) : name;
        };
        const entry = (option: string): React.JSX.Element => (
            <MenuItem
                key={option}
                value={option}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', gap: 1 }}>
                    <Box sx={{ flexGrow: 1 }}>{label(option)}</Box>
                    {this.isMissing(option) ? (
                        // nothing left to delete here, the archive is already gone
                        <WarningIcon
                            fontSize="small"
                            color="warning"
                            titleAccess={I18n.t('This version is no longer available')}
                        />
                    ) : option.startsWith(CUSTOM_PREFIX) ? (
                        <IconButton
                            size="small"
                            title={I18n.t('Delete')}
                            onClick={e => {
                                e.stopPropagation();
                                void this.remove(option.slice(CUSTOM_PREFIX.length));
                            }}
                        >
                            <DeleteIcon fontSize="small" />
                        </IconButton>
                    ) : null}
                </Box>
            </MenuItem>
        );
        // a ListSubheader has no tabindex, and SelectInput ignores clicks on such children, so these
        // headers cannot be picked as a value
        const menu: React.JSX.Element[] = [];
        if (orphan) {
            menu.push(entry(orphan));
        }
        if (uploads.length) {
            menu.push(<ListSubheader key="head-custom">{I18n.t('[Custom user uploads]')}</ListSubheader>);
            uploads.forEach(file => menu.push(entry(`${CUSTOM_PREFIX}${file}`)));
        }
        if (releases.length) {
            menu.push(<ListSubheader key="head-official">{I18n.t('[Official GitHub releases]')}</ListSubheader>);
            releases.forEach(tag => menu.push(entry(`${OFFICIAL_PREFIX}${tag}`)));
        }

        return (
            <Box sx={{ width: '100%' }}>
                {/* the status belongs next to the field it is about, so both share a row; aligned at
                    the bottom because the FormControl carries its label above the input */}
                {/* gap 2 is the grid's own column spacing, so the status starts exactly where the
                    neighbouring column would; wrapping keeps it from squeezing the field when the
                    window gets narrow */}
                <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 2, flexWrap: 'wrap' }}>
                    <FormControl
                        variant="standard"
                        error={!!error}
                        sx={{
                            // exactly as wide as the four-column field below: in a twelve-column
                            // grid with a 16px gutter, eight columns are twice four plus one gutter,
                            // so half of this cell minus half a gutter is a four-column width
                            width: { xs: '100%', md: 'calc(50% - 8px)' },
                            // without this the longest entry wins and the cell overflows
                            minWidth: 0,
                        }}
                    >
                        <InputLabel>{this.getText(this.props.schema.label)}</InputLabel>
                        <Select
                            // the open list follows its longest entry instead of the width of the field
                            autoWidth
                            MenuProps={{ slotProps: { paper: { sx: { maxWidth: '90vw' } } } }}
                            value={options.includes(value) ? value : ''}
                            onChange={e => void this.select(e.target.value)}
                            renderValue={selected => label(selected)}
                        >
                            {menu}
                        </Select>
                    </FormControl>
                    {this.state.busy ? (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 0.5 }}>
                            <CircularProgress
                                size={20}
                                {...(percent === null ? {} : { variant: 'determinate' as const, value: percent })}
                            />
                            {progress ? (
                                <Typography
                                    variant="body2"
                                    color="text.secondary"
                                    sx={{ whiteSpace: 'nowrap' }}
                                >
                                    {progress.phase === 'unpacking'
                                        ? I18n.t('Unpacking')
                                        : progress.total
                                          ? `${I18n.t('Downloading')} ${megabytes(progress.done || 0)} / ${megabytes(progress.total)} MB`
                                          : I18n.t('Downloading')}
                                </Typography>
                            ) : null}
                        </Box>
                    ) : this.state.ready && !this.state.error ? (
                        // a finished job says nothing any more, it only shows
                        <CheckIcon
                            color="success"
                            titleAccess={I18n.t('Ready')}
                            sx={{ mb: 0.5 }}
                        />
                    ) : null}
                </Box>
                {/* outside the FormControl on purpose: that one is an inline-flex column and would
                    take the width of its widest child, so a whole sentence of an error would stretch
                    the field far beyond the width its entries need. Rendered only when there is one,
                    an empty helper text still reserves its line. */}
                {error ? <FormHelperText error>{error}</FormHelperText> : null}

                {/* the same component the field above uses for its label, so both read as one kind
                    of heading - rebuilding size, weight and colour by hand would drift apart at the
                    next MUI version. "shrink" has to be said out loud here: outside a FormControl
                    the label cannot tell that it belongs to a filled field. */}
                <InputLabel
                    shrink
                    variant="standard"
                    sx={{ mt: 4 }}
                >
                    {I18n.t('Upload custom build')}
                </InputLabel>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5, flexWrap: 'wrap' }}>
                    <input
                        ref={this.inputRef}
                        type="file"
                        accept={ACCEPT}
                        style={{ display: 'none' }}
                        onChange={this.onPick}
                    />
                    <Button
                        variant="outlined"
                        startIcon={<UploadIcon />}
                        disabled={this.state.busy}
                        onClick={() => this.inputRef.current?.click()}
                    >
                        {I18n.t('Select file')}
                    </Button>
                    {this.state.pending ? (
                        <Typography
                            variant="body2"
                            sx={{ mr: 1 }}
                        >
                            {this.state.pending.name}
                        </Typography>
                    ) : null}
                    {this.state.pending ? (
                        <Button
                            variant="contained"
                            disabled={this.state.busy}
                            onClick={() => void this.upload()}
                        >
                            {I18n.t('upload')}
                        </Button>
                    ) : null}
                    {this.state.error ? (
                        <Typography
                            variant="body2"
                            color="error"
                        >
                            {this.state.error}
                        </Typography>
                    ) : null}
                    {this.state.warning ? (
                        <Typography
                            variant="body2"
                            color="warning.main"
                        >
                            {this.state.warning}
                        </Typography>
                    ) : null}
                    {this.state.notice ? (
                        <Typography
                            variant="body2"
                            color="text.secondary"
                        >
                            {this.state.notice}
                        </Typography>
                    ) : null}
                </Box>
                {/* not a tooltip: an explanation nobody finds without pointing at it explains little */}
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                >
                    {I18n.t('A CometVisu build archive (.tar.gz), for example one you built yourself')}
                </Typography>
            </Box>
        );
    }
}
