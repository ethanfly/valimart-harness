# 2026-11-09 安装版登录 404/405：安装包漏了 drive-mirror-index

## 现象

同事打开安装版，登录页：

- 本机 Host 不可达：请求失败 404
- 公司网关一栏：请求失败 404
- 点登录：请求失败 405
- 页脚：dev · 内核 dev

账号能填（例如 kongwenhao），网关地址是测试机 `http://192.168.100.71:8790/`。好几个同事一样。今天发到测试机的 anysearch 安装包没有修这个。

## 排除

- 网关 `GET /desk/api/state` 是 JSON `no route`，不是界面上的「请求失败 404」。错密码走 `POST /api/auth/login` 回 JSON「账号或密码错误」。
- 空 body 的 404（GET）和 405（POST）是内核 `dsh-host-frontend-static`：没有命名路由时当静态文件，非 GET/HEAD 直接 405。
- 本机开发 profile `desk` 的 `/desk/api/state` 是 200。开发版插件符号链接到仓库。

## 根因

按安装版布局另起一份 `desk-app`（插件和脚本从仓库拷到独立目录，profile 链到这份拷贝）。内核日志：

`desk-host (@company-desk/desk-host): failed to import: Cannot find module <app>/scripts/lib/drive-mirror-index.mjs imported from <app>/plugins/desk-host/lib/drive-mirror.js`

内核继续启动，登录页还在。`GET /desk/api/state` 空 404。

`drive-mirror.js` 第 8 行静态 import 这个文件（11-03 把同步索引抽到 `scripts/lib/drive-mirror-index.mjs`）。`build-payload.mjs` 的脚本白名单有 lan-protocol / git-head / model-input / client-update，没有它。11-06 和 11-09 的安装包都缺。

## 修法

`scripts/lib/payload.mjs` 的 `CLIENT_PAYLOAD_SCRIPTS` 是安装包要拷的脚本清单，补上 `drive-mirror-index.mjs`。`build-payload.mjs` 按这份清单拷，并把该文件算进 buildId。

`scripts/test/payload.test.mjs` 扫描 `plugins/desk-host` 里所有 `../../../scripts/` import，不在清单里就失败。

## 验证

同一份安装版布局，把文件补进 `<app>/scripts/lib/` 后再起内核：`[desk-host] 已就绪`，`GET /desk/api/state` 200 JSON，`POST /desk/api/login` 回 JSON（连不上网关时是 502 和 message），不再是空 405。

`node --test scripts/test/payload.test.mjs`：7 pass。

还没提交、没发到测试机网关。
