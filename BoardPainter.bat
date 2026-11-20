@echo off
rem BoardPainter launcher: installs dependencies on first run, then starts the app
chcp 65001 > nul
setlocal
cd /d "%~dp0"

where node > nul 2>&1
if errorlevel 1 (
  echo [BoardPainter] Node.js が見つかりません。
  echo https://nodejs.org/ から Node.js 20 以上をインストールしてから、もう一度実行してください。
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [BoardPainter] 初回セットアップ中です（数分かかります）...
  call npm install
  if errorlevel 1 (
    echo [BoardPainter] セットアップに失敗しました。ネット接続を確認して、もう一度実行してください。
    pause
    exit /b 1
  )
)

echo [BoardPainter] 起動しています...
call npm start -- %*
if errorlevel 1 (
  echo [BoardPainter] 起動に失敗しました。上のメッセージを確認してください。
  pause
  exit /b 1
)
endlocal
