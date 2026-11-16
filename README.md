# GLaDOS-Auto-Checkin

## 功能描述

使用 Node.js 和 Playwright 浏览器完成 GLaDOS 签到。只需配置登录 Cookie `GLADOS`，请求体在每次运行时生成：

## GitHub Actions 使用步骤

1. Fork 仓库。
2. 登录 GLaDOS，复制该站点请求的 Cookie 请求头值。
3. 在仓库 Actions Secrets 中配置 `GLADOS`。不需要配置请求体、nonce、proof 或 Turnstile token。
4. 启用 Actions。工作流会安装 Chromium 及运行依赖，每天北京时间 01:10 运行，也可以手动触发。GitHub 调度可能延迟。

GitHub Actions 使用无界面浏览器。Turnstile 是否通过由 Cloudflare 决定；引入浏览器并不能保证无人值守验证成功。如果要求人工交互或拒绝自动化环境，任务会报错退出，需要在本机浏览器运行并完成验证。脚本不会伪造成功状态或重放旧 token。

## 优惠码

JY666（结账时使用可享受 9 折优惠（支付宝））
