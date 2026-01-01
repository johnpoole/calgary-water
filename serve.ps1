param(
  [ValidateSet('start','stop','status')]
  [string]$Action = 'start',
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

function Get-ListenerPid([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' } |
    Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return $null
}

switch ($Action) {
  'status' {
    $listenerPid = Get-ListenerPid $Port
    if ($listenerPid) { "LISTENING on $Port (PID $listenerPid)" } else { "NOT LISTENING on $Port" }
  }
  'stop' {
    $listenerPid = Get-ListenerPid $Port
    if ($listenerPid) {
      Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
      "Stopped PID $listenerPid on port $Port"
    } else {
      "Nothing to stop on port $Port"
    }
  }
  default {
    $listenerPid = Get-ListenerPid $Port
    if ($listenerPid) {
      "Already listening on $Port (PID $listenerPid)"
      return
    }

    $proc = Start-Process -FilePath python -ArgumentList @(
      '-m','http.server',"$Port",'--bind','127.0.0.1'
    ) -WorkingDirectory (Get-Location) -PassThru

    "Started http.server on http://127.0.0.1:$Port/ (PID $($proc.Id))"
  }
}
