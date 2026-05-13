# Lumina - Start Backend + Frontend
$root = $PSScriptRoot

Write-Host "Starting Lumina..." -ForegroundColor Cyan

# Backend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
    "cd '$root'; .\venv\Scripts\Activate.ps1; cd backend; Write-Host 'Backend running at http://127.0.0.1:8000' -ForegroundColor Green; python -m uvicorn server:app --reload"

# Small delay so backend gets a head start
Start-Sleep -Seconds 2

# Frontend
Start-Process powershell -ArgumentList "-NoExit", "-Command", `
    "cd '$root\frontend'; Write-Host 'Frontend running at http://localhost:5173' -ForegroundColor Green; npm run dev"

Write-Host "Both servers launched in separate windows." -ForegroundColor Cyan
