# مركز المهندس الشامل — صفر مكتبات خارجية
FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/server.js"]
