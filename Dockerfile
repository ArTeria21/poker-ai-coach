# Build the static app
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve the app + coach API; the server runs TypeScript through tsx and imports src/
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
ENV PORT=80 HOST=0.0.0.0
EXPOSE 80
# Pass OPENROUTER_API_KEY and OPENROUTER_MODEL at run time (docker run -e ...).
CMD ["node", "--import", "tsx", "server/index.ts"]
