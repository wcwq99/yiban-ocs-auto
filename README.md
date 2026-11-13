# 易班考试答题助手

易班（yooc.me）考试页面的油猴脚本。按你配置的**自定义题库**逐题查询答案并自动作答，支持多题库按顺序尝试、答题日志、回顾页显示正确答案。

> 脚本不内置任何题库，也没有卡密授权，题库需要自己配置。
>
> **可选择自搭建 OCS 题库：<https://github.com/wcwq99/ocsjs-ai-answer-service>**

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击安装脚本：[yiban-ocs-auto.user.js](https://raw.githubusercontent.com/wcwq99/yiban-ocs-auto/main/yiban-ocs-auto.user.js)
3. 登录易班后打开考试页面，左侧会出现「考试助手」面板。

脚本头部已配置 `@updateURL`，Tampermonkey 会自动检查更新。

## 使用

| 按钮 | 作用 |
|---|---|
| **开始自动答题** | 进入或刷新页面时默认不启动，需手动点击。运行中按钮点亮，再次点击即停止（会立即中断正在等待的题库请求） |
| **强制看题** | 在考试结果页跳转到回顾页；在回顾页用题库补全每题的正确答案 |
| **题库设置** | 配置自定义题库，可一键测试每个题库是否可用 |
| **答题日志** | 查看每道题的题目、选项、题库答案及来源、实际填写内容；可复制全部或清空（最多保留 300 条） |
| 未命中随机作答 | 勾选后，题库查不到答案的选择题会随机作答，请自行核对 |

自动答题从当前题开始往后处理，答完停在最后一题，**不会自动交卷**，请检查后手动提交。连续 3 题未能使用题库答案会自动停止。

## 配置题库

打开「题库设置」，粘贴 JSON 数组，多个题库按顺序尝试、命中即停：

```json
[
  {
    "name": "AI智能题库",
    "url": "http://<YOUR_HOST>:5999/api/search?api_key=<YOUR_API_KEY>",
    "method": "post",
    "contentType": "json",
    "data": {
      "title": "${title}",
      "type": "${type}",
      "options": "${options}"
    },
    "handler": "return (res)=> res.code === 1 && res.answer ? [res.question, res.answer] : undefined"
  }
]
```

上面的配置可直接对接 [ocsjs-ai-answer-service](https://github.com/wcwq99/ocsjs-ai-answer-service)，把地址和 key 换成你自己的即可。OCS 格式的题库配置也可以直接粘贴（多余的 `type` 等字段会被忽略）。

| 字段 | 说明 |
|---|---|
| `name` | 题库名称，显示在日志和状态里 |
| `url` | 接口地址，http / https 均可，也可使用占位符 |
| `method` | `get` 或 `post`，默认 `post` |
| `contentType` | `json` 或 `form`，默认 `json` |
| `data` | 请求体，可用占位符 `${title}` 题目、`${type}` 题型、`${options}` 选项 |
| `handler` | 可选，解析响应的函数源码，返回 `[题目, 答案]` 即命中，返回 `undefined` 视为未命中；支持 async。不填时默认读取响应的 `code`（需为 1）和 `answer` 字段 |
| `timeout` | 可选，超时毫秒，默认 25000 |
| `enabled` | 可选，设为 `false` 临时停用 |

多个答案用 `#` 分隔（如 `A#C` 或 `北京#上海`），选择题也支持直接返回 `AB`、`A,B` 这类选项字母。

配置好后点「测试题库」，会用一道示例题逐个请求并显示结果。

## 注意

- **`handler` 是一段 JavaScript，会以脚本权限运行**，可以读取你的易班登录信息并向外发送请求。只粘贴你信任来源的配置，脚本在遇到新 handler 时会弹窗确认。
- 首次请求新的题库域名时，Tampermonkey 可能弹窗询问跨域权限，请选「总是允许」，否则会报“网络请求失败”。
- 题干含图片或公式的题目不会发送给题库。
- 旧版本在设置里保存过的 OCS 接口，升级后会自动迁移为一条名为「OCS（旧版设置迁移）」的自定义题库。

## 免责声明

本项目仅供学习与研究使用，题库答案（尤其是 AI 生成的答案）不保证准确。请遵守所在学校与平台的规定，使用产生的一切后果由使用者自行承担。
