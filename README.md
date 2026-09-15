# Adi Pet

A Windows desktop pet and AI assistant that can interact with your computer.

## Start from this source download

1. Install Node.js LTS with its bundled npm package manager. Leave Add to PATH enabled.
2. Download and extract the entire project into a writable local folder.
3. Double-click `start.bat`.

On the first run, the launcher installs the locked project dependencies with
`npm ci --include=dev`, builds the application, and launches it. Internet access
is required for the dependency downloads. Later launches reuse the existing
installation and build. No test suite is included or run by the launcher.

This source download is not a standalone Windows installer. The launcher does
not install Node.js or optional external programs. Browser automation needs an
installed Google Chrome; Python actions need Python. Configure your own account
or provider in the app. No account, subscription, API key or local model is included.

```bat
start.bat
start.bat build
start.bat console
```

Use `start.bat build` after changing the source. Use `start.bat console` to see
runtime errors in the console. Close the app before rebuilding it.

From a terminal, a fresh installation can also be started with:

```bat
npm ci --include=dev
npm run dev
```

## What belongs in the repository

Keep `src/`, `package.json`, `package-lock.json`, `start.bat`, both TypeScript
configuration files, `vite.config.ts`, this README, and `.gitignore`.

`node_modules/` and `dist/` are generated locally. They are intentionally absent
from this download and ignored by Git. The top-level developer `tools/` folder,
preview fixtures, tests, benchmarks, development journal and old Git history
are also absent. `src/main/tools/` contains the real app features and must stay.

The example disk-report custom tool is not automatically created in this copy.
Normal built-in tools, their generated reference manifests, and app defaults remain.

## Personal data and a fresh profile

When run through `start.bat`, app data is stored separately under
`%APPDATA%\adi-pet`, including chats, settings, credentials, custom tools,
skills, browser-profile data and runtime logs. These are not included in the
source download. Screenshots may also be written to `Pictures\AdiPet` or a
user-selected location.

Someone running the app for the first time gets a new local profile. Running a
new copy on the same Windows account can reuse the existing profile.

To try a fresh profile on your own PC, fully close Adi Pet and rename
`%APPDATA%\adi-pet` to an unused backup name, such as `adi-pet-backup-1`, before
launching it again. The old data is retained in the backup, but will not be
loaded by the fresh profile. This also means signing in again. Do not publish
either profile folder. Do not reset a profile automatically on every launch.

## Safety

This application can execute commands and modify files when its tools are
used. Review actions and permission requests before allowing them. This cleaned
source export is not a security certification or a Windows runtime test.

## Setup references

- Electron prerequisites: https://www.electronjs.org/docs/latest/tutorial/tutorial-prerequisites
- npm clean installation: https://docs.npmjs.com/cli/v11/commands/npm-ci/
- Electron application-data paths: https://www.electronjs.org/docs/latest/api/app#appgetpathname
