FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --production
COPY . .
RUN mkdir -p data static/uploads

EXPOSE 4300

CMD ["node", "server/index.js"]
