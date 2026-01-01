param(
  [ValidateSet('start','stop','status')]
  [string]$Action = 'start',
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

function Get-ListenerProcessId([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' } |
    Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return $null
}

switch ($Action) {
  'status' {
    $listenerProcessId = Get-ListenerProcessId $Port
    if ($listenerProcessId) { "LISTENING on $Port (PID $listenerProcessId)" } else { "NOT LISTENING on $Port" }
  }
  'stop' {
    $listenerProcessId = Get-ListenerProcessId $Port
    if ($listenerProcessId) {
      Stop-Process -Id $listenerProcessId -Force -ErrorAction SilentlyContinue
      "Stopped PID $listenerProcessId on port $Port"
    } else {
      "Nothing to stop on port $Port"
    }
  }
  default {
    $listenerProcessId = Get-ListenerProcessId $Port
    if ($listenerProcessId) {
      "Already listening on $Port (PID $listenerProcessId)"
      return
    }

    $pythonExe = Join-Path (Get-Location) '.venv\Scripts\python.exe'
    if (-not (Test-Path $pythonExe)) {
      $pythonExe = 'python'
    }

    $proc = Start-Process -FilePath $pythonExe -ArgumentList @(
      '-m','http.server',"$Port",'--bind','127.0.0.1'
    ) -WorkingDirectory (Get-Location) -PassThru

    "Started http.server on http://127.0.0.1:$Port/ (PID $($proc.Id))"
  }
}
