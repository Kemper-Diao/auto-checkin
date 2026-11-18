# GLaDOS-Auto-Checkin

## 功能描述

使用 Node.js 和 Playwright 浏览器完成 GLaDOS 签到。只需配置登录 Cookie `GLADOS`，请求体在每次运行时生成：

## GitHub Actions 使用步骤

1. Fork 仓库。
2. 登录 GLaDOS，复制该站点请求的 Cookie 请求头值。
3. 在仓库 Actions Secrets 中配置 `GLADOS`。不需要配置请求体、nonce、proof 或 Turnstile token。
4. 启用 Actions。工作流会安装 Chromium 及运行依赖，每天北京时间 01:10 运行，也可以手动触发。GitHub 调度可能延迟。

GitHub Actions 使用无界面浏览器获取 challenge 和发送签到请求。脚本不再获取或等待 Turnstile 验证结果，请求体不包含 `turnstile` 和对应的 `tsState` 字段，仅保留 `token`、`nonce`、`proof`。如果服务端要求验证而拒绝请求，脚本会输出实际错误并退出。

## 优惠码

JY666（结账时使用可享受 9 折优惠（支付宝））
