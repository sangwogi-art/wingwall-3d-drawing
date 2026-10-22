@echo off
chcp 65001 > nul
setlocal
title 암거 및 날개벽 3D 모델러

echo ===============================================================================
echo   [암거 및 날개벽 3D 외형·배근 모델러] 원클릭 실행기
echo   - 프로젝트: 대산-당진 수로암거 (STA.13+611.21)
echo   - 2단계 일반도 외형 / 3단계 배근도 철근 3D 모델링
echo ===============================================================================
echo.

set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%Code\3d-drawing\app.py" (
    set "WORK_DIR=%SCRIPT_DIR%Code\3d-drawing"
) else (
    set "WORK_DIR=%SCRIPT_DIR%"
)

REM 1. 서버 실행 여부 점검 (포트 5000)
netstat -ano | findstr /R ":5000.*LISTENING" > nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [안내] 백엔드 웹 서버가 이미 정상 동작 중입니다.
    echo [접속] 기본 웹 브라우저를 실행합니다: http://localhost:5000/
    start "" http://localhost:5000/
    goto done
)

REM 2. 서버 미실행 시 백엔드 구동
echo [*] 백엔드 웹 서버가 중지되어 있습니다. 서버 구동을 시작합니다...

REM WSL2 환경 확인 및 구동 시도
where wsl > nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [*] WSL2(Ubuntu) 가상환경을 감지하였습니다. WSL2 백그라운드 서버를 실행합니다...
    start /min "3D Drawing Server (WSL2)" wsl -d Ubuntu bash -c "cd '/mnt/e/11. 2026 PROJECT/30 도면을 3D로 구현/01 대산당진_수로암거(STA13+611)_옹벽형날개벽/Code/3d-drawing' && ./run_wsl.sh"
    goto wait_loop
)

REM WSL2가 없을 경우 Windows Python 환경으로 구동
echo [*] Windows Python 환경으로 웹 서버를 실행합니다...
cd /d "%WORK_DIR%"
start /min "3D Drawing Server" python app.py

:wait_loop
echo [*] 서버 초기화 및 기동 대기 중...
set retry=0

:check_port
ping -n 2 127.0.0.1 > nul
netstat -ano | findstr /R ":5000.*LISTENING" > nul 2>&1
if %ERRORLEVEL% equ 0 (
    echo [성공] 서버 기동 완료! (포트 5000 활성화됨)
    echo [접속] 기본 웹 브라우저를 실행합니다: http://localhost:5000/
    start "" http://localhost:5000/
    goto done
)

set /a retry=%retry%+1
if %retry% lss 10 (
    goto check_port
)

echo [주의] 서버 기동 대기 시간이 초과되었습니다. 브라우저를 열어 확인합니다...
start "" http://localhost:5000/

:done
echo.
echo ===============================================================================
echo   실행이 완료되었습니다. 웹 브라우저에서 3D 모델을 확인하실 수 있습니다.
echo   - 웹 접속 주소: http://localhost:5000/
echo ===============================================================================
echo.
ping -n 3 127.0.0.1 > nul
