/**
 * Linux x64 网关发行包：暂存 build/gateway-linux/ → dist/valimart-harness-Gateway-linux-x64-<ver>.tar.gz
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertGatewayStageClean, stageGatewayApp } from './gateway-stage.mjs'

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export async function ensureNodeLinuxX64(cacheDir, pin, { fetchImpl = fetch, log = () => {} } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const tar = path.join(cacheDir, pin.filename)
  if (!fs.existsSync(tar) || sha256File(tar) !== pin.sha256) {
    const urls = [pin.url, pin.fallbackUrl].filter(Boolean)
    let lastErr = ''
    for (const url of urls) {
      log(`下载 Node ${pin.version} linux-x64 ← ${url}`)
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) })
        if (!res.ok) {
          lastErr = `HTTP ${res.status}`
          continue
        }
        fs.writeFileSync(tar, Buffer.from(await res.arrayBuffer()))
        break
      } catch (err) {
        lastErr = err.cause?.message ?? err.message
      }
    }
    if (!fs.existsSync(tar)) throw new Error(`下载 Node linux-x64 失败：${lastErr}。可手动放到 ${tar}`)
    const got = sha256File(tar)
    if (got !== pin.sha256) {
      fs.unlinkSync(tar)
      throw new Error(`Node linux-x64 SHA256 不匹配：期望 ${pin.sha256}，得到 ${got}`)
    }
  }
  const extracted = path.join(cacheDir, path.basename(pin.filename, '.tar.gz'))
  const nodeBin = path.join(extracted, 'bin', 'node')
  if (!fs.existsSync(nodeBin)) {
    fs.rmSync(extracted, { recursive: true, force: true })
    fs.mkdirSync(extracted, { recursive: true })
    const r = spawnSync('tar', ['-xzf', tar, '-C', extracted, '--strip-components', '1'], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`解压 ${tar} 失败（退出码 ${r.status}）`)
    if (!fs.existsSync(nodeBin)) throw new Error(`解压后没有 ${nodeBin}`)
  }
  return extracted
}

export function copyLinuxRuntime(extracted, destRuntime) {
  const nodeSrc = path.join(extracted, 'bin', 'node')
  const npmSrc = path.join(extracted, 'lib', 'node_modules', 'npm')
  if (!fs.existsSync(nodeSrc)) throw new Error(`Linux runtime 缺少 ${nodeSrc}`)
  fs.mkdirSync(path.join(destRuntime, 'bin'), { recursive: true })
  fs.copyFileSync(nodeSrc, path.join(destRuntime, 'bin', 'node'))
  if (fs.existsSync(npmSrc)) {
    fs.cpSync(npmSrc, path.join(destRuntime, 'lib', 'node_modules', 'npm'), { recursive: true })
  }
}

export function writeLinuxReadme(stage, { version, nodeVersion }) {
  const text = [
    `valimart harness 公司网关 ${version}（Linux x64）`,
    '',
    '安装（需要 root + systemd）：',
    '  tar -xzf valimart-harness-Gateway-linux-x64-*.tar.gz',
    '  cd valimart-harness-gateway',
    '  sudo sh install.sh',
    '',
    '默认路径：',
    '  程序  /opt/valimart-harness-gateway',
    '  数据  /var/lib/valimart-harness-gateway/data',
    '  日志  /var/log/valimart-harness-gateway',
    '  服务  TheDivaGateway（systemctl start|stop|restart|status TheDivaGateway）',
    '',
    '覆盖安装路径：DEST=/opt/foo STATE=/var/lib/foo LOGS=/var/log/foo sudo -E sh install.sh',
    '配置：<安装目录>/server/config.local.json（host / port / publicUrl / dataDir / company / quota …，改完 systemctl restart TheDivaGateway；升级不覆盖）',
    '升级：解压新包后再次 sudo sh install.sh（config.local.json 与数据目录保留）',
    '卸载：sudo systemctl disable --now TheDivaGateway；删 /etc/systemd/system/TheDivaGateway.service 与安装目录；数据目录默认保留。',
    '管理页：http://<主机名>:8790/admin（首次打开引导设置公司名与初始管理员）',
    '首次启动不播种账号或示例文件。防火墙请自行放行 TCP 8790（或只让反代访问）。',
    '',
    `运行时：Node ${nodeVersion} linux-x64`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(stage, 'README.txt'), text)
}

export function packGatewayLinuxTarball(stage, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  if (fs.existsSync(outFile)) fs.unlinkSync(outFile)
  const r = spawnSync('tar', ['-czf', outFile, '-C', path.dirname(stage), path.basename(stage)], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`打包 tar.gz 失败（退出码 ${r.status}）`)
  if (!fs.existsSync(outFile)) throw new Error(`没找到产物 ${outFile}`)
  return outFile
}

export async function buildGatewayLinux({
  repoRoot,
  pins,
  stage = path.join(repoRoot, 'build', 'valimart-harness-gateway'),
  cache = path.join(repoRoot, 'build', 'cache'),
  dist = path.join(repoRoot, 'dist'),
  fetchImpl = fetch,
  extractedRuntime,
  log = console.log,
} = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const pin = pins.nodeLinuxX64
  fs.rmSync(stage, { recursive: true, force: true })
  fs.mkdirSync(path.join(stage, 'service'), { recursive: true })
  stageGatewayApp(repoRoot, stage, { version, die: (m) => { throw new Error(m) } })
  const extracted = extractedRuntime || (await ensureNodeLinuxX64(cache, pin, { fetchImpl, log }))
  copyLinuxRuntime(extracted, path.join(stage, 'runtime'))
  fs.copyFileSync(path.join(repoRoot, 'installer', 'gateway', 'init-linux.mjs'), path.join(stage, 'service', 'init-linux.mjs'))
  fs.copyFileSync(path.join(repoRoot, 'installer', 'gateway', 'TheDivaGateway.service.tpl'), path.join(stage, 'service', 'TheDivaGateway.service.tpl'))
  fs.copyFileSync(path.join(repoRoot, 'installer', 'gateway', 'install.sh'), path.join(stage, 'install.sh'))
  writeLinuxReadme(stage, { version, nodeVersion: `v${pin.version}` })
  assertGatewayStageClean(stage)
  const outFile = path.join(dist, `valimart-harness-Gateway-linux-x64-${version}.tar.gz`)
  packGatewayLinuxTarball(stage, outFile)
  return { version, stage, outFile, size: fs.statSync(outFile).size }
}
