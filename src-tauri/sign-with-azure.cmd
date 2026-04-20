@echo off
setlocal

set "FILE=%~1"
set "EXT=%~x1"

set "SIGNTOOL_PATH=C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe"

echo === sign-with-azure.cmd ===
echo FILE=%FILE%
echo EXT=%EXT%

if /I "%EXT%"==".exe" goto sign
if /I "%EXT%"==".dll" goto sign
if /I "%EXT%"==".msi" goto sign
if /I "%EXT%"==".cab" goto sign
if /I "%EXT%"==".ocx" goto sign
if /I "%EXT%"==".sys" goto sign

echo Skipping unsupported file type: %FILE%
exit /b 0

:sign
trusted-signing-cli -e https://eus.codesigning.azure.net/ -a HyperformanceSolutions -c AlteredBrainChemistry1 -d Kaleidomo "%FILE%"
set "ERR=%ERRORLEVEL%"
echo trusted-signing-cli exit code: %ERR%
exit /b %ERR%