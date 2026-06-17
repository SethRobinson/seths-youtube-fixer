@echo off
REM ============================================================================
REM  build_release.bat  -  Build Seth's YouTube Fixer and pack it into a zip
REM                       ready to install (Load unpacked) or upload to the
REM                       Chrome Web Store.
REM
REM  Output:  releases\seths-youtube-fixer-v<version>.zip   (zips the dist/ folder)
REM
REM  Just double-click this file, or run it from a terminal.
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo === Seth's YouTube Fixer - release build ===
echo.

REM --- 1. Make sure dependencies are installed --------------------------------
if not exist "node_modules" (
  echo Installing dependencies ^(first run^)...
  call npm install || goto :fail
)

REM --- 2. Production build: no sourcemaps -------------------------------------
echo Building extension...
set "SYF_RELEASE=1"
call npm run build || goto :fail
set "SYF_RELEASE="

if not exist "dist\manifest.json" (
  echo ERROR: dist\manifest.json not found - build did not produce output.
  goto :fail
)

REM --- 3. Read the version out of the built manifest --------------------------
for /f "usebackq delims=" %%v in (`node -p "require('./dist/manifest.json').version"`) do set "VERSION=%%v"
if "%VERSION%"=="" set "VERSION=0.0.0"
echo Version: %VERSION%

REM --- 4. Pack dist\ into releases\seths-youtube-fixer-v<version>.zip ---------
if not exist "releases" mkdir "releases"
set "ZIP=releases\seths-youtube-fixer-v%VERSION%.zip"
if exist "%ZIP%" del /q "%ZIP%"

echo Packing %ZIP% ...
REM Use .NET ZipFile (forward-slash paths, manifest at the zip root) rather than
REM Compress-Archive, whose backslash separators can trip up the Web Store uploader.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; $z = Join-Path (Get-Location).Path '%ZIP%'; if (Test-Path $z) { Remove-Item $z -Force }; [System.IO.Compression.ZipFile]::CreateFromDirectory((Resolve-Path 'dist').Path, $z)" || goto :fail

echo.
echo === DONE ===
echo Created: %ZIP%
echo.
echo To install it yourself:
echo   1. Unzip it somewhere.
echo   2. Go to  chrome://extensions  (or  brave://extensions ).
echo   3. Turn on "Developer mode" (top-right).
echo   4. Click "Load unpacked" and pick the unzipped folder.
echo.
echo To submit to the Chrome Web Store: upload the .zip itself on the dashboard.
echo.
pause
exit /b 0

:fail
echo.
echo *** BUILD FAILED *** (see the messages above)
echo.
pause
exit /b 1
