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
import { Delete as DeleteIcon, UploadFile as UploadIcon, Warning as WarningIcon } from '@mui/icons-material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

/** Value prefix of an uploaded archive; the rest is the file name as stored. */
const CUSTOM_PREFIX = '[Custom] ';
/** Value prefix of a GitHub release; the rest is the tag. */
const OFFICIAL_PREFIX = '[Official] ';
/** Archives the file dialog offers. */
const ACCEPT = '.tgz,.tar.gz,.gz';
const RELEASES_URL = 'https://api.github.com/repos/CometVisu/CometVisu/releases?per_page=100';
/** Only releases that ship this asset can be served by the adapter. */
const BUILD_ASSET = /^CometVisu-.*\.tar\.gz$/i;

interface Release {
    tag_name: string;
    created_at: string;
    assets: { name: string }[];
}

interface State extends ConfigGenericState {
    /** uploaded archives, newest upload first */
    uploads: string[];
    /** whether the uploads could actually be read - only then a value can be judged as missing */
    uploadsLoaded: boolean;
    /** release tags, newest release first */
    releases: string[];
    /** whether the releases could actually be fetched */
    releasesLoaded: boolean;
    /** archive picked in the file dialog but not uploaded yet */
    pending: File | null;
    busy: boolean;
    error: string;
}

/**
 * Single control to pick the CometVisu version. It lists the archives uploaded to this instance and
 * the CometVisu releases fetched straight from GitHub, uploads a build archive from the local file
 * dialog and deletes uploads again. Picking a version is mandatory, so an empty value blocks saving.
 */
export default class ConfigCustomCometVisuVersion extends ConfigGeneric<ConfigGenericProps, State> {
    private readonly inputRef = React.createRef<HTMLInputElement>();

    async componentDidMount(): Promise<void> {
        await super.componentDidMount();
        this.setState(
            { uploads: [], uploadsLoaded: false, releases: [], releasesLoaded: false, pending: null, busy: false, error: '' },
            () => {
            void this.loadUploads();
            void this.loadReleases();
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
            return 'Please select a CometVisu version';
        }
        return this.isMissing(value) ? 'The selected CometVisu version is no longer available' : undefined;
    }

    /** Picking a valid version is mandatory: as long as it is not, an error blocks the save button. */
    private updateError(value?: string): void {
        const current = value ?? ((ConfigGeneric.getValue(this.props.data, this.props.attr) as string) || '');
        this.onError(this.props.attr, this.valueError(current));
    }

    private async setValue(value: string): Promise<void> {
        await this.onChange(this.props.attr, value);
        this.updateError(value);
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

    private async loadReleases(): Promise<void> {
        try {
            const response = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
            if (!response.ok) {
                throw new Error(`GitHub returned ${response.status}`);
            }
            const releases: Release[] = await response.json();
            this.setState(
                {
                    releases: releases
                        .filter(release => release.assets?.some(asset => BUILD_ASSET.test(asset.name)))
                        // newest release first
                        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
                        .map(release => release.tag_name),
                    releasesLoaded: true,
                },
                () => this.updateError()
            );
        } catch (e: unknown) {
            // the uploads stay usable even without GitHub
            this.setState(
                {
                    releases: [],
                    releasesLoaded: false,
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
        this.setState({ pending: file, error: '' });
    };

    private async upload(): Promise<void> {
        const file = this.state.pending;
        if (!file) {
            return;
        }
        this.setState({ busy: true, error: '' });
        try {
            const content = await file.arrayBuffer();
            await this.socket.writeFile64(this.objectId, file.name, content);
            await this.loadUploads();
            this.setState({ pending: null, busy: false });
            await this.setValue(`${CUSTOM_PREFIX}${file.name}`);
        } catch (e: unknown) {
            this.setState({ busy: false, error: e instanceof Error ? e.message : String(e) });
        }
    }

    private async remove(fileName: string): Promise<void> {
        this.setState({ busy: true, error: '' });
        try {
            await this.socket.deleteFile(this.objectId, fileName);
            // let the adapter drop the unpacked build right away; if it is not running, its next
            // start removes the leftovers, so a failure here must not disturb the user
            try {
                const context = this.props.oContext || (this.props as any);
                await this.socket.sendTo(
                    `${context.adapterName}.${context.instance}`,
                    'deleteCustomBuild',
                    { file: fileName }
                );
            } catch {
                // adapter not reachable - the unpacked build is cleaned up on its next start
            }
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
            return this.isMissing(option) ? `${name} (missing)` : name;
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
                            titleAccess="This version is no longer available"
                        />
                    ) : option.startsWith(CUSTOM_PREFIX) ? (
                        <IconButton
                            size="small"
                            title="Delete"
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
            menu.push(<ListSubheader key="head-custom">[Custom user uploads]</ListSubheader>);
            uploads.forEach(file => menu.push(entry(`${CUSTOM_PREFIX}${file}`)));
        }
        if (releases.length) {
            menu.push(<ListSubheader key="head-official">[Official GitHub releases]</ListSubheader>);
            releases.forEach(tag => menu.push(entry(`${OFFICIAL_PREFIX}${tag}`)));
        }

        return (
            <Box sx={{ width: '100%' }}>
                {/* no fullWidth: the field takes the width of the entry it shows, down to a
                    width that still fits the label and up to the width of its grid cell */}
                <FormControl
                    variant="standard"
                    error={!!error}
                    sx={{ minWidth: 260, maxWidth: '100%' }}
                >
                    <InputLabel>{this.getText(this.props.schema.label)}</InputLabel>
                    <Select
                        // the open list follows its longest entry instead of the width of the field
                        autoWidth
                        MenuProps={{ slotProps: { paper: { sx: { maxWidth: '90vw' } } } }}
                        value={options.includes(value) ? value : ''}
                        onChange={e => void this.setValue(e.target.value)}
                        renderValue={selected => label(selected)}
                    >
                        {menu}
                    </Select>
                </FormControl>
                {/* outside the FormControl on purpose: that one is an inline-flex column and would
                    take the width of its widest child, so the long help text would stretch the
                    field far beyond the width its entries need */}
                <FormHelperText error={!!error}>
                    {error || this.getText(this.props.schema.help)}
                </FormHelperText>

                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
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
                        Select file
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
                            Upload
                        </Button>
                    ) : null}
                    {this.state.busy ? <CircularProgress size={20} /> : null}
                    {this.state.error ? (
                        <Typography
                            variant="body2"
                            color="error"
                        >
                            {this.state.error}
                        </Typography>
                    ) : null}
                </Box>
            </Box>
        );
    }
}
