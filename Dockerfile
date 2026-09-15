FROM node:24.20.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY migrations ./migrations
COPY data ./data
RUN npm run build
USER node
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["npm","run","start"]
