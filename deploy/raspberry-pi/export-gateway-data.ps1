<#
  valimart harness 正式网关 —— 数据导出（用于迁移到树莓派 / 建备份）

  用法：右键 →「使用 PowerShell 运行」，或双击。
        脚本会自己请求管理员权限（UAC 点「是」）。没有管理员权限读不到数据目录。

  做四件事：
    1. 短暂停掉 TheDivaGateway 服务（约 10-20 秒），保证 sqlite 拿到一致快照
    2. 把 data（gateway.sqlite + 公司盘 drive/）打包成 zip 到公共目录
    3. 备份 server\config.json 与 server\config.local.json
    4. 重新启动服务，并打印结果与校验

  不动数据、不卸载、不删任何东西。只读 + 打包。
#>
$ErrorActionPreference = 'Stop'

# ---------- 自动提权 ----------
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '当前不是管理员，正在请求提权（UAC 请点「是」）…' -ForegroundColor Yellow
  $args2 = @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',"`"$PSCommandPath`"")
  try { Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -Verb RunAs }
  catch { Write-Host "提权被取消或被拒：$($_.Exception.Message)" -ForegroundColor Red; Start-Sleep 6 }
  exit
}

$SERVICE  = 'TheDivaGateway'
$INST     = 'D:\Program Files\valimart harness Gateway'
$DATA     = 'C:\ProgramData\valimart harness Gateway'
$stamp    = Get-Date -Format 'yyyyMMdd-HHmmss'
$OUT      = 'C:\Users\Public\valimart-gateway-export'
$DEST     = Join-Path $OUT "export-$stamp"
$ZIP      = Join-Path $OUT "valimart-gateway-data-$stamp.zip"

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Human($b) { if ($b -ge 1GB) { '{0:N2} GB' -f ($b/1GB) } elseif ($b -ge 1MB) { '{0:N1} MB' -f ($b/1MB) } else { '{0:N0} KB' -f ($b/1KB) } }

Say ''
Say '========================================================' Cyan
Say ' valimart harness 正式网关 · 数据导出' Cyan
Say '========================================================' Cyan
Say " 服务名   $SERVICE"
Say " 数据目录 $DATA"
Say " 输出去   $DEST"
Say ''

New-Item -ItemType Directory -Force -Path $DEST | Out-Null

# ---------- 1. 停服务 ----------
$svc = Get-Service -Name $SERVICE -ErrorAction SilentlyContinue
if (-not $svc) { Say "!! 找不到服务 $SERVICE" Red; Start-Sleep 10; exit 1 }
$wasRunning = ($svc.Status -eq 'Running')
if ($wasRunning) {
  Say '[1/5] 停止服务（拿一致快照）…'
  Stop-Service -Name $SERVICE -Force
  (Get-Service $SERVICE).WaitForStatus('Stopped','00:00:30')
  Say '      已停止'
} else {
  Say "[1/5] 服务当前是 $($svc.Status)，跳过停止"
}

try {
  # ---------- 2. 拷数据 ----------
  Say '[2/5] 拷贝数据（gateway.sqlite + 公司盘 drive/）…'
  $dataDst = Join-Path $DEST 'data'
  # robocopy 保留结构、可重试、能处理长路径；退出码 <8 都是成功
  $rc = (robocopy (Join-Path $DATA 'data') $dataDst /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP) 2>&1
  $code = $LASTEXITCODE
  if ($code -ge 8) { throw "robocopy 失败，退出码 $code`n$($rc -join "`n")" }
  $files = Get-ChildItem -Recurse -File $dataDst
  $bytes = ($files | Measure-Object Length -Sum).Sum
  Say ("      拷出 {0} 个文件，{1}" -f $files.Count, (Human $bytes)) Green
  Say ("      sqlite: {0}" -f ((Get-ChildItem $dataDst -Filter 'gateway.sqlite*' | ForEach-Object { "$($_.Name) $((Human $_.Length))" }) -join ' | '))

  # ---------- 3. 备份配置 ----------
  Say '[3/5] 备份配置…'
  $cfgDst = Join-Path $DEST 'config'
  New-Item -ItemType Directory -Force -Path $cfgDst | Out-Null
  foreach ($f in @('config.json','config.local.json','package.json')) {
    $src = Join-Path $INST "server\$f"
    if (Test-Path $src) { Copy-Item $src (Join-Path $cfgDst $f) -Force; Say "      server\$f" }
  }
  # 服务定义（含 DESK_GATEWAY_DATA 等环境变量，方便对照）
  $xml = Join-Path $INST 'service\TheDivaGateway.xml'
  if (Test-Path $xml) { Copy-Item $xml (Join-Path $cfgDst 'TheDivaGateway.xml') -Force; Say '      service\TheDivaGateway.xml' }

  # ---------- 4. 清单与校验 ----------
  Say '[4/5] 生成清单（含 sha256，便于核对迁移完整性）…'
  $manifest = foreach ($f in (Get-ChildItem -Recurse -File $DEST)) {
    [pscustomobject]@{
      path   = $f.FullName.Substring($DEST.Length + 1)
      bytes  = $f.Length
      sha256 = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    }
  }
  $manifest | Sort-Object path | Export-Csv (Join-Path $DEST 'manifest.csv') -NoTypeInformation -Encoding UTF8
  Say ("      清单 {0} 条" -f $manifest.Count)

  # 校验 sqlite 头（正式 SQLite 文件前 16 字节是 "SQLite format 3`0"）
  $sq = Join-Path $dataDst 'gateway.sqlite'
  if (Test-Path $sq) {
    $fs = [IO.File]::OpenRead($sq)
    $buf = New-Object byte[] 16
    [void]$fs.Read($buf, 0, 16)
    $fs.Close()
    $head = [Text.Encoding]::ASCII.GetString($buf)
    if ($head -like 'SQLite format 3*') { Say '      sqlite 文件头正确 OK' Green }
    else { Say "      !! sqlite 文件头异常: $head" Red }
  } else { Say '      !! 没找到 gateway.sqlite' Red }

  # 统计公司盘
  $drive = Join-Path $dataDst 'drive'
  if (Test-Path $drive) {
    $shared = Join-Path $drive '_shared'
    $office = Join-Path $drive '_office'
    $inbox  = Join-Path $drive 'projects\inbox'
    Say ("      公司盘: _shared {0} 文件 | _office {1} 个账号 | inbox {2} 个任务" -f `
      @(Get-ChildItem -Recurse -File $shared -ErrorAction SilentlyContinue).Count, `
      @(Get-ChildItem $office -Directory -ErrorAction SilentlyContinue).Count, `
      @(Get-ChildItem $inbox -Directory -ErrorAction SilentlyContinue).Count)
  }

  # ---------- 5. 打包 ----------
  Say '[5/5] 打包 zip…'
  if (Test-Path $ZIP) { Remove-Item $ZIP -Force }
  Compress-Archive -Path (Join-Path $DEST '*') -DestinationPath $ZIP -CompressionLevel Optimal
  Say ("      {0}  ({1})" -f $ZIP, (Human (Get-Item $ZIP).Length)) Green
}
finally {
  # ---------- 恢复服务 ----------
  if ($wasRunning) {
    Say ''
    Say '重新启动服务…'
    try {
      Start-Service -Name $SERVICE
      (Get-Service $SERVICE).WaitForStatus('Running','00:00:60')
      Say '服务已恢复 RUNNING' Green
    } catch {
      Say "!! 服务启动失败，请手动执行：`n   Start-Service $SERVICE`n   或  & '$INST\service\TheDivaGateway.exe' start" Red
    }
  }
}

Say ''
Say '========================================================' Cyan
Say ' 完成。请把下面这个路径告诉我：' Cyan
Say "   $OUT" White
Say ' （里面 export-<时间戳>\ 是明细，valimart-gateway-data-<时间戳>.zip 是整包）' Gray
Say '========================================================' Cyan
Say ''
Say '按回车关闭…'
[void](Read-Host)
