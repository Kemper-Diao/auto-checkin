# GLaDOS-Auto-Checkin

## 功能描述

使用 Node.js 和 Playwright 浏览器完成 GLaDOS 签到。只需配置登录 Cookie `GLADOS`，请求体在每次运行时生成：

## GitHub Actions 使用步骤

1. Fork 仓库。
2. 登录 GLaDOS，复制该站点请求的 Cookie 请求头值。
3. 在仓库 Actions Secrets 中配置 `GLADOS`。不需要配置请求体、nonce、proof 或 Turnstile token。
4. 启用 Actions。工作流会安装 Chromium 及运行依赖，每天北京时间 01:10 运行，也可以手动触发。GitHub 调度可能延迟。

GitHub Actions 使用无界面浏览器。Turnstile 是否通过由 Cloudflare 决定；引入浏览器并不能保证无人值守验证成功。如果要求人工交互或拒绝自动化环境，任务会报错退出，需要在本机浏览器运行并完成验证。脚本不会伪造成功状态或重放旧 token。

## Turnstile 超时排查

脚本最多等待 90 秒获取验证结果（受本次 challenge 剩余有效期限制），静默验证也使用这一上限。超时只说明没有收到成功回调，不能据此断定 Cookie 已失效。Cloudflare 返回错误时，日志会包含其错误码；要求人工交互时，无界面任务会直接给出提示并退出。

需要人工验证时，在本机安装 Node.js 和 Chrome，执行 `npm ci`，在当前终端设置 `GLADOS` 环境变量，然后运行：

```sh
node main.js --headed --channel=chrome
```

在弹出的 Chrome 窗口中完成验证，脚本会继续提交本次签到。该操作仅完成本机这次运行的验证，不能保证后续 GitHub Actions 自动通过。请勿将 Cookie 或验证 token 写入日志或提交到仓库。

## 优惠码

JY666（结账时使用可享受 9 折优惠（支付宝））
