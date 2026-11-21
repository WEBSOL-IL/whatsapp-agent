# שלב בנייה: קומפילציה של TypeScript
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# שלב ריצה: רק מה שצריך, משתמש לא-root, בלי פורטים פתוחים
FROM node:22-slim
ENV NODE_ENV=production
# ב-Docker התיקייה הקבועה היא /app, והסשן והנתונים נשמרים ב-volumes
ENV STATE_DIR=/app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -m 700 auth data && chown node:node auth data
USER node
VOLUME ["/app/auth", "/app/data"]
CMD ["node", "dist/index.js"]
