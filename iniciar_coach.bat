@echo off
title RaceMind AI - Telemetry Bridge
echo ==================================================
echo   RaceMind AI - Ponte de Telemetria (Aiden Coach)
echo ==================================================
echo.

:: Verifica se o Python está instalado
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Python nao encontrado! 
    echo Por favor, instale o Python em https://www.python.org/
    echo Certifique-se de marcar a opcao "Add Python to PATH".
    pause
    exit
)

echo [1/2] Verificando dependencias...
pip install socketio-client pyRfactor2SharedMemory >nul 2>&1

echo [2/2] Iniciando ponte de telemetria...
echo.
echo >> Mantenha esta janela aberta enquanto estiver no simulador.
echo >> Se o jogo fechar, voce pode reiniciar este arquivo.
echo.

python telemetry_bridge.py

if %errorlevel% neq 0 (
    echo.
    echo [AVISO] A ponte foi encerrada ou ocorreu um erro.
    pause
)
