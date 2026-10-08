@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Установка бота
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Скачайте версию LTS с https://nodejs.org, установите и запустите этот файл снова.
  start "" "https://nodejs.org"
  pause
  exit /b 1
)
echo Устанавливаю пакеты, это может занять минуту...
call npm install --no-fund --no-audit
if errorlevel 1 (
  echo Не удалось установить пакеты. Проверьте интернет и запустите снова.
  pause
  exit /b 1
)
node setup.js
pause
