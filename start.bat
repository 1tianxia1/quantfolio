@echo off
chcp 65001 >nul
REM ============================================================
REM  QuantFolio 一键启动脚本（Windows）
REM  流程：检查 Node -> 安装依赖 -> 初始化 .env -> 导入种子数据 -> 并行启动前后端
REM ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   QuantFolio 启动中 ...
echo   后端 API : http://localhost:3001
echo   前端页面: http://localhost:5173
echo ============================================================

REM ---- 1. 检查 Node ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18+（推荐 20/22 LTS）
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo [1/4] Node 版本: !NODE_VER!

REM ---- 2. 安装根依赖（concurrently）----
if not exist "node_modules\concurrently" (
  echo [2/4] 安装根依赖 ...
  call npm install
)

REM ---- 3. 初始化 .env ----
if not exist ".env" (
  echo [3/4] 生成 .env（从 .env.example 复制）...
  copy ".env.example" ".env" >nul
)

REM ---- 4. 安装前后端依赖 + 导入种子数据 ----
echo [4/4] 安装前后端依赖 ...
call npm run install-all
if errorlevel 1 (
  echo [警告] 依赖安装未完全成功，尝试继续 ...
)

echo 导入种子数据 ...
call npm run seed
if errorlevel 1 (
  echo [警告] 种子数据导入失败，请检查 data/seed-market.json 与 server 依赖
)

echo.
echo 启动前后端（Ctrl+C 停止）...
call npm run dev
pause
