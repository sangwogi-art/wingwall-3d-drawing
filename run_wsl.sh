#!/usr/bin/env bash
# ==============================================================================
# DWG 도면 기반 3D 모델링 및 웹 뷰어 실행 스크립트 (WSL2 / Ubuntu 환경)
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PATH="$HOME/.venv-3d-drawing"

echo "======================================================================"
echo " [3D Drawing Converter & Viewer] WSL2(Ubuntu) 실행 환경 초기화"
echo "======================================================================"

# 1. 가상환경 확인 및 필요 시 자동 생성
if [ ! -f "$VENV_PATH/bin/python" ]; then
    echo ">> 가상환경이 존재하지 않아 생성 중: $VENV_PATH"
    python3 -m venv "$VENV_PATH"
    "$VENV_PATH/bin/pip" install --upgrade pip
    "$VENV_PATH/bin/pip" install -r requirements.txt
fi

echo ">> Python 가상환경 활성화: $VENV_PATH"
source "$VENV_PATH/bin/activate"

# 2. 필수 의존성 검증
python -c "import flask, flask_cors, ezdxf, ezdwg, numpy; print('>> 모든 필수 패키지 검증 완료 (flask, ezdxf, ezdwg, numpy)')"

# 3. Flask 웹 서버 기동
PORT=${PORT:-5000}
HOST=${HOST:-0.0.0.0}

echo "----------------------------------------------------------------------"
echo ">> 3D 도면 뷰어 웹 서버를 실행합니다..."
echo ">> 접속 주소: http://localhost:$PORT / http://127.0.0.1:$PORT"
echo ">> 종료하려면 Ctrl+C 를 누르세요."
echo "----------------------------------------------------------------------"

exec python app.py
