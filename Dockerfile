# Node.js + TypeScript Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
#RUN npm run build
ARG PORT=17107
EXPOSE $PORT
CMD ["node", "dist/index.js"]
