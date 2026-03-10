FROM node:20-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 3000

CMD ["node", "server.mjs"]
