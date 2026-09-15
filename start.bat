@echo off
setlocal EnableExtensions

rem Adi Pet source launcher for Windows.
rem Node.js and npm must be installed first. Dependencies are installed locally.
rem start.bat          Install/build when missing, then launch.
rem start.bat build    Rebuild after source changes, then launch.
rem start.bat console  Launch with a console so errors remain visible.

cd /d "%~dp0"
if errorlevel 1 goto folderfailed
if not exist "package.json" goto missingfiles
if not exist "package-lock.json" goto missingfiles
if not exist "src\main\bootstrap.ts" goto missingfiles

where node.exe >nul 2>&1
if errorlevel 1 goto missingnode
where npm.cmd >nul 2>&1
if errorlevel 1 goto missingnode

set "NEED_BUILD=0"
if /i "%~1"=="build" set "NEED_BUILD=1"
if not exist "dist\main\bootstrap.js" set "NEED_BUILD=1"
if not exist "dist\main\index.js" set "NEED_BUILD=1"
if not exist "dist\renderer\index.html" set "NEED_BUILD=1"
if not exist "node_modules\electron\dist\electron.exe" goto install
if not exist "node_modules\.bin\tsc.cmd" goto install
if not exist "node_modules\.bin\vite.cmd" goto install
if not exist "node_modules\node-sqlite3-wasm\package.json" goto install
if not exist "node_modules\ws\package.json" goto install
goto maybebuild

:install
echo Installing the project dependencies from package-lock.json...
echo Internet access is required for this step.
call npm.cmd ci --include=dev
if errorlevel 1 goto installfailed
if not exist "node_modules\electron\dist\electron.exe" goto electronmissing
set "NEED_BUILD=1"

:maybebuild
if "%NEED_BUILD%"=="0" goto run
echo Building Adi Pet...
call npm.cmd run build
if errorlevel 1 goto buildfailed

:run
if /i "%~1"=="console" goto withconsole
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:withconsole
echo Starting Adi Pet...
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
set "APP_EXIT=%ERRORLEVEL%"
echo.
echo Adi Pet exited with code %APP_EXIT%.
pause
exit /b %APP_EXIT%

:missingnode
echo.
echo Install Node.js LTS, including npm, from the official Node.js website.
echo Leave the Add to PATH option enabled during installation.
echo Then close this window and double-click start.bat again.
echo Node.js, Chrome and Python are not installed by this launcher.
pause
exit /b 1

:missingfiles
echo.
echo Extract the ENTIRE project ZIP before running start.bat.
echo Keep start.bat beside package.json, package-lock.json and the src folder.
pause
exit /b 1

:installfailed
echo.
echo Dependency installation failed. Nothing was started.
echo Check the error above and your internet connection, then try again.
pause
exit /b 1

:electronmissing
echo.
echo Electron was not downloaded, so the app cannot start.
echo Check the npm output and whether install scripts or downloads were blocked.
pause
exit /b 1

:buildfailed
echo.
echo The build failed. Nothing was started. Review the error above.
pause
exit /b 1

:folderfailed
echo.
echo Could not open the project folder. Extract it to a local writable folder.
pause
exit /b 1
