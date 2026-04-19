@echo off
title RaceMind AI - Sistema Completo
echo ==========================================================
echo   RaceMind AI - Inicializador Tudo-em-Um (Coach Aiden)
echo ==========================================================
echo.

:: 1. Verifica Node.js para o Painel Web
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado!
    echo Instale em: https://nodejs.org/
    pause
    exit
)

:: 2. Verifica Python para a Telemetria
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Python nao encontrado!
    echo Instale em: https://www.python.org/
    pause
    exit
)

echo [1/4] Verificando dependencias do Painel Web (NPM)...
call npm install --no-audit >nul 2>&1

echo [2/4] Verificando dependencias da Telemetria (PIP)...
pip install socketio-client pyRfactor2SharedMemory >nul 2>&1

echo [3/4] Iniciando Painel Web em uma nova janela...
:: Abre o servidor Vite em uma nova janela e mantem aberta se der erro
start "RaceMind Web Server" cmd /c "npm run dev"

echo [4/4] Iniciando Ponte de Telemetria nesta janela...
echo.
echo >> TUDO PRONTO!
echo >> 1. O Painel Web ja esta subindo em outra janela.
echo >> 2. Esta janela agora vai cuidar da conexao com o simulador.
echo >> 3. Acesse o link (geralmente http://localhost:3000) no seu Chrome.
echo.
echo >> Mantenha as duas janelas abertas para o Coach funcionar!
echo.

python telemetry_bridge.py

if %errorlevel% neq 0 (
    echo.
    echo [AVISO] A ponte de telemetria foi encerrada.
    pause
)
