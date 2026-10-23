# Tesla Dash — 云端部署镜像
# 私钥与 token 全部通过环境变量注入，不打包进镜像
FROM node:24-alpine

WORKDIR /app

COPY server.mjs db.mjs recorder.mjs ./
COPY public ./public

# 两个架构的签名工具都带上，启动时按 uname -m 选择
COPY bin/ /app/bin/
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod +x /app/docker-entrypoint.sh \
 && mkdir -p /app/data /app/keys

ENV DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=8787 \
    ALLOW_COMMANDS=1

EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/.well-known/appspecific/com.tesla.3p.public-key.pem').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
