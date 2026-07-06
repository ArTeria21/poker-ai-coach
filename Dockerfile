# Build the static app
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Serve app + sync API with the zero-dependency Node server
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.js ./
ENV DATA_DIR=/data
EXPOSE 80
CMD ["node", "server.js"]
