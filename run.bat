@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo [1/2] 가상환경을 만들고 필요한 패키지를 설치합니다...
  python -m venv .venv || goto :err
  .venv\Scripts\python -m pip install -q -r requirements.txt || goto :err
)
echo 클립 상품영상 스튜디오를 시작합니다: http://127.0.0.1:8765
start "" http://127.0.0.1:8765
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
goto :eof
:err
echo 설치에 실패했습니다. Python 3.11 이상이 설치되어 있는지 확인하세요.
pause
