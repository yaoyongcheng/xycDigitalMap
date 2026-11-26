# 工地数字地图 —— 多阶段镜像
#
# 三个阶段各自是一个可独立运行的 target：
#   builder  仅构建用（npm ci + npm run build），不进最终镜像
#   web      nginx：托管 dist 静态文件 + 两段 POST 反代 + /mqtt 转发
#   bridge   Node：直连 broker 1883 并对外提供 WebSocket（/mqtt 的真正上游）
#
# 为什么 web 和 bridge 必须是两个容器：
#   /crane-api、/iot-api 只是普通 HTTP 反代，nginx 能做；
#   但 /mqtt 不是「转发到某个 WebSocket 服务」——现场没有可用的 WS 上游
#   （厂商网关 :8084 自 2026-11-12 起 502/404），是 Node 进程自己用 TCP 连
#   1883、再把这条长连接包装成 WebSocket。nginx 做不了这件事。
#
# 构建上下文注意：.env 若存在会被带进 builder（现场地址靠 VITE_* 在构建期写入）。

# ============================================================
# 1) 构建
#    用 bookworm-slim（glibc）而不是 alpine：vite 8 的 rolldown 原生 binding
#    走预编译 .node，glibc 版本最稳；构建阶段镜像大小不进最终产物。
# ============================================================
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# ci 需要 devDependencies（vite / vue-tsc 都在里面），不能加 --omit=dev
ENV npm_config_fund=false \
    npm_config_audit=false

COPY package.json package-lock.json ./
RUN npm ci

# 全量拷入（node_modules / dist / legacy 等由 .dockerignore 排除）
COPY . .

# package.json 的 build = vue-tsc --noEmit && vite build，类型不过就构建失败，
# 这是有意保留的保护：不让类型错误进镜像。
RUN npm run build

# ============================================================
# 2) web：nginx
# ============================================================
FROM nginx:1.27-alpine AS web

# 站点配置（含两段反代、/mqtt 转发、缓存与 no-cache 策略）。
# 放 templates/ 而不是 conf.d/：镜像启动时 20-envsubst-on-templates.sh 会把
# 里面的 ${CRANE_UPSTREAM} 等占位符换成环境变量值，渲染到 conf.d/default.conf。
# 这样发布者只改 .env / compose 的 environment，不用碰 nginx 语法、也不用重新构建。
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

# dist 内容放到 base 对应的子目录：/usr/share/nginx/html/xycMobileDigitalMap/
# 与 vite.config.ts 的 base 必须逐字符一致，否则整站 404。
COPY --from=builder /app/dist/ /usr/share/nginx/html/xycMobileDigitalMap/

EXPOSE 80

# busybox wget，够了（镜像里没有 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/xycMobileDigitalMap/ || exit 1

# ============================================================
# 3) bridge：/mqtt 的 Node 实现（同时也能独立托管静态，作单容器兜底）
# ============================================================
FROM node:22-alpine AS bridge

WORKDIR /app

ENV NODE_ENV=production \
    TZ=Asia/Shanghai

# server/ 两个文件零第三方依赖，不需要 npm install
COPY server/ ./server/

# serve.mjs 启动时会校验 <dir>/index.html 存在（缺了直接 exit 1），
# 所以这里也带一份 dist。它顺带能托管静态，单跑这一个容器也是完整可用的。
COPY --from=builder /app/dist/ ./dist/

EXPOSE 8080

# --base 默认已与构建前缀一致（/xycMobileDigitalMap/），无需显式传
CMD ["node", "server/serve.mjs", "--port", "8080", "--dir", "/app/dist"]
