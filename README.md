# 墨水屏漫画阅读器 (eink_manga_js)

一个本地运行的漫画阅读代理，把漫画网站的章节页转换成适合墨水屏阅读的纯翻页界面。零依赖，仅需 Node.js 18+，全部代码就一个 `app.js`。

## 快速开始（电脑）

```bash
node app.js          # 默认 8000 端口，被占用自动 +1
node app.js 9000     # 指定起始端口
```

浏览器访问 http://localhost:8000 ，粘贴漫画章节网址即可阅读。

在墨水屏设备上直接运行本项目的方法见下一节。

## 在墨水屏设备上运行（以墨案 Inkpad X 为例）

整体思路：设备上安装 **Termux**（终端模拟器）→ 里面装 **Node.js** → 跑本项目 → 用 **Firefox / Fennec** 浏览器打开 `http://localhost:8000` 阅读。服务、浏览器、阅读全在同一台设备上完成。

以**墨案 Inkpad X**（Android 8.1 开放系统，全志 B300 四核 Cortex-A7，2GB 内存）为例：

> **关键前提**：Inkpad X 的 CPU 是 **32 位 ARM**（armeabi-v7a），所以所有 APK 都只能安装 **32 位版本**。下载到 arm64-v8a / x86 版本时会提示"软件包无效/无法安装"或直接闪退，请认准 armeabi-v7a（或包含它的通用 multi-abi 包）。

### 第 1 步：安装 Termux

设备自带应用商店一般搜不到 Termux，需要侧载 APK：先在系统设置里允许"安装未知来源应用"，然后从以下任一渠道下载安装：

- F-Droid：<https://f-droid.org/packages/com.termux/>
- GitHub Releases：<https://github.com/termux/termux-app/releases>

**不要用 Google Play 上的版本**（多年前已停止更新）。以上渠道的 APK 是包含 32 位架构的通用包，可直接安装；Inkpad X 的 Android 8.1 也满足新版 Termux 的系统要求（Android 7+）。顺手装个 F-Droid 客户端的话，后面装浏览器也方便。

### 第 2 步：在 Termux 中安装 Node.js

打开 Termux，执行：

```bash
pkg update -y
pkg install nodejs-lts -y
node -v                # 显示 v18 以上即可满足本项目要求
```

国内网络慢时，先执行 `termux-change-repo` 选清华 TUNA 等国内镜像源，再 `pkg update`。

### 第 3 步：把项目放进设备

本项目只有一个文件 `app.js`，怎么传都行：

```bash
# 方式一：电脑上下载 app.js 拷到设备，再复制进 Termux
termux-setup-storage                          # 授权访问设备存储（只需一次）
mkdir -p ~/manga && cp /sdcard/Download/app.js ~/manga/

# 方式二：设备能联网时直接 git
pkg install git -y
git clone <本项目仓库地址> ~/manga
```

### 第 4 步：启动

```bash
cd ~/manga
termux-wake-lock      # 可选：防止息屏后 Termux 被系统杀后台
node app.js
```

看到 `墨水屏漫画阅读器已启动: http://localhost:8000` 即成功。停止服务按 **音量下 + C**（Termux 里等效 Ctrl+C）。触屏敲命令慢的话，配个蓝牙键盘，或把这行命令存成便签复制粘贴。

### 第 5 步：安装 Firefox / Fennec 浏览器

阅读页建议用 **Firefox** 或 **Fennec F-Droid**（Firefox 的 F-Droid 构建）打开：

- Firefox 官网：<https://www.mozilla.org/firefox/android/>
- Fennec F-Droid：<https://f-droid.org/en/packages/org.mozilla.fennec_fdroid/>

两者自带 Gecko 渲染引擎，**不依赖设备里老旧且难以升级的系统 WebView**，在墨水屏整页刷新模式下表现更稳定。同样注意选 **32 位（armeabi-v7a）** 版本。

### 第 6 步：开读

Firefox 地址栏输入 `http://localhost:8000`（或 `http://127.0.0.1:8000`），粘贴漫画章节网址即可。建议加到书签。

之后的日常使用：打开 Termux → `cd ~/manga && node app.js`（可先 `termux-wake-lock`）→ 切到 Firefox 打开书签。阅读进度、滤镜等设置都存在浏览器 LocalStorage，仅本机可见。

## 功能

### 解析
- 自动提取章节页中的漫画图片：优先识别 JS 循环拼接的图片列表（`var pasd="..."; for(i=1;i<=num;i++) pasd+i+'.webp'` 这类动态站点），其次按 URL 形状聚类静态 `<img>`/`<amp-img>`/`data-src`，取最大的一组并按页码排序
- **Gatekeeper PoW 门禁自动通过**（bzmg 系站点）：站点首次访问返回 403 挑战，服务端本地复算等价的 SHA-256 前导零工作量证明（纯哈希、不执行远端 JS），换取放行 Cookie 后重放请求；Cookie 按站点缓存复用，过期自动重新挑战；图片地址 `<img src>` 与 `<amp-img data-src>` 均可提取，历史记录按收藏链接中的 `comic_id` 聚合
- **dm5（动漫屋）专用适配**：章节页没有静态图片，服务端用页面内的 `DM5_VIEWSIGN` 签名并发请求 `chapterfun.ashx` 拿到打包 JS，本地解包（Dean Edwards packer，纯字符串替换、不执行远端代码）重建出全部图片 URL；自动跨分页去重、签名过期自动刷新重试；粘贴 `-p2`/`-end` 等子页地址会自动归一到章首；上一章/下一章排除章内翻页与结尾页；历史记录按漫画 ID（`DM5_MID`）聚合
- 识别"上一章/下一章"链接（匹配 上一章/下一话/prev/next 等关键词及 rel 属性）
- 图片经本地代理转发（自动携带 Referer 绕过防盗链）

### 阅读（墨水屏友好）
- **只翻页不滚动**（`overflow:hidden`，整页刷新）
- 左 1/3 点击上一页、右 1/3 下一页、中间呼出/收起工具栏（不自动收起）；键盘 ←/→/空格/PageUp/PageDown/Home/End
- 图片等比缩放（`object-fit:contain` + 强制放大），一个方向撑满、整图可见、不变形
- 一键旋转 90°（竖屏看横幅漫画，旋转后仍居中撑满，`R` 键切换）
- 底部滑动条快速跳页，显示"当前页/总页数"
- **操作即时反馈**（慢网络下不再"点了没反应"）：翻页时底部短暂弹出页码提示（图片未预载好时显示"加载中"，到图后转为页码）；到达首/末页时提示"已是第一页/最后一页"；点击上一章/下一章后链接立刻变为"加载中…"并居中提示，同时拦截导航完成前的重复点击
- 预加载接下来 3 张，右下角图标实时显示加载状态：`○`加载中 `●`已完成 `✕`失败 `·`无更多
- 夜间模式：页面背景纯黑、文字反白，图片不反色
- **图片滤镜**：顶栏"滤镜"面板调节图片亮度/对比度（0%–300%，默认 100%；面板与屏幕同宽、滑杆占满整行，调节精细），拖动实时预览，CSS filter 实现、兼容 `-webkit-` 前缀老内核，全局保存、重开自动恢复；一键"重置"还原；非默认值时"滤镜"按钮带 `*` 标记；再点"滤镜"或点屏幕中间区域关闭
- 全屏切换（按钮或 `F` 键，兼容老 WebKit 内核）

### 记录（LocalStorage，仅本地）
- `eink_pos`：按章节 URL 记录阅读进度，重开自动恢复到上次页码
- `eink_cfg`：全局配置（旋转/夜间/滤镜亮度与对比度）
- `eink_hist`：首页历史记录——同一部漫画只保留一条（章节 URL 末段数字归一为系列键），始终显示当前阅读的章节与进度，点击跳转并恢复进度；上限 50 条，可一键清空

## 项目结构

```
app.js   全部代码（Node http 服务 + HTML/CSS/JS 模板内联）
```

| 路由 | 作用 |
|---|---|
| `/` | 首页：输入网址 + 历史记录 |
| `/read?url=` | 抓取并解析章节，返回阅读页 |
| `/img?u=&ref=` | 图片代理（带 Referer） |

## 已知限制

- 服务只监听 `127.0.0.1`，仅限运行本服务的设备上的浏览器访问；如需局域网内其他设备访问，可自行修改 `app.js` 中 `server.listen` 的绑定地址
- 除 dm5 专用适配外不执行页面 JavaScript，仅静态分析 HTML；图片完全由前端脚本加密生成（非简单循环拼接）的其他站点无法解析
- 需要登录/付费的站点暂不支持（dm5 的 VIP 章节需要 `dm5_key`，同样不支持）
