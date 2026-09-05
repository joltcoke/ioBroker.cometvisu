![Logo](admin/cometvisu.png)

# ioBroker.cometvisu

[![NPM version](https://img.shields.io/npm/v/iobroker.cometvisu.svg)](https://www.npmjs.com/package/iobroker.cometvisu)
[![Downloads](https://img.shields.io/npm/dm/iobroker.cometvisu.svg)](https://www.npmjs.com/package/iobroker.cometvisu)
![Number of Installations](https://iobroker.live/badges/cometvisu-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/cometvisu-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.cometvisu.png?downloads=true)](https://nodei.co/npm/iobroker.cometvisu/)

**Tests:** ![Test and Release](https://github.com/joltcoke/ioBroker.cometvisu/workflows/Test%20and%20Release/badge.svg)

## cometvisu adapter for ioBroker

Serves the CometVisu visualization through the ioBroker web adapter

## Requirements

The visualisation is delivered by [iobroker.web](https://github.com/ioBroker/ioBroker.web) (7.0.3
or newer), which also provides the login, the session and the socket connection. This adapter has
no web server of its own.

For charts and history data an ioBroker history adapter is needed, for example `iobroker.sql`
(4.1.1 or newer).

## Setup

1. Install the adapter and create an instance.
2. Pick a **CometVisu version**. The list offers the official releases from GitHub as well as any
   archive you upload yourself; the selected one is unpacked when you save.
3. Pick the **web instance** that should serve it.

The visualisation is then reachable under `http://<host>:<web port>/cometvisu/`.

## How it works

The adapter keeps the selected build on disk and registers itself as an extension of the web
adapter (`common.webExtension`), which mounts it under `/cometvisu`. Every release is unpacked into
a directory of its own, so switching back to one that was used before costs no unpacking, and
whatever is no longer referenced is removed at startup.

CometVisu learns where to connect through the `X-CometVisu-Backend-*` response headers, so no
backend has to be configured in the visualisation itself. It loads the matching socket client
library from the very server that serves it, which is why both socket modes of the web adapter
work.

## Uploading your own build

Any `CometVisu-*.tar.gz` can be uploaded in the settings. Uploads are kept apart by file name, so
several of them can exist side by side and be switched between. Uploading the same name again
replaces that entry.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (joltcoke) keywords now contain "ioBroker", as the adapter checker asks for
- (joltcoke) releases are published by the workflow through trusted publishing

## License

MIT License

Copyright (c) 2026 Florian Schirmer <jolt@tuxbox.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
