@echo off
cd /d "%~dp0rs"
cargo build --release || exit /b 1
cd /d "%~dp0"
if not exist dist mkdir dist
copy /y rs\target\release\ZFeedback.exe dist\ZFeedback.exe
copy /y demo\video.mp4 dist\video.mp4
copy /y demo\project.json dist\project.json
echo.
echo Done. Run dist\ZFeedback.exe
