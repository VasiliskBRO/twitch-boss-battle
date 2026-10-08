@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Бот: Босс для чата Твича
echo Бот запускается. Чтобы остановить — нажмите Ctrl+C (бой сохранится).
node bot.js
pause
